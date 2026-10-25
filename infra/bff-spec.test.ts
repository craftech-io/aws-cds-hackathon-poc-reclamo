// infra/bff.ts (docs/architecture.md §4, §10-§14, docs/architecture-guests.md §5 and §12, WP-37),
// evaluated against the recording stand-ins of infra/workers-spec.fakes.ts: the modules it imports from
// other work packages are replaced by stand-ins that expose what it links, and infra/mocks.ts runs for
// real. Every Function's budget, links and statements are checked against the documents and against
// infra/iam-capabilities.ts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { JanitorEvent } from "../packages/bff/src/worlds/janitor-event";
import { PolicyAuditRequest } from "../packages/bff/src/policy-audit/request";
import { uploadPrefixOf } from "../packages/bff/src/channels/whatsapp/media-keys";
import { CAPABILITIES, LEADS_GRANTS, WORLD_LEADING_KEYS, expectedActions, stringLike, type LambdaName } from "./iam-capabilities";
import { IAM_INLINE_POLICY_LIMIT, POLICY_SIZE_BUDGET, estimatedTableArn, inlinePolicySize } from "./policy-size";
import { ANCHOR_ACCESS, TABLE_ACTIONS, leadingKeysConditions, tableHasIndexes } from "./storage-keys";
import { EDGE_BUDGETS, ROUTER_READ_TIMEOUT_MAX_SECONDS } from "./web-spec";
import { fake, installGlobals, type Loaded } from "./workers-spec.fakes";

const ids = vi.hoisted(() => ({
  account: "776805327629",
  pool: "arn:aws:cognito-idp:us-east-1:776805327629:userpool/us-east-1_Pool",
  qaRunner: "arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-reclamo-qa-runner",
  plan: "arn:aws:guardduty:us-east-1:776805327629:malware-protection-plan/plan",
}));

type Ctor = new (logical: string, args?: object) => unknown;
const fn = (name: string): unknown => new (Reflect.get(Reflect.get(Reflect.get(globalThis, "sst") as object, "aws") as object, "Function") as Ctor)(name, {});
const linkable = (logical: string, actions: readonly string[], resources: readonly string[] = []) => ({ kind: "sst.Linkable", logical, include: [{ actions: [...actions], resources: [...resources] }] });
const out = async (value: string) => new (await import("./workers-spec.fakes")).Out(value);

vi.mock("./secrets", async () => (await import("./workers-spec.fakes")).secretsModule());
// Stable table stand-ins, as SST's components are: infra/bff.ts filters links by identity.
vi.mock("./storage", async () => {
  const storage = (await import("./workers-spec.fakes")).storageModule();
  const cache = new Map<string | symbol, unknown>();
  const stable = new Proxy({}, { get: (_target, name) => cache.get(name) ?? cache.set(name, Reflect.get(storage.tables as object, name)).get(name) });
  const { TABLE_ACTIONS: actionsOf, leadingKeysConditions: fenceOf } = await import("./storage-keys");
  // Also a statement's own shape, for the managed policy document of the QaDriver's tables.
  const tablesAccess = (names: readonly string[], access: keyof typeof actionsOf, leadingKeys?: readonly string[]) => ({
    tables: [...names],
    access,
    leadingKeys,
    actions: [...actionsOf[access]],
    resources: names.map((name) => `arn:ddb:${name}`),
    ...(leadingKeys === undefined ? {} : { conditions: fenceOf(leadingKeys) }),
  });
  return { ...storage, tables: stable, tablesAccess };
});
vi.mock("./guardrail", async () => (await import("./workers-spec.fakes")).guardrailModule());
vi.mock("./channel-modes", () => ({ ChannelModes: { link: "ChannelModes" } }));
vi.mock("./web", () => ({ router: { router: "Router" } }));
vi.mock("./auth", async () => ({ auth: { link: "Auth" }, guestSignup: { link: "GuestSignup" }, userPool: { arn: await out(ids.pool) } }));
vi.mock("./ci", async () => ({ qaRunnerRoleArn: await out(ids.qaRunner), CI_IAM_PATH: "/aws-cds-hackathon-poc-reclamo/" }));
vi.mock("./malware", async () => ({ MalwarePlan: { link: "MalwarePlan" }, malwarePlan: { arn: await out(ids.plan) } }));
vi.mock("./agentcore", () => ({ Agent: linkable("Agent", CAPABILITIES.MEMORY_ADMIN.actions) }));
vi.mock("./agentcore-iam", () => ({ ReceiptReader: linkable("ReceiptReader", CAPABILITIES.BEDROCK_READ.actions) }));
vi.mock("./scheduler", () => ({
  Scheduler: linkable("Scheduler", CAPABILITIES.TIMERS.actions, ["schedule/*"]),
  schedulerFencedTo: (prefix: string) => linkable("Scheduler", CAPABILITIES.TIMERS.actions, [`schedule/${prefix}*`]),
}));
vi.mock("./observability", () => ({ QaDlqAlarm: linkable("QaDlqAlarm", ["cloudwatch:DescribeAlarmHistory"]) }));
vi.mock("./messaging-whatsapp", () => ({ inboundWhatsApp: fn("InboundWhatsApp") }));
vi.mock("./leads", () => ({
  leadNotifier: fn("LeadNotifier"),
  ...{ leadNotice: { kind: "sst.Linkable", logical: "LeadNotice", include: [] }, sendLeadNoticeProbe: { actions: ["ses:SendEmail"], resources: ["arn:aws:ses:us-east-1:776805327629:identity/x"], conditions: [] } },
  leadsPermissions: (role: keyof typeof LEADS_GRANTS, arn: unknown) => LEADS_GRANTS[role].map((grant) => ({ actions: [...grant.actions], resources: [arn], leadsRole: role })),
}));
vi.mock("./workers", () => {
  const queue = (name: string, actions: readonly string[] = ["sqs:SendMessage"]) => linkable(name, actions, [`arn:sqs:${name}Queue`]);
  return {
    anchorWriter: fn("AnchorWriter"),
    scheduleDispatch: fn("ScheduleDispatch"),
    CustomerEvents: queue("CustomerEvents"),
    SignupCustomerEvents: queue("SignupCustomerEvents"),
    QaCustomerEvents: queue("QaCustomerEvents"),
    QaCustomerEventsDlq: queue("QaCustomerEventsDlq", ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]),
  };
});

const APP = "aws-cds-hackathon-poc-reclamo";
const place = { app: APP, stage: "poc", region: "us-east-1", account: ids.account };
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
type BffModule = typeof import("./bff");
type Statement = { actions?: string[]; resources?: unknown[]; conditions?: unknown; leadsRole?: string; bucket?: string; access?: string; prefixes?: string[]; anchors?: string };

let loaded: Loaded;
let module: BffModule;
let policyDocument: { Version: string; Statement: Array<{ Effect: string; Action: string[]; Resource: string[]; Condition?: Record<string, Record<string, string[]>> }> };
const resourceOptions = new Map<string, unknown>();

beforeAll(async () => {
  installGlobals();
  const state = Reflect.get(globalThis, "__wp20Fakes") as { created: Array<{ kind: string; name: string; args: Record<string, unknown> }> };
  state.created = [];
  const sst = Reflect.get(globalThis, "sst") as { aws: Record<string, unknown> };
  const record = (kind: string) =>
    class {
      readonly arn: unknown;
      constructor(name: string, args: Record<string, unknown>, options?: unknown) {
        state.created.push({ kind, name, args });
        resourceOptions.set(`${kind}:${name}`, options);
        this.arn = `arn:${kind}:${name}`;
      }
    };
  sst.aws.Cron = record("sst.aws.Cron");
  const providers = Reflect.get(globalThis, "aws") as unknown as Record<string, Record<string, unknown>>;
  providers.iam = { Policy: record("aws.iam.Policy"), RolePolicyAttachment: record("aws.iam.RolePolicyAttachment") };
  module = await import("./bff");
  await Promise.all(state.created.map((item) => fake.deep([item.args.link, item.args.permissions, item.args.policy])));
  policyDocument = JSON.parse(String(await fake.deep(fake.one({ created: state.created, exports: {} }, "aws.iam.Policy", "QaDriverTables").policy))) as typeof policyDocument;
  loaded = { created: [...state.created], exports: { ...module } };
});
const args = (name: string) => fake.one(loaded, "sst.aws.Function", name);
const statements = async (name: string) => (await fake.deep(args(name).permissions)) as Statement[];
const linkNames = (name: string) => fake.linkNames(loaded, name);
/** Non-data actions a Function gets from its links and statements (tables and objects are data). */
async function generatedActions(name: string): Promise<string[]> {
  const links = (await fake.deep(args(name).link)) as Array<{ kind?: string; include?: Array<{ actions?: string[] }> }>;
  const fromLinks = links.flatMap((link) => (link.kind === "sst.aws.Function" ? ["lambda:InvokeFunction"] : (link.include ?? []).flatMap((item) => item.actions ?? [])));
  const fromStatements = (await statements(name)).flatMap((item) => item.actions ?? (item.anchors ? ANCHOR_ACCESS[item.anchors as keyof typeof ANCHOR_ACCESS].flatMap((grant) => grant.actions) : []));
  return [...new Set([...fromLinks, ...fromStatements])].filter((action) => !action.startsWith("dynamodb:") && !DATA_OBJECT_ACTIONS.has(action)).sort();
}
const DATA_OBJECT_ACTIONS = new Set(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]);
/** Resources of the Scheduler link of a Function: the whole group, or a name prefix of it. */
async function schedulerResources(name: string): Promise<unknown[]> {
  const links = (await fake.deep(args(name).link)) as Array<{ logical?: string; include?: Array<{ resources?: unknown[] }> }>;
  return links.filter((link) => link.logical === "Scheduler").flatMap((link) => (link.include ?? []).flatMap((item) => item.resources ?? []));
}

describe("Bff (docs/architecture.md §4, §11)", () => {
  it("declares timeout 20 s and 1,024 MB, below CloudFront's origin timeout, with reserved concurrency 10", () => {
    const bff = args("Bff");
    expect(bff).toMatchObject({ timeout: "20 seconds", memory: "1024 MB", concurrency: { reserved: 10 } });
    expect(bff.url).toMatchObject({ router: { instance: { router: "Router" }, path: "/api", readTimeout: "30 seconds" } });
    expect(EDGE_BUDGETS.bff.timeoutSeconds).toBeLessThan(EDGE_BUDGETS.bff.routerReadTimeoutSeconds);
    expect(EDGE_BUDGETS.bff.routerReadTimeoutSeconds).toBeLessThanOrEqual(ROUTER_READ_TIMEOUT_MAX_SECONDS);
    expect(read("docs/architecture.md")).toContain("**timeout 20 s declarado** (no el default implícito) y **1.024 MB**, por debajo del timeout de origen de 30 s de CloudFront");
  });

  it("runs under its fixed role, the name the mocks recognise, and the logical name the CI boundary lets have a public URL", () => {
    expect(fake.roleName(loaded, "Bff")).toBe(`${APP}-poc-bff`);
    expect(read("infra/bootstrap/ci-role.yaml")).toContain("function:${AppName}-${DeployStage}-BffFunction-*");
    expect(fake.permissionsTo(loaded, "Bff").sort()).toEqual(["CoreMockInvokeBff", "CoreMockUrlBff", "NetworkMockInvokeBff", "NetworkMockUrlBff"].sort());
  });

  it("enqueues on the three customer queues, invokes WorldJanitor and the simulator's entry, and never sends", async () => {
    const names = await linkNames("Bff");
    expect(names).toEqual(expect.arrayContaining(["CustomerEvents", "SignupCustomerEvents", "QaCustomerEvents", "WorldJanitor", "InboundWhatsApp", "LeadNotifier", "AnchorWriter", "Auth", "GuestSignup", "EdgeOriginKey", "PhoneHashKey", "SimEnvelopeKey"]));
    expect(names).not.toEqual(expect.arrayContaining(["EmailSender"]));
    expect(names).not.toContain("GuardrailG2");
    expect(names).not.toContain("QaSimEnvelopeKey");
    const actions = await generatedActions("Bff");
    expect(actions.filter((action) => /^(ses|social-messaging|bedrock):/.test(action))).toEqual([]);
  });

  it("leaves out what WORLDS would grant and it never uses: the core's and networks' tables, MEMORY_ADMIN", async () => {
    const names = await linkNames("Bff");
    for (const unused of ["Core", "Networks", "Agent"]) expect(names, unused).not.toContain(unused);
    const inline = (await statements("Bff")) as Array<Statement & { tables?: string[] }>;
    expect(inline.filter((item) => item.tables !== undefined), "tables go in BffTables").toEqual([]);
    const tablesReached = module.tableGrants("Bff").flatMap((grant) => grant.tables);
    expect(tablesReached).not.toEqual(expect.arrayContaining(["Core"]));
    expect(tablesReached).not.toEqual(expect.arrayContaining(["Networks"]));
    expect(tablesReached).toEqual(expect.arrayContaining(["Worlds", "Complaints", "Timers", "Conversations", "Runtime", "AuditLog", "Register", "ComplianceTape", "Reference"]));
    expect(read("packages/bff/src/routers/clock.ts")).not.toMatch(/from "\.\.\/worlds\/factory"/);
  });

  it("reaches Leads only through LEADS_GRANTS.Bff, and Cognito only on this pool", async () => {
    const all = await statements("Bff");
    expect(all.filter((item) => item.leadsRole !== undefined).map((item) => item.leadsRole)).toEqual(LEADS_GRANTS.Bff.map(() => "Bff"));
    const cognito = all.filter((item) => item.actions?.some((action) => action.startsWith("cognito-idp:")));
    expect(cognito).toEqual([{ actions: ["cognito-idp:AdminInitiateAuth", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminGetUser", "cognito-idp:AdminDeleteUser"], resources: [ids.pool] }]);
  });
});

describe("object roots of the world-fenced roles (docs/architecture.md §6, §14)", () => {
  const objects = async (name: string, action = "s3:GetObject") =>
    (await statements(name)).filter((item) => item.actions?.includes(action) && item.actions.every((verb) => verb.startsWith("s3:") && verb !== "s3:ListBucket")).flatMap((item) => (item.resources ?? []) as string[]);
  const split = (arn: string) => /^arn:aws:s3:::([A-Za-z]+)\/(.*)\*$/.exec(arn)?.slice(1) ?? [];

  it("grants objects only under the roots of the role's worlds, never a whole world bucket", async () => {
    for (const name of ["Bff", "WorldJanitor", "QaDriver"] as const) {
      const arns = await objects(name);
      const listing = (await statements(name)).find((item) => item.actions?.includes("s3:ListBucket"));
      if (name === "Bff") expect(listing, "the Bff never lists").toBeUndefined();
      else expect(listing?.conditions, name).toEqual([{ test: "StringLike", variable: "s3:prefix", values: expect.arrayContaining([expect.stringMatching(/\*$/)]) }]);
      expect(arns.length, name).toBeGreaterThan(0);
      for (const arn of arns) {
        const [bucket, prefix] = split(arn);
        expect(bucket, arn).toBeDefined();
        if (bucket !== "Seed") expect(prefix, arn).not.toBe("");
      }
    }
    const prefixes = async (name: string) => (await objects(name)).map((arn) => split(arn)[1]);
    expect(await prefixes("Bff")).not.toEqual(expect.arrayContaining(["W/gprobe/", "W/sim-", "qa/"]));
    expect(await prefixes("QaDriver")).not.toEqual(expect.arrayContaining(["W/demo/", "W/g??/", "W/gtest/", "W/gs-"]));
    expect(await prefixes("QaDriver")).toContain("W/gprobe/");
  });

  it("gives the Bff only what §14 lists: GET of Media, Documents and Emails, POST of the simulator's uploads and its exports", async () => {
    const writes = (await objects("Bff", "s3:PutObject")).map((arn) => split(arn).join(":"));
    expect(writes.sort()).toEqual(["Exports:W/demo/", "Exports:W/g??/", "Exports:W/gtest/", "Exports:W/gs-", "Exports:qa/*/qa-", "Media:up/", "Media:qa/*/qa-*/up/"].sort());
    // A presigned POST can do no more than its signer: every upload key the simulator signs is a Media write.
    const mediaWrites = writes.filter((item) => item.startsWith("Media:")).map((item) => `${item.slice("Media:".length)}*`);
    for (const world of ["demo", "g07", "gtest", "gs-0001", "qa-r1-sc01"]) expect(mediaWrites.some((pattern) => stringLike(pattern, `${uploadPrefixOf(world)}up-${"0".repeat(26)}/0.png`)), world).toBe(true);
    const buckets = new Set((await objects("Bff")).map((arn) => split(arn)[0]));
    expect([...buckets].sort()).toEqual(["Documents", "Emails", "Exports", "Media", "Seed"]);
    expect(module.objectGrants("Bff").filter((grant) => grant.bucket === "Media" && grant.access === "read").flatMap((grant) => grant.prefixes)).toContain("wa/demo/");
  });

  it("matches each object root with a leading key of the same role", () => {
    const keyOf = (root: string): string => (root.startsWith("qa/") ? "W#qa" : `W#${root.slice(2).replace(/\/$/, "#")}`);
    for (const [name, roots] of Object.entries(module.OBJECT_ROOTS)) {
      const fence = WORLD_LEADING_KEYS[name as keyof typeof WORLD_LEADING_KEYS];
      const keys: readonly string[] = [...fence.write, ...fence.readOnly];
      for (const root of [...roots.own, ...roots.read]) expect(keys.some((key) => key.startsWith(keyOf(root))), `${name} ${root}`).toBe(true);
    }
  });
});

describe("WorldJanitor (docs/architecture.md §10, docs/architecture-guests.md §5)", () => {
  it("declares timeout 900 s and 1,024 MB under a fixed name, and invokes only itself", async () => {
    const janitor = args("WorldJanitor");
    const name = module.worldJanitorFunctionName(APP, "poc");
    expect(janitor).toMatchObject({ name, timeout: "900 seconds", memory: "1024 MB" });
    const invokes = (await statements("WorldJanitor")).filter((item) => item.actions?.includes("lambda:InvokeFunction"));
    expect(invokes).toEqual([{ actions: ["lambda:InvokeFunction"], resources: [`arn:aws:lambda:us-east-1:${ids.account}:function:${name}`] }]);
    expect(read("docs/architecture.md")).toContain("Lambda `WorldJanitor` (**timeout 900 s, 1.024 MB**)");
  });

  it("links the pool, TIMERS on tm-* only, the Memory, AnchorWriter and Leads (LEAD# UpdateItem only)", async () => {
    expect(await linkNames("WorldJanitor")).toEqual(expect.arrayContaining(["Auth", "Scheduler", "Agent", "AnchorWriter", "Leads", "PhoneHashKey", "RegisterChainKey"]));
    expect(await schedulerResources("WorldJanitor")).toEqual(["schedule/tm-*"]);
    expect(await schedulerResources("QaDriver")).toEqual(["schedule/tm-qa-*"]);
    expect(await schedulerResources("Bff")).toEqual(["schedule/*"]);
    expect((await statements("WorldJanitor")).filter((item) => item.actions?.includes("scheduler:ListSchedules"))).toEqual([{ actions: ["scheduler:ListSchedules"], resources: ["*"] }]);
    const leads = (await statements("WorldJanitor")).filter((item) => item.leadsRole === "WorldJanitor");
    expect(leads.map((item) => item.actions)).toEqual([["dynamodb:UpdateItem"]]);
  });

  it("runs the provisioning pass every 5 minutes, the hourly pass and the nightly one, with inputs the handler accepts", () => {
    const crons = loaded.created.filter((item) => item.kind === "sst.aws.Cron");
    const janitor = crons.filter((item) => fake.label(item.args.function) === "WorldJanitor").map((item) => [item.args.schedule, item.args.event]);
    expect(janitor).toEqual([
      ["rate(5 minutes)", { kind: "PROVISION_PASS" }],
      ["rate(1 hour)", { kind: "HOURLY_PASS" }],
      ["cron(0 7 * * ? *)", { kind: "NIGHTLY_PASS" }],
    ]);
    for (const [, event] of janitor) expect(JanitorEvent.safeParse(event).success).toBe(true);
    const audit = crons.filter((item) => fake.label(item.args.function) === "PolicyAudit");
    expect(audit.map((item) => [item.args.schedule, item.args.event])).toEqual([["cron(0 6 * * ? *)", { kind: "DAILY" }]]);
    expect(PolicyAuditRequest.safeParse({ kind: "DAILY" }).success).toBe(true);
    expect(read("docs/architecture-guests.md")).toContain("la **pasada de aprovisionamiento** de `WorldJanitor` (cada 5 minutos)");
  });

  it("is invoked by the post-confirmation trigger by its fixed name, never its component; BudgetBreaker is exported for the auth-mail alerts", () => {
    expect(read("infra/auth.ts")).toContain("WorldJanitorInvoke");
    expect(read("infra/auth.ts")).not.toContain('import("./bff")');
    expect(read("infra/leads.ts")).toContain('Reflect.get(module, "budgetBreaker")');
    expect(module.worldJanitor).toBeDefined();
    expect(module.budgetBreaker).toBeDefined();
  });
});

describe("PolicyAudit and BudgetBreaker (docs/architecture.md §12-§14)", () => {
  it("lets PolicyAudit read the chains and their anchors and append only to AuditLog", async () => {
    const all = await statements("PolicyAudit");
    expect(all.filter((item) => item.anchors !== undefined).map((item) => item.anchors)).toEqual(["read"]);
    expect(await linkNames("PolicyAudit")).toEqual(expect.arrayContaining(["RegisterAnchors", "RegisterChainKey", "Conversations", "ComplianceTape", "Register", "AuditLog", "CoreMock"]));
    expect(args("PolicyAudit")).toMatchObject({ timeout: "900 seconds", memory: "512 MB" });
    // The core mock recognises its callers by fixed role name; PolicyAudit never reaches the networks.
    expect(fake.roleName(loaded, "PolicyAudit")).toBe(`${APP}-poc-policy-audit`);
    expect(fake.permissionsTo(loaded, "PolicyAudit").sort()).toEqual(["CoreMockInvokePolicyAudit", "CoreMockUrlPolicyAudit"]);
  });

  it("lets BudgetBreaker put only the two kill items and append its audit", async () => {
    const all = await statements("BudgetBreaker");
    expect(all[0]).toEqual({
      actions: ["dynamodb:PutItem"],
      resources: ["arn:ddb:Runtime"],
      conditions: [
        { test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["KILL#AGENT", "KILL#SIGNUP"] },
        { test: "Null", variable: "dynamodb:LeadingKeys", values: ["false"] },
      ],
    });
    expect(all[1]).toMatchObject({ tables: ["AuditLog"], access: "append", leadingKeys: ["W#*#AUD#*"] });
    expect(all).toHaveLength(2);
  });
});

describe("QaDriver (docs/architecture.md §1, §14, ADR-0009)", () => {
  it("has a fixed function and role name, no URL, and only the qa-runner role may invoke it", () => {
    const driver = args("QaDriver");
    expect(driver.name).toBe(module.qaDriverFunctionName(APP, "poc"));
    expect(driver.url).toBeUndefined();
    expect(fake.roleName(loaded, "QaDriver")).toBe(`${APP}-poc-qa-driver`);
    const invoke = loaded.created.filter((item) => item.kind === "aws.lambda.Permission" && item.name === "QaDriverInvokeByQaRunner");
    expect(invoke).toHaveLength(1);
    expect(fake.label(invoke[0]?.args.function)).toBe("QaDriver");
    expect(read("infra/bootstrap/ci-role.yaml")).toContain("function:${AppName}-${DeployStage}-qa-driver");
  });

  it("never links EmailEvents nor SimEnvelopeKey, sends only to the QA queue and invokes the mocks only through their URLs", async () => {
    const names = await linkNames("QaDriver");
    expect(names).not.toContain("EmailEvents");
    expect(names).not.toContain("SimEnvelopeKey");
    expect(names).toEqual(expect.arrayContaining(["QaSimEnvelopeKey", "ScheduleDispatch", "AnchorWriter", "PolicyAudit", "WorldJanitor", "InboundWhatsApp", "QaCustomerEventsDlq", "QaDlqAlarm", "GuardrailG1", "GuardrailG2", "ReceiptReader", "GuestSignup", "LeadNotice"]));
    expect(names).not.toContain("LeadNotifyEmail");
    expect(names.filter((name) => /CustomerEvents$/.test(name))).toEqual(["QaCustomerEvents"]);
    expect(fake.permissionsTo(loaded, "QaDriver").sort()).toEqual(["CoreMockInvokeQaDriver", "CoreMockUrlQaDriver", "NetworkMockInvokeQaDriver", "NetworkMockUrlQaDriver"]);
  });

  it("writes anchors only in qa-* streams, reads its malware plan and touches only the QA leads", async () => {
    const all = await statements("QaDriver");
    expect(all.filter((item) => item.anchors !== undefined).map((item) => item.anchors)).toEqual(["write-qa-streams"]);
    expect(all).toEqual(expect.arrayContaining([{ actions: ["guardduty:GetMalwareProtectionPlan"], resources: [ids.plan] }]));
    expect(all.filter((item) => item.actions?.includes("ses:SendEmail"))).toHaveLength(1);
    expect(all.filter((item) => item.leadsRole !== undefined).map((item) => item.leadsRole)).toEqual(["QaDriver"]);
    const cognito = all.find((item) => item.actions?.some((action) => action.startsWith("cognito-idp:")));
    expect(cognito).toEqual({ actions: [...CAPABILITIES.COGNITO_QA.actions], resources: [ids.pool] });
  });
});

/** A role's table statements with ARNs of real length, as its managed policy renders them. */
const renderedTables = (name: "Bff" | "QaDriver") =>
  module.tableGrants(name).map((grant) => ({
    actions: TABLE_ACTIONS[grant.access],
    resources: grant.tables.flatMap((table) => (tableHasIndexes(table) ? [estimatedTableArn(place, table), `${estimatedTableArn(place, table)}/index/*`] : [estimatedTableArn(place, table)])),
    ...(grant.leadingKeys ? { conditions: leadingKeysConditions(grant.leadingKeys) } : {}),
  }));

describe("the Bff's tables in a managed policy of the app's path", () => {
  it("attaches every world-table statement of the Bff with its fence, within IAM's 6,144 characters", async () => {
    expect(fake.one(loaded, "aws.iam.Policy", "BffTables")).toMatchObject({ name: `${APP}-poc-bff-tables`, path: `/${APP}/` });
    // Through SST's `policies` (the role's exclusive managedPolicyArns); the old attachment only retained.
    expect(await fake.deep(args("Bff").policies)).toEqual(["arn:aws.iam.Policy:BffTables"]);
    for (const name of ["BffTablesAttachment", "QaDriverTablesAttachment"]) expect(resourceOptions.get(`aws.iam.RolePolicyAttachment:${name}`), name).toEqual({ retainOnDelete: true });
    const document = JSON.parse(String(await fake.deep(fake.one(loaded, "aws.iam.Policy", "BffTables").policy))) as typeof policyDocument;
    expect(document.Statement.map((statement) => statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"])).toEqual(module.tableGrants("Bff").map((grant) => grant.leadingKeys));
    expect(inlinePolicySize(renderedTables("Bff"))).toBeLessThan(6_144);
  });
});

describe("the QaDriver's tables in a managed policy of the app's path", () => {
  it("attaches every world-table statement of the QaDriver, with its fence, and keeps none inline", async () => {
    const policy = fake.one(loaded, "aws.iam.Policy", "QaDriverTables");
    expect(policy).toMatchObject({ name: `${APP}-poc-qa-driver-tables`, path: `/${APP}/` });
    expect(await fake.deep(args("QaDriver").policies)).toEqual(["arn:aws.iam.Policy:QaDriverTables"]);
    const inline = (await statements("QaDriver")) as Array<Statement & { tables?: string[] }>;
    expect(inline.filter((item) => item.tables !== undefined)).toEqual([]);
    expect(policyDocument.Statement.map((statement) => statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"])).toEqual(module.tableGrants("QaDriver").map((grant) => grant.leadingKeys));
    for (const statement of policyDocument.Statement.filter((item) => item.Condition !== undefined)) expect(statement.Condition?.Null).toEqual({ "dynamodb:LeadingKeys": ["false"] });
    const grants = module.tableGrants("QaDriver");
    // Only the world-less Reference (holidays, templates) is read without a fence.
    for (const grant of grants.filter((item) => item.leadingKeys === undefined)) expect(grant).toEqual({ tables: ["Reference"], access: "read" });
    const reads = grants.filter((grant) => grant.access === "read" && grant.leadingKeys?.includes("W#gprobe#*"));
    // Read-only keys only: gprobe everywhere, the sign-up's switch and kill on Runtime alone (iam-leading-keys.test.ts).
    expect(reads.flatMap((grant) => grant.leadingKeys)).toEqual(["W#gprobe#*", "W#gprobe#*", "SWITCH#SIGNUP", "KILL#SIGNUP"]);
    expect(read("infra/bootstrap/ci-role.yaml")).toContain(":policy/${AppName}/*");
  });

  it("fits IAM's 6,144 characters of a managed policy, with ARNs of real length", () => {
    expect(inlinePolicySize(renderedTables("QaDriver"))).toBeLessThan(6_144);
  });
});

describe("every Function of infra/bff.ts against infra/iam-capabilities.ts", () => {
  const FUNCTIONS = ["Bff", "WorldJanitor", "PolicyAudit", "BudgetBreaker", "QaDriver"] as const satisfies readonly LambdaName[];

  it("points at handler files that exist (the QaDriver's a stub until WP-40)", () => {
    for (const [name, handler] of Object.entries(module.BFF_HANDLERS)) {
      expect(args(name).handler).toBe(handler);
      expect(existsSync(resolve(process.cwd(), `${handler.replace(/\.handler$/, "")}.ts`)), handler).toBe(true);
    }
  });

  it("generates exactly the non-data actions of each capability entry", async () => {
    for (const name of FUNCTIONS) {
      const anchors = (await statements(name)).flatMap((item) => (item.anchors ? ANCHOR_ACCESS[item.anchors as keyof typeof ANCHOR_ACCESS].flatMap((grant) => grant.actions) : []));
      const narrowed = new Set<string>(name === "Bff" ? module.NARROWED.Bff.actions : []);
      const expected = [...new Set([...expectedActions(name), ...anchors])].filter((action) => !action.startsWith("dynamodb:") && !DATA_OBJECT_ACTIONS.has(action) && !narrowed.has(action)).sort();
      expect(await generatedActions(name), name).toEqual(expected);
    }
  });

  it("keeps every role's inline policy, with ARNs of real length, under the budget", async () => {
    expect(POLICY_SIZE_BUDGET).toBeLessThan(IAM_INLINE_POLICY_LIMIT);
    for (const name of FUNCTIONS) {
      const rendered = await fake.renderedPolicy(loaded, name, place);
      const size = inlinePolicySize(rendered);
      expect(size, `${name}: ${size} characters`).toBeLessThan(POLICY_SIZE_BUDGET);
    }
  });

  it("declares timeout and memory of every Function, never SST's implicit defaults", () => {
    for (const name of FUNCTIONS) {
      expect(args(name).timeout, name).toMatch(/^\d+ seconds$/);
      expect(args(name).memory, name).toMatch(/^\d+ MB$/);
    }
  });
});
