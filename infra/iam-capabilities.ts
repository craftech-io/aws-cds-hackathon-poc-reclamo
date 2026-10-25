// Least-privilege capabilities per Lambda (docs/architecture.md §9.2 and §14), as plain data. No SST
// or Pulumi dependency: every infra module that creates a Function builds its `link` and its
// `sst.aws.permission` statements from the entry of that function here, and
// infra/iam-capabilities.test.ts derives the expected actions and compares them with what the
// modules generate. A permission that is not in this file is drift, and the test fails.
//
// Tables and buckets are granted through `link` (SST derives the DynamoDB and S3 actions from the
// linked component) and narrowed by the module: `read`, `write`, or `append` (only `PutItem`, the
// only write any role has on the append-only tables, ADR-0014). The actions listed under `actions`
// are the ones a module must add with `sst.aws.permission`.
//
// `Leads` (contact data of the guest self-signup) is never granted through `tables`: the closed list
// of roles that reach it, each with its own leading keys, is LEADS_GRANTS (infra/iam-leading-keys.ts).

export const APPEND_ONLY_TABLES = ["Register", "ComplianceTape", "AuditLog"] as const;

export type TableName =
  | "Worlds"
  | "Core"
  | "Networks"
  | "Complaints"
  | "Timers"
  | "Conversations"
  | "Reference"
  | "Runtime"
  | "Metrics"
  | "Leads"
  | (typeof APPEND_ONLY_TABLES)[number];

export type BucketName = "Media" | "Documents" | "Emails" | "Settlements" | "Exports" | "Seed";

export type Access = "read" | "write" | "append";

export type SecretName =
  | "SessionKey"
  | "SimEnvelopeKey"
  | "QaSimEnvelopeKey"
  | "PhoneHashKey"
  | "RegisterChainKey"
  | "WabaId"
  | "WhatsAppPhoneNumberId"
  | "SeedOverrides"
  | "LeadNotifyEmail"
  | "EdgeOriginKey";

/** Access to the anchor log group `/<app>/poc/register-anchors` (the boundary denies everyone else). */
export type AnchorAccess = "write" | "write-qa-streams" | "read";

export type CapabilityName =
  | "TIMERS"
  | "SEND_EMAIL"
  | "SEND_WHATSAPP"
  | "ANCHOR"
  | "PIPELINE"
  | "MOCK_CORE"
  | "MOCK_NETWORK"
  | "BEDROCK_READ"
  | "MEMORY_ADMIN"
  | "WORLDS"
  | "COGNITO_QA";

type Tables = Readonly<Partial<Record<TableName, Access>>>;
type Buckets = Readonly<Partial<Record<BucketName, Exclude<Access, "append">>>>;
/** IAM condition per action: `{ action: { conditionKey: value } }`. */
type Conditions = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface Capability {
  readonly actions: readonly string[];
  readonly includes?: readonly CapabilityName[];
  readonly tables?: Tables;
  readonly buckets?: Buckets;
  readonly conditions?: Conditions;
  /** Resource or condition, as docs/architecture.md §14 states it. */
  readonly fence: string;
}

const MOCK_INVOKE = ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"] as const;
/** Since October 2025 an AWS_IAM Function URL needs both actions; direct invocation stays impossible. */
export const MOCK_CONDITIONS: Conditions = {
  "lambda:InvokeFunctionUrl": { "lambda:FunctionUrlAuthType": "AWS_IAM" },
  "lambda:InvokeFunction": { "lambda:InvokedViaFunctionUrl": "true" },
};

const WORLD_TABLES = {
  Worlds: "write",
  Core: "write",
  Networks: "write",
  Complaints: "write",
  Timers: "write",
  Conversations: "write",
  Metrics: "write",
  Runtime: "write",
  Register: "append",
  ComplianceTape: "append",
  AuditLog: "append",
} as const satisfies Tables;

export const CAPABILITIES: Readonly<Record<CapabilityName, Capability>> = {
  TIMERS: {
    actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "iam:PassRole"],
    fence: "schedule/aws-cds-hackathon-poc-reclamo-poc-schedules/*; PassRole only of the Scheduler invocation role, iam:PassedToService = scheduler.amazonaws.com",
  },
  SEND_EMAIL: {
    // SES v2 SendEmail with Content.Raw is authorized as ses:SendRawEmail.
    actions: ["ses:SendEmail", "ses:SendRawEmail"],
    fence:
      "identity reclamo.demo.craftech.io + configuration set …-email-poc; ses:FromAddress = respuestas@reclamo.demo.craftech.io; ForAllValues:StringLike ses:Recipients ∈ {*@simulator.amazonses.com, *@craftech.io} when SES fills them (IfExists: Content.Raw leaves both keys empty); the single recipient is fenced in code",
  },
  SEND_WHATSAPP: {
    actions: ["social-messaging:SendWhatsAppMessage"],
    fence: "phone-number-id of the secret; statement omitted while it is not-connected",
  },
  ANCHOR: {
    actions: ["lambda:InvokeFunction"],
    fence: "asynchronous invocation of AnchorWriter only; no role with ANCHOR has logs:PutLogEvents on the anchors",
  },
  PIPELINE: {
    actions: ["bedrock:ApplyGuardrail"],
    includes: ["SEND_EMAIL", "SEND_WHATSAPP", "TIMERS", "ANCHOR"],
    tables: { ComplianceTape: "append", Conversations: "write", Runtime: "write" },
    buckets: { Emails: "write", Documents: "write" },
    fence: "G2 guardrail; every sender runs the outbound gate",
  },
  MOCK_CORE: { actions: MOCK_INVOKE, conditions: MOCK_CONDITIONS, fence: "ARN of CoreMock, only through its Function URL" },
  MOCK_NETWORK: { actions: MOCK_INVOKE, conditions: MOCK_CONDITIONS, fence: "ARN of NetworkMock, only through its Function URL" },
  BEDROCK_READ: {
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    fence: "inference profile and foundation model ARNs of classifierModelId / receiptModelId (Converse)",
  },
  MEMORY_ADMIN: {
    actions: [
      "bedrock-agentcore:ListActors",
      "bedrock-agentcore:ListSessions",
      "bedrock-agentcore:ListEvents",
      "bedrock-agentcore:DeleteEvent",
      "bedrock-agentcore:ListMemoryRecords",
      "bedrock-agentcore:DeleteMemoryRecord",
      "bedrock-agentcore:RetrieveMemoryRecords",
    ],
    fence: "Memory of the stage; ListSessions names the events of an actor (ListEvents takes a session id)",
  },
  WORLDS: {
    actions: ["s3:ListBucket"],
    includes: ["ANCHOR", "TIMERS", "MEMORY_ADMIN"],
    tables: WORLD_TABLES,
    buckets: { Seed: "read", Media: "write", Documents: "write", Emails: "write", Settlements: "write" },
    fence: "dynamodb:LeadingKeys of the role (WORLD_LEADING_KEYS) + Null guard; objects and ListBucket only under the world root (docs/architecture.md §6)",
  },
  COGNITO_QA: {
    // AdminGetUser and AdminDeleteUser: `guest.signup` runs the real self-signup service in process,
    // which reads the account's state before SignUp and recreates an UNCONFIRMED one (guests/signup.ts).
    actions: [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminInitiateAuth",
      "cognito-idp:AdminConfirmSignUp",
    ],
    fence:
      "user pool of the stage; the code requires qa-<runId>-<scenario>-<role> (AdminGetUser, AdminDeleteUser of an UNCONFIRMED sign-up and AdminConfirmSignUp only success+qa-*@simulator.amazonses.com) and the pre-token trigger rejects a qa-* user outside a qa-* world; never ListUsers: a self-signup's Username is the lead's email",
  },
};

export { LEADS_GRANTS, WORLD_LEADING_KEYS, leadingKeysAllow, leadsAllow, stringLike, type LeadsGrant, type LeadsRole, type WorldFencedRole } from "./iam-leading-keys";

export interface LambdaCapabilities {
  readonly capabilities: readonly CapabilityName[];
  readonly tables?: Tables;
  readonly buckets?: Buckets;
  readonly secrets?: readonly SecretName[];
  readonly anchors?: AnchorAccess;
  /** Other Lambdas of the app it invokes directly (never a mock: those go through their Function URL). */
  readonly invokes?: readonly string[];
  /** Actions beyond the capabilities and the linked data, each fenced as `fence` says. */
  readonly actions?: readonly string[];
  readonly fence?: string;
}

const WORKER = {
  capabilities: ["PIPELINE", "MOCK_CORE", "MOCK_NETWORK"],
  tables: { Complaints: "write", Conversations: "write", Timers: "write", Runtime: "write", Metrics: "write", Worlds: "read", Reference: "read", Register: "append", AuditLog: "append" },
  buckets: { Documents: "write", Settlements: "read" },
  // PhoneHashKey: the outbound gate keys the reply-button nonces of a WhatsApp message by the phone hash.
  secrets: ["SessionKey", "RegisterChainKey", "PhoneHashKey"],
  actions: [
    "bedrock-agentcore:InvokeHarness",
    "bedrock-agentcore:InvokeAgentRuntime",
    "bedrock-agentcore:RetrieveMemoryRecords",
    "sqs:SendMessage",
    "sqs:ChangeMessageVisibility",
  ],
  fence: "SendMessage and ChangeMessageVisibility only on its own queue; ApplyGuardrail also G1; Settlements read for the deterministic reconciliation",
} as const satisfies LambdaCapabilities;

const TOOL = { secrets: ["SessionKey"] } as const;

export const LAMBDA_CAPABILITIES = {
  InboundWhatsApp: {
    capabilities: ["PIPELINE", "BEDROCK_READ", "MOCK_CORE"],
    tables: { Conversations: "write", Complaints: "write", Timers: "write", Runtime: "write", Worlds: "read", Reference: "read", Register: "append", AuditLog: "append" },
    buckets: { Media: "write", Seed: "read" },
    secrets: ["SimEnvelopeKey", "QaSimEnvelopeKey", "PhoneHashKey", "RegisterChainKey"],
    actions: ["social-messaging:GetWhatsAppMessageMedia", "s3:ListBucket", "sqs:SendMessage"],
    fence: "ApplyGuardrail also G1; ListBucket of Media with s3:prefix wa/*; SendMessage on both customer queues and ScanDeadlines; Reference: holidays, seed receipt hashes, templates; Seed: copy of a synthetic receipt",
  },
  EventWorker: WORKER,
  // Same code as EventWorker, fed by SignupCustomerEvents.fifo for the `gs-*` worlds (ADR-0020).
  SignupEventWorker: WORKER,
  QaEventWorker: WORKER,
  ToolIdentity: { ...TOOL, capabilities: ["MOCK_CORE"], tables: { Conversations: "write", Runtime: "write", AuditLog: "append" } },
  // Complaints: the loan status, payoff quote and clauses an account read leaves on the complaint of the turn.
  ToolAccount: { ...TOOL, capabilities: ["MOCK_CORE"], tables: { Complaints: "write", Runtime: "write", Reference: "read", AuditLog: "append" } },
  ToolInvestigation: {
    ...TOOL,
    capabilities: ["BEDROCK_READ", "MOCK_CORE", "MOCK_NETWORK"],
    tables: { Complaints: "write", Runtime: "write", Reference: "read", AuditLog: "append" },
    buckets: { Media: "read", Settlements: "read" },
  },
  ToolActions: {
    capabilities: ["ANCHOR", "MOCK_CORE", "MOCK_NETWORK"],
    tables: { Complaints: "write", Runtime: "write", Worlds: "read", Register: "append", AuditLog: "append" },
    secrets: ["SessionKey", "RegisterChainKey"],
  },
  ToolComplaints: {
    capabilities: ["PIPELINE", "MOCK_CORE"],
    tables: { Complaints: "write", Timers: "write", Runtime: "write", Register: "append", AuditLog: "append" },
    buckets: { Documents: "write" },
    secrets: ["SessionKey", "RegisterChainKey", "PhoneHashKey"],
  },
  ToolMessaging: { ...TOOL, secrets: ["SessionKey", "PhoneHashKey"], capabilities: ["PIPELINE", "MOCK_CORE"], tables: { Conversations: "write", Complaints: "read", Runtime: "write", AuditLog: "append" } },
  // MOCK_CORE: its outbound gate (handoff notice, safety guidance) reads the customer from the core.
  ToolHandoff: { ...TOOL, secrets: ["SessionKey", "PhoneHashKey"], capabilities: ["PIPELINE", "MOCK_CORE"], tables: { Complaints: "write", Conversations: "write", Runtime: "write", AuditLog: "append" } },
  MediaIntake: {
    capabilities: [],
    tables: { Runtime: "write", Conversations: "write", Complaints: "read", Reference: "read", AuditLog: "append" },
    buckets: { Media: "write" },
    actions: ["s3:GetObjectTagging", "sqs:SendMessage"],
    fence: "Media read and copy to quarantine/; SendMessage on both customer queues",
  },
  EmailEvents: {
    capabilities: ["ANCHOR"],
    tables: { Conversations: "write", Complaints: "write", Runtime: "write", Register: "append", AuditLog: "append" },
    secrets: ["RegisterChainKey"],
    actions: ["sqs:SendMessage"],
    fence: "no PIPELINE: it only enqueues EMAIL_EVENT",
  },
  ScheduleDispatch: {
    capabilities: ["MOCK_NETWORK", "TIMERS"],
    tables: { Timers: "write", Complaints: "read", Runtime: "write", AuditLog: "append" },
    actions: ["sqs:SendMessage"],
    fence: "Runtime write for worker/enqueue.ts `ADD inFlight`; TIMERS (a running world's next schedules) through the DispatchScheduler Linkable, its own ARN as target",
  },
  Bff: {
    // MOCK_NETWORK: a clock move fires the due settlement and transfer timers in line (routers/clock.ts).
    capabilities: ["WORLDS", "MOCK_CORE", "MOCK_NETWORK"],
    tables: { Reference: "read" },
    buckets: { Media: "write", Documents: "read", Emails: "read", Exports: "write" },
    secrets: ["SimEnvelopeKey", "PhoneHashKey", "RegisterChainKey", "EdgeOriginKey"],
    anchors: "read",
    invokes: ["InboundWhatsApp", "WorldJanitor", "LeadNotifier"],
    actions: [
      "sqs:SendMessage",
      "lambda:InvokeFunction",
      "logs:FilterLogEvents",
      "cognito-idp:AdminInitiateAuth",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminDeleteUser",
    ],
    fence:
      "LeadingKeys of WORLD_LEADING_KEYS.Bff; Leads by LEADS_GRANTS.Bff (no GetItem or Query of LEAD#; Query only on ByEmailHash); AdminDeleteUser only for UNCONFIRMED @ usernames (code); InvokeFunction of WorldJanitor only with a PROVISIONREQ#/RESETREQ#/PURGEREQ# ticket (code); no SES, no EUM Social, no Guardrails: every send belongs to the worker",
  },
  WorldJanitor: {
    capabilities: ["WORLDS"],
    secrets: ["PhoneHashKey", "RegisterChainKey"],
    invokes: ["WorldJanitor"],
    actions: ["cognito-idp:ListUsers", "cognito-idp:AdminDeleteUser", "lambda:InvokeFunction", "scheduler:ListSchedules"],
    fence:
      "TIMERS only on …-poc-schedules/tm-*; ListSchedules (no resource-level scoping; the code names the group) for orphan tm-qa-*; InvokeFunction only of itself; GuestIndex (GUEST#*) and GUESTCAP#* by WORLD_LEADING_KEYS; Leads by LEADS_GRANTS (UpdateItem of LEAD#); ListUsers/AdminDeleteUser also for UNCONFIRMED and inactive self-signup accounts (code)",
  },
  PolicyAudit: {
    // MOCK_CORE: the dated WhatsApp consent and the loans of checks b and c (getCustomer, read only).
    capabilities: ["MOCK_CORE"],
    tables: { Conversations: "read", ComplianceTape: "read", Complaints: "read", Register: "read", Worlds: "read", Reference: "read", AuditLog: "append" },
    secrets: ["RegisterChainKey"],
    anchors: "read",
    actions: ["logs:FilterLogEvents"],
  },
  BudgetBreaker: {
    capabilities: [],
    tables: { Runtime: "write", AuditLog: "append" },
    fence: "PutItem on Runtime with LeadingKeys KILL#AGENT and KILL#SIGNUP; subscribed to …-budget-alerts (both kills) and …-auth-mail-alerts (only KILL#SIGNUP)",
  },
  CoreMock: { capabilities: [], tables: { Core: "write" }, secrets: ["PhoneHashKey"] },
  NetworkMock: { capabilities: [], tables: { Networks: "write" }, buckets: { Settlements: "write" } },
  QaDriver: {
    capabilities: ["WORLDS", "MOCK_CORE", "MOCK_NETWORK", "BEDROCK_READ", "COGNITO_QA"],
    tables: { Reference: "read" },
    buckets: { Exports: "write" },
    secrets: ["QaSimEnvelopeKey", "PhoneHashKey", "RegisterChainKey"],
    anchors: "write-qa-streams",
    invokes: ["InboundWhatsApp", "PolicyAudit", "ScheduleDispatch", "WorldJanitor", "AnchorWriter"],
    actions: ["lambda:InvokeFunction", "guardduty:GetMalwareProtectionPlan", "bedrock:ApplyGuardrail", "s3:DeleteObject", "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "cloudwatch:DescribeAlarmHistory", "ses:SendEmail"],
    fence:
      "LeadingKeys of WORLD_LEADING_KEYS.QaDriver; Leads by LEADS_GRANTS (QASIGNUP#, QAPENDING#, QALEAD# only, never W#gs-*); DeleteObject only qa/*; DeleteSchedule only tm-qa-*; SendMessage only QaCustomerEvents.fifo; Receive/Delete/GetQueueAttributes only on the QA DLQ; DescribeAlarmHistory only on the QA DLQ alarm; anchors only log-stream:qa-*; SendEmail (notice.probe, messaging-email-spec.ts leadNoticeProbeStatement) from no-reply@ to success@simulator.amazonses.com only",
  },
  AnchorWriter: {
    capabilities: [],
    tables: { Register: "read", ComplianceTape: "read" },
    anchors: "write",
    actions: ["sqs:SendMessage"],
    fence: "strongly consistent GetItem only; SendMessage only on its own on-failure destination queue <app>-poc-AnchorWriteFailures (infra/workers.ts)",
  },
  PreTokenTrigger: {
    capabilities: [],
    tables: { Worlds: "read", AuditLog: "append" },
    fence: "Query Worlds/index/BySub and GetItem META/STAFF#; Leads by LEADS_GRANTS (GetItem of LEAD#/QALEAD# limited to pk, sk, worldId); AuditLog W#*#AUD#* only",
  },
  PreSignUpTrigger: { capabilities: [], fence: "Leads by LEADS_GRANTS only: GetItem of SIGNUP#, QASIGNUP#, PENDING#, QAPENDING#" },
  PostConfirmationTrigger: {
    capabilities: [],
    tables: { Worlds: "write", Runtime: "write", AuditLog: "append" },
    invokes: ["WorldJanitor", "LeadNotifier"],
    actions: ["lambda:InvokeFunction"],
    fence:
      "Worlds and Runtime: PutItem, UpdateItem and ConditionCheckItem only, LeadingKeys W#gs-* / W#qa-* (POST_CONFIRMATION_TABLE_ACTIONS); AuditLog PutItem; Leads by LEADS_GRANTS; no secret; invoked only by the pool",
  },
  CustomMessageTrigger: { capabilities: [], fence: "no permission: it only rewrites the text of Cognito's emails" },
  LeadNotifier: {
    capabilities: [],
    tables: { Runtime: "write", AuditLog: "append" },
    secrets: ["LeadNotifyEmail"],
    actions: ["ses:SendEmail"],
    fence:
      "SEND_LEAD_NOTICE (messaging-email-spec.ts leadNoticeStatement): identity of the app, ses:FromAddress no-reply@reclamo.demo.craftech.io, ForAllValues:StringLike ses:Recipients *@craftech.io + Null guards; Runtime UpdateItem of LEADNOTICE#* and AuditLog PutItem of SIGNUP#AUD#* (WORLD_LEADING_KEYS); Leads by LEADS_GRANTS (GetItem/UpdateItem of LEAD#); no PIPELINE",
  },
} as const satisfies Record<string, LambdaCapabilities>;

export type LambdaName = keyof typeof LAMBDA_CAPABILITIES;

/** SQS actions of the QaDriver that only the QA DLQ may receive (`dlq.find`, `dlq.delete`). */
export const QA_DRIVER_DLQ_ONLY_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"] as const;

/** Every capability a function holds, with the ones they include, without duplicates. */
export function resolveCapabilities(names: readonly CapabilityName[]): CapabilityName[] {
  const seen = new Set<CapabilityName>();
  const visit = (name: CapabilityName): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const included of CAPABILITIES[name].includes ?? []) visit(included);
  };
  for (const name of names) visit(name);
  return [...seen].sort();
}

/** Raw IAM actions a function must receive through `sst.aws.permission` (data access goes by `link`). */
export function expectedActions(fn: LambdaName): string[] {
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  const actions = new Set<string>(entry.actions ?? []);
  for (const capability of resolveCapabilities(entry.capabilities)) for (const action of CAPABILITIES[capability].actions) actions.add(action);
  return [...actions].sort();
}

const RANK: Record<Access, number> = { read: 0, append: 1, write: 2 };

function mergeAccess<K extends string, A extends Access>(target: Partial<Record<K, A>>, source: Readonly<Partial<Record<K, A>>> | undefined): void {
  for (const [key, access] of Object.entries(source ?? {}) as Array<[K, A]>) {
    const current = target[key];
    if (current === undefined || RANK[access] > RANK[current]) target[key] = access;
  }
}

/** Tables a function reaches, capabilities included; the strongest access wins. */
export function expectedTables(fn: LambdaName): Partial<Record<TableName, Access>> {
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  const merged: Partial<Record<TableName, Access>> = {};
  mergeAccess(merged, entry.tables);
  for (const capability of resolveCapabilities(entry.capabilities)) mergeAccess(merged, CAPABILITIES[capability].tables);
  return merged;
}

/** Buckets a function reaches, capabilities included; `write` wins over `read`. */
export function expectedBuckets(fn: LambdaName): Partial<Record<BucketName, Exclude<Access, "append">>> {
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  const merged: Partial<Record<BucketName, Exclude<Access, "append">>> = {};
  mergeAccess(merged, entry.buckets);
  for (const capability of resolveCapabilities(entry.capabilities)) mergeAccess(merged, CAPABILITIES[capability].buckets);
  return merged;
}

/** Actions a module generated that the capabilities do not allow, and allowed ones it did not generate. */
export function actionDrift(fn: LambdaName, generated: readonly string[]): { extra: string[]; missing: string[] } {
  const expected = new Set(expectedActions(fn));
  const actual = new Set(generated);
  return {
    extra: [...actual].filter((action) => !expected.has(action)).sort(),
    missing: [...expected].filter((action) => !actual.has(action)).sort(),
  };
}
