// The console BFF and the operations Lambdas around the worlds (docs/architecture.md §4, §10-§14,
// docs/architecture-guests.md §4-§6 and §12, ADR-0009, ADR-0017, docs/build-plan.md WP-37).
//
//   Bff            tRPC v11 behind the Router at `/api` (packages/bff/src/routers/handler.ts): the console,
//                  the public sign-up and recovery (`/api/public/*`) and the phone simulator. Timeout 20 s
//                  and 1,024 MB DECLARED, below CloudFront's 30 s origin timeout; reserved concurrency 10
//                  (infra/web-spec.ts EDGE_BUDGETS). Its Function URL has no IAM auth (OAC would clobber the
//                  console's Bearer token; the CI boundary allows a public URL only on `…-BffFunction-*`):
//                  the handler refuses any request without the Router's `x-reclamo-edge` (EdgeOriginKey).
//                  Never builds or wipes a world in line: it writes the ticket and invokes WorldJanitor
//                  asynchronously. Never sends: it enqueues on the three customer queues (the QA one for the
//                  browser scenarios of `qa-*` worlds) and invokes InboundWhatsApp for the simulator.
//   WorldJanitor   the long work of the worlds (timeout 900 s, 1,024 MB): creations of self-signup worlds,
//                  resets, expiries and Memory purges, each with its ticket (`PROVISIONREQ#`, `RESETREQ#`,
//                  `PURGEREQ#`), continued by invoking ITSELF (fixed function name, so its own ARN is known
//                  without a cycle), plus three schedules: the provisioning pass every 5 minutes, the
//                  hourly pass and the nightly one at 04:00 ART (worlds/passes.ts). The post-confirmation
//                  trigger invokes it by that name (infra/world-janitor-link.ts), never by this component.
//   PolicyAudit    daily at 03:00 ART (before the nightly resets) and on demand by the QaDriver; reads the
//                  core mock (getCustomer only) under a fixed role, as every mock caller does.
//   BudgetBreaker  subscribed to `<app>-budget-alerts` (infra/observability.ts: KILL#AGENT and KILL#SIGNUP)
//                  and to `<app>-auth-mail-alerts` (infra/leads.ts reads `budgetBreaker`: KILL#SIGNUP only).
//   QaDriver       `<app>-<stage>-qa-driver`, function and role of fixed name, NO URL, invoked only by the
//                  bootstrap's `qa-runner` role; runs the real appRouter fenced to `qa-*`, `qamin`, `sim-*`
//                  (and reads `gprobe`); no EmailEvents, no SimEnvelopeKey, no direct mock invocation.
//
// Least privilege (infra/iam-capabilities.ts, docs/architecture.md §14): tables by the leading keys of
// WORLD_LEADING_KEYS (`dataPlan`; Bff and QaDriver in a managed policy); objects and `s3:ListBucket` only
// under each role's world roots (OBJECT_ROOTS, §6); `Leads` only by LEADS_GRANTS; every invoked Function
// by linking it; Cognito on this pool only; TIMERS of WorldJanitor on `tm-*`, of the QaDriver on `tm-qa-*`.
//
// Verify (reads only):
//   aws --profile craftech-demos lambda get-function-configuration --function-name <Bff name> --query '[Timeout,MemorySize]'  → [20, 1024]
//   aws --profile craftech-demos lambda get-function-configuration --function-name aws-cds-hackathon-poc-reclamo-poc-world-janitor --query '[Timeout,MemorySize]' → [900, 1024]
//   aws --profile craftech-demos lambda get-policy --function-name aws-cds-hackathon-poc-reclamo-poc-qa-driver → only the qa-runner role
//   aws --profile craftech-demos lambda get-function-url-config --function-name aws-cds-hackathon-poc-reclamo-poc-qa-driver → ResourceNotFoundException
//   aws --profile craftech-demos events list-rule-names-by-target --target-arn <WorldJanitor ARN>  → the three passes

import { Agent } from "./agentcore";
import { ReceiptReader } from "./agentcore-iam";
import { auth, guestSignup, userPool } from "./auth";
import { ChannelModes } from "./channel-modes";
import { CI_IAM_PATH, qaRunnerRoleArn } from "./ci";
import { GuardrailG1, GuardrailG2 } from "./guardrail";
import { CAPABILITIES, LAMBDA_CAPABILITIES, WORLD_LEADING_KEYS, type BucketName, type LambdaCapabilities, type LambdaName, type TableName } from "./iam-capabilities";
import { lateLinks, links } from "./late-links";
import { leadNotice, leadNotifier, leadsPermissions, sendLeadNoticeProbe } from "./leads";
import { MalwarePlan, malwarePlan } from "./malware";
import { inboundWhatsApp } from "./messaging-whatsapp";
import { fixedRole, functionData, grantMockInvoke } from "./mocks";
import { QA_DLQ_ALARM_LINK } from "./observability-spec";
import { Scheduler, schedulerFencedTo } from "./scheduler";
import { anchorAccess, buckets, tables, tablesAccess, type StoragePermission } from "./storage";
import { BUCKET_ACTIONS } from "./storage-keys";
import { router } from "./web";
import { EDGE_BUDGETS, LAMBDA_ROUTES } from "./web-spec";
import { CustomerEvents, QaCustomerEvents, QaCustomerEventsDlq, SignupCustomerEvents, anchorWriter, scheduleDispatch } from "./workers";
import { dataPlan, groupTableGrants } from "./workers-spec";
import { worldJanitorArn, worldJanitorName } from "./world-janitor-link";

export { worldJanitorFunctionName } from "./world-janitor-link";

/** Lambda entries; each file belongs to the WP that writes its code (docs/build-plan.md §2). */
export const BFF_HANDLERS = {
  Bff: "packages/bff/src/routers/handler.handler", // WP-35, WP-36, WP-54
  WorldJanitor: "packages/bff/src/handlers/world-janitor.handler", // WP-34
  PolicyAudit: "packages/bff/src/handlers/policy-audit.handler", // WP-38
  BudgetBreaker: "packages/bff/src/handlers/budget-breaker.handler", // WP-38
  QaDriver: "packages/bff/src/handlers/qa-driver.handler", // WP-40 (stub until then)
} as const satisfies Partial<Record<LambdaName, string>>;

export type OperationsLambda = Exclude<keyof typeof BFF_HANDLERS, "Bff">;

/** Declared, never SST's implicit defaults. The Bff's budget is EDGE_BUDGETS.bff (infra/web-spec.ts). */
export const FUNCTION_BUDGETS: Readonly<Record<OperationsLambda, { readonly timeoutSeconds: number; readonly memoryMb: number }>> = {
  // A reset or a template build writes thousands of items; it continues itself before the timeout.
  WorldJanitor: { timeoutSeconds: 900, memoryMb: 1_024 },
  // Every sent message of every operated world, re-evaluated with the chains against their anchors.
  PolicyAudit: { timeoutSeconds: 900, memoryMb: 512 },
  BudgetBreaker: { timeoutSeconds: 30, memoryMb: 256 },
  // A scenario step drives the world and waits for it to settle.
  QaDriver: { timeoutSeconds: 900, memoryMb: 1_024 },
};

/** Fixed name (docs/architecture.md §1): `qa-runner` is fenced to the QaDriver. */
export function qaDriverFunctionName(app: string, stage: string): string {
  return `${app}-${stage}-qa-driver`;
}

/** EventBridge schedules: constant inputs the handlers validate with zod (worlds/janitor.ts, policy-audit/run.ts). */
export const SCHEDULES = {
  WorldJanitorProvision: { target: "WorldJanitor", schedule: "rate(5 minutes)", event: { kind: "PROVISION_PASS" } },
  WorldJanitorHourly: { target: "WorldJanitor", schedule: "rate(1 hour)", event: { kind: "HOURLY_PASS" } },
  WorldJanitorNightly: { target: "WorldJanitor", schedule: "cron(0 7 * * ? *)", event: { kind: "NIGHTLY_PASS" } }, // 04:00 ART (UTC−3 all year)
  PolicyAuditDaily: { target: "PolicyAudit", schedule: "cron(0 6 * * ? *)", event: { kind: "DAILY" } }, // 03:00 ART, before the nightly resets
} as const satisfies Record<string, { target: "WorldJanitor" | "PolicyAudit"; schedule: `rate(${string})` | `cron(${string})`; event: { kind: string } }>;

/**
 * Objects of each world-fenced role (docs/architecture.md §6 and §14): `W/<worldId>/` for demo, gNN,
 * gtest, gs-*, gprobe and sim-*; `qa/<runId>/<worldId>/` for qa-* and `qa/qamin/` for qamin; the same
 * worlds as its leading keys (WORLD_LEADING_KEYS). `own` at the access of its capabilities, `read` only
 * read; `access` narrows a bucket below what WORLDS grants (the Bff builds no world: §14 gives it GET of
 * Media, Documents and Emails and writes only its exports and the simulator's uploads); `extra` adds a
 * bucket's own prefix. `Seed` holds templates, not worlds, and is read whole.
 */
export const OBJECT_ROOTS = {
  Bff: {
    own: ["W/demo/", "W/g??/", "W/gtest/", "W/gs-", "qa/*/qa-"],
    read: [],
    access: { Media: "read", Documents: "read", Emails: "read", Settlements: "none", Exports: "write" },
    // The simulator's uploads (presigned POST; a QA world's under its root) and the live media of `demo`.
    extra: { Media: { write: ["up/", "qa/*/qa-*/up/"], read: ["wa/demo/"] } },
  },
  WorldJanitor: { own: ["W/demo/", "W/g??/", "W/gtest/", "W/gs-", "W/gprobe/", "qa/"], read: [], access: {}, extra: {} },
  QaDriver: { own: ["qa/", "W/sim-"], read: ["W/gprobe/"], access: {}, extra: {} },
} as const satisfies Record<string, ObjectRoots>;

interface ObjectRoots {
  readonly own: readonly string[];
  readonly read: readonly string[];
  readonly access: Partial<Record<BucketName, ObjectAccess | "none">>;
  readonly extra: Partial<Record<BucketName, Partial<Record<ObjectAccess, readonly string[]>>>>;
}

type ObjectAccess = "read" | "write";
export type WorldsHolder = keyof typeof OBJECT_ROOTS;

/**
 * What WORLDS would grant the Bff and it never uses: it builds, wipes and purges no world (§11), so no
 * table of the core or the networks (it calls their URLs), no MEMORY_ADMIN and no `s3:ListBucket` (it
 * presigns single keys). Leaving them out keeps its inline policy under IAM's 10,240 characters.
 */
export const NARROWED = {
  Bff: { tables: ["Core", "Networks"], actions: [...CAPABILITIES.MEMORY_ADMIN.actions, "s3:ListBucket"] },
} as const satisfies Partial<Record<string, { tables: readonly TableName[]; actions: readonly string[] }>>;

const narrowed = (fn: WorldsHolder) => (fn === "Bff" ? NARROWED.Bff : { tables: [] as readonly TableName[], actions: [] as readonly string[] });

/** Object grants of a role: (bucket, access, prefixes), from its capabilities and OBJECT_ROOTS. */
export function objectGrants(fn: WorldsHolder): Array<{ readonly bucket: BucketName; readonly access: ObjectAccess; readonly prefixes: readonly string[] }> {
  const roots: ObjectRoots = OBJECT_ROOTS[fn];
  return dataPlan(fn).buckets.flatMap((grant) => {
    if (grant.bucket === "Seed") return [{ bucket: grant.bucket, access: grant.access, prefixes: [""] }];
    const access = roots.access[grant.bucket] ?? grant.access;
    const extra = Object.entries(roots.extra[grant.bucket] ?? {}) as Array<[ObjectAccess, readonly string[]]>;
    return [
      ...(access === "none" ? [] : [{ bucket: grant.bucket, access, prefixes: roots.own }]),
      ...(roots.read.length > 0 && access !== "none" ? [{ bucket: grant.bucket, access: "read" as const, prefixes: roots.read }] : []),
      ...extra.map(([level, prefixes]) => ({ bucket: grant.bucket, access: level, prefixes })),
    ];
  });
}

/** One statement per access level and set of prefixes, across buckets (the role's inline policy stays small). */
function objectStatements(fn: WorldsHolder): StoragePermission[] {
  const groups = new Map<string, { access: ObjectAccess; prefixes: readonly string[]; buckets: BucketName[] }>();
  for (const grant of objectGrants(fn)) {
    const key = `${grant.access}|${grant.prefixes.join(",")}`;
    const group = groups.get(key);
    if (group) group.buckets.push(grant.bucket);
    else groups.set(key, { access: grant.access, prefixes: grant.prefixes, buckets: [grant.bucket] });
  }
  return [...groups.values()].map((group) => ({
    actions: [...BUCKET_ACTIONS[group.access]],
    resources: group.buckets.flatMap((bucket) => group.prefixes.map((prefix) => buckets[bucket].arn.apply((arn) => `${arn}/${prefix}*`))),
  }));
}

/**
 * Table grants by leading keys. A read grant keeps only the read-only keys where the role also writes
 * the table: its write statement already reads its own keys.
 */
export function tableGrants(fn: WorldsHolder): ReturnType<typeof groupTableGrants> {
  const plan = dataPlan(fn);
  const unused = new Set<TableName>(narrowed(fn).tables);
  const ownKeys = new Set<string>(WORLD_LEADING_KEYS[fn].write);
  const writable = new Set(plan.tables.filter((grant) => grant.access !== "read" && grant.leadingKeys !== undefined).map((grant) => grant.table));
  const grants = plan.tables
    .filter((grant) => !unused.has(grant.table))
    .map((grant) => (grant.access === "read" && grant.leadingKeys !== undefined && writable.has(grant.table) ? { ...grant, leadingKeys: grant.leadingKeys.filter((key) => !ownKeys.has(key)) } : grant));
  return groupTableGrants(grants);
}

const tableStatements = (fn: WorldsHolder): StoragePermission[] => tableGrants(fn).map((group) => tablesAccess(group.tables, group.access, group.leadingKeys));

/** Objects and listing only under the role's prefixes, and the anchors. */
function objectPermissions(fn: WorldsHolder): StoragePermission[] {
  const listed = objectGrants(fn).filter((grant) => grant.bucket !== "Seed");
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  return [
    ...objectStatements(fn),
    ...(narrowed(fn).actions.includes("s3:ListBucket")
      ? []
      : [
          {
            actions: ["s3:ListBucket"],
            resources: [...new Set(listed.map((grant) => grant.bucket))].map((bucket) => buckets[bucket].arn),
            conditions: [{ test: "StringLike", variable: "s3:prefix", values: [...new Set(listed.flatMap((grant) => grant.prefixes))].map((prefix) => `${prefix}*`) }],
          },
        ]),
    ...(entry.anchors === undefined ? [] : anchorAccess(entry.anchors)),
  ];
}

/** A managed policy document (the format `aws.iam.Policy` takes) of resolved statements. */
function policyDocument(statements: StoragePermission[]): $util.Output<string> {
  return $util.output(statements).apply((resolved) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: resolved.map((statement) => {
        const condition: Record<string, Record<string, string[]>> = {};
        for (const { test, variable, values } of statement.conditions ?? []) (condition[test] ??= {})[variable] = [...values];
        return { Effect: "Allow", Action: [...statement.actions], Resource: [...statement.resources], ...(Object.keys(condition).length > 0 ? { Condition: condition } : {}) };
      }),
    }),
  );
}

/** Cognito actions of a role's capabilities, on this stage's pool only. */
function cognitoStatement(actions: readonly string[]): StoragePermission {
  return { actions: actions.filter((action) => action.startsWith("cognito-idp:")), resources: [userPool.arn] };
}

// ---- WorldJanitor --------------------------------------------------------------------------------

const budget = (fn: OperationsLambda) => ({ timeout: `${FUNCTION_BUDGETS[fn].timeoutSeconds} seconds` as const, memory: `${FUNCTION_BUDGETS[fn].memoryMb} MB` as const });

export const worldJanitor = new sst.aws.Function("WorldJanitor", {
  name: worldJanitorName,
  description: "Long work of the worlds: creations, resets, expiries and Memory purges by ticket, and the scheduled passes.",
  handler: BFF_HANDLERS.WorldJanitor,
  ...budget("WorldJanitor"),
  // Its tables, buckets and secrets; the pool (cleanups), TIMERS on `tm-*` (a wipe's schedules), the Memory
  // (purge), AnchorWriter (the template's chains) and Leads' name.
  link: [...functionData("WorldJanitor").links, auth, schedulerFencedTo("tm-"), Agent, anchorWriter, tables.Leads],
  permissions: [
    ...tableStatements("WorldJanitor"),
    ...objectPermissions("WorldJanitor"),
    ...leadsPermissions("WorldJanitor", tables.Leads.arn),
    cognitoStatement(LAMBDA_CAPABILITIES.WorldJanitor.actions),
    // The continuation of a long job: itself only, by the ARN of its fixed name.
    { actions: ["lambda:InvokeFunction"], resources: [worldJanitorArn] },
    // The hourly cleanup of orphan `tm-qa-*` schedules: ListSchedules has no resource-level scoping.
    { actions: ["scheduler:ListSchedules"], resources: ["*"] },
  ],
});

// ---- PolicyAudit ---------------------------------------------------------------------------------

const auditData = functionData("PolicyAudit");

export const policyAudit = new sst.aws.Function("PolicyAudit", {
  description: "Daily and on-demand re-evaluation of every sent message, every imputation and every chain against its anchors.",
  handler: BFF_HANDLERS.PolicyAudit,
  ...budget("PolicyAudit"),
  // Its tables, the anchors, RegisterChainKey (check d: the chains against their anchors) and CoreMock
  // (getCustomer only: the dated consent and the loans of checks b and c).
  link: auditData.links,
  permissions: auditData.permissions,
  transform: { role: fixedRole("PolicyAudit") },
});

/** Resource side of MOCK_CORE (infra/mocks.ts); the core mock answers it only getCustomer and its health. */
export const policyAuditMockGrants = grantMockInvoke("PolicyAudit", policyAudit);

// ---- BudgetBreaker -------------------------------------------------------------------------------

const breakerKeys: readonly string[] = WORLD_LEADING_KEYS.BudgetBreaker.write;

export const budgetBreaker = new sst.aws.Function("BudgetBreaker", {
  description: "Runtime cut without a deploy: the budget's 100 % sets KILL#AGENT and KILL#SIGNUP, the SES reputation alarms KILL#SIGNUP.",
  handler: BFF_HANDLERS.BudgetBreaker,
  ...budget("BudgetBreaker"),
  link: [tables.Runtime, tables.AuditLog],
  permissions: [
    // The two kill items only, and by PutItem alone.
    { actions: ["dynamodb:PutItem"], resources: [tables.Runtime.arn], conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: breakerKeys.filter((key) => key.startsWith("KILL#")) }, { test: "Null", variable: "dynamodb:LeadingKeys", values: ["false"] }] },
    tablesAccess(["AuditLog"], "append", breakerKeys.filter((key) => key.startsWith("W#"))),
  ],
});

// ---- Schedules -----------------------------------------------------------------------------------

const scheduled = { WorldJanitor: worldJanitor, PolicyAudit: policyAudit } as const;

export const schedules = Object.fromEntries(
  Object.entries(SCHEDULES).map(([name, spec]) => [name, new sst.aws.Cron(name, { function: scheduled[spec.target].arn, schedule: spec.schedule, event: spec.event })]),
) as Readonly<Record<keyof typeof SCHEDULES, sst.aws.Cron>>;

/**
 * A role's table statements in a managed policy under the app's IAM path (bootstrap `IamManageAppPolicies`):
 * inline they would pass IAM's 10,240 characters. Same statements, same fence. Passed as the Function's
 * `policies`: SST's role owns `managedPolicyArns` exclusively and detaches any attachment made apart.
 */
function tablesPolicy(fn: "Bff" | "QaDriver", description: string): aws.iam.Policy {
  const kebab = fn === "Bff" ? "bff" : "qa-driver";
  return new aws.iam.Policy(`${fn}Tables`, { name: `${$app.name}-${$app.stage}-${kebab}-tables`, path: CI_IAM_PATH, description, policy: policyDocument(tableStatements(fn)) });
}

export const qaDriverTables = tablesPolicy("QaDriver", "QaDriver: world tables with the leading keys of qa-*, qamin, sim-* (read-only gprobe).");
export const bffTables = tablesPolicy("Bff", "Bff: world tables with the leading keys of demo, gNN, gtest, gs-*, qa-* and the sign-up counters.");

// ---- Bff -----------------------------------------------------------------------------------------

const edge = EDGE_BUDGETS.bff;

export const bff = new sst.aws.Function("Bff", {
  description: "Console BFF: tRPC behind the Router at /api (edge header required), public sign-up and recovery, phone simulator.",
  handler: BFF_HANDLERS.Bff,
  timeout: `${edge.timeoutSeconds} seconds`,
  memory: `${edge.memoryMb} MB`,
  concurrency: { reserved: edge.reservedConcurrency },
  url: { router: { instance: router, path: LAMBDA_ROUTES.bff, readTimeout: `${edge.routerReadTimeoutSeconds} seconds` } },
  link: [
    // Its tables, buckets, secrets (EdgeOriginKey included), the anchors' name, CoreMock and NetworkMock
    // (a clock move fires the due settlement and transfer timers in line).
    ...functionData("Bff").links.filter((link) => !NARROWED.Bff.tables.some((table) => link === tables[table])),
    auth, // id token verification, account.changePassword
    guestSignup, // the confidential client of the sign-up, with its secret
    ChannelModes, // the simulator answers only in `simulated` worlds
    Scheduler, // TIMERS: clock moves resync the running world's schedules
    anchorWriter, // ANCHOR
    CustomerEvents,
    SignupCustomerEvents,
    QaCustomerEvents, // browser scenarios of `qa-*` worlds (worker/enqueue.ts picks the queue)
    inboundWhatsApp, // the simulator's signed envelope
    worldJanitor, // PROVISIONREQ#, RESETREQ#, PURGEREQ#, asynchronously
    leadNotifier, // the repair of a confirmed sign-up
    tables.Leads,
  ],
  // Its tables go in a managed policy (bffTables); the rest stays inline.
  policies: $util.all([bffTables.arn]),
  permissions: [...objectPermissions("Bff"), ...leadsPermissions("Bff", tables.Leads.arn), cognitoStatement(LAMBDA_CAPABILITIES.Bff.actions)],
  transform: { role: fixedRole("Bff") },
});

/** Resource side of MOCK_CORE and MOCK_NETWORK (infra/mocks.ts). */
export const bffMockGrants = grantMockInvoke("Bff", bff);

// ---- QaDriver ------------------------------------------------------------------------------------

export const qaDriver = new sst.aws.Function("QaDriver", {
  name: qaDriverFunctionName($app.name, $app.stage),
  description: "Scenario driver of the stage, invoked only by the qa-runner role; fenced to QA worlds, reads gprobe.",
  handler: BFF_HANDLERS.QaDriver,
  ...budget("QaDriver"),
  link: links(
    [
      // Its tables, buckets, secrets (QaSimEnvelopeKey, never SimEnvelopeKey), anchors and both mocks.
      ...functionData("QaDriver").links,
      auth,
      guestSignup, // SC-24: sign-ups of success+qa-*@simulator.amazonses.com
      ChannelModes,
      schedulerFencedTo("tm-qa-"), // TIMERS of the QA worlds' schedules only
      Agent,
      anchorWriter,
      QaCustomerEvents, // the only queue it may send to
      QaCustomerEventsDlq, // `dlq.find`, `dlq.delete`
      inboundWhatsApp, // `wa.inbound`
      policyAudit, // `policyAudit.run`
      scheduleDispatch, // `schedule.fireStale`, `fence.probe`
      worldJanitor,
      ReceiptReader, // BEDROCK_READ: the reading evaluation
      GuardrailG1, // `guardrail.probe`
      GuardrailG2, // `gate.probe`
      MalwarePlan, // SC-00/8
      tables.Leads,
      leadNotice, // `notice.probe`: the notice's sender, sent to the SES mailbox simulator only
    ],
    // `alarm.history`: DescribeAlarmHistory on the QA DLQ alarm only (infra/observability.ts imports this module).
    lateLinks("bff", "observability", () => import("./observability"), [QA_DLQ_ALARM_LINK]),
  ),
  // Its tables go in a managed policy (qaDriverTables); the rest stays inline.
  policies: $util.all([qaDriverTables.arn]),
  permissions: [
    ...objectPermissions("QaDriver"),
    ...leadsPermissions("QaDriver", tables.Leads.arn),
    cognitoStatement(CAPABILITIES.COGNITO_QA.actions),
    { actions: ["guardduty:GetMalwareProtectionPlan"], resources: [malwarePlan.arn] },
    sendLeadNoticeProbe,
  ],
  transform: { role: fixedRole("QaDriver") },
});

/** Only the bootstrap's qa-runner role may invoke the QaDriver (ADR-0009); no URL exists. */
export const qaDriverInvokeByQaRunner = new aws.lambda.Permission("QaDriverInvokeByQaRunner", {
  action: "lambda:InvokeFunction",
  function: qaDriver.name,
  principal: qaRunnerRoleArn,
});

/** Resource side of MOCK_CORE and MOCK_NETWORK (infra/mocks.ts). */
export const qaDriverMockGrants = grantMockInvoke("QaDriver", qaDriver);

// The attachments the table policies had before `policies`: kept and retained on delete, so that dropping
// them later never detaches what the roles' `managedPolicyArns` now hold (a delete runs after the update).
const retainedAttachment = (fn: "Bff" | "QaDriver", created: sst.aws.Function, policy: aws.iam.Policy) =>
  new aws.iam.RolePolicyAttachment(`${fn}TablesAttachment`, { role: created.nodes.role.name, policyArn: policy.arn }, { retainOnDelete: true });
export const tablesAttachments = [retainedAttachment("QaDriver", qaDriver, qaDriverTables), retainedAttachment("Bff", bff, bffTables)];
