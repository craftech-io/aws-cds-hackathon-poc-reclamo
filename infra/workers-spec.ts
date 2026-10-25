// Runtime pieces of docs/build-plan.md WP-20 as plain data and pure functions: the customer queues and
// their dead letters, the Lambdas that consume and feed them, their budgets and reserved concurrency,
// the fixed role names, the data each Lambda reaches and the WhatsApp inbound topic. No SST or Pulumi
// dependency: infra/mocks.ts, infra/messaging-whatsapp.ts and infra/workers.ts build the resources from
// here, and infra/workers-spec.test.ts checks it against docs/architecture.md §7, §12 and §14 and
// against infra/iam-capabilities.ts without an account.

import { LAMBDA_CAPABILITIES, WORLD_LEADING_KEYS, type LambdaCapabilities, expectedBuckets, expectedTables, type Access, type BucketName, type LambdaName, type SecretName, type TableName } from "./iam-capabilities";
import { TABLES, leadingKeyFits } from "./storage-keys";
import { MAX_RECEIVE_COUNT, QUEUE_VISIBILITY_TIMEOUT_SECONDS, WORKER_TIMEOUT_SECONDS } from "../packages/bff/src/worker/queue-limits";

// ---- Queues (docs/architecture.md §6 and §7) ----------------------------------------------------

/** One FIFO queue per pool of worlds; `MessageGroupId = <worldId>#<customerId>` (worker/enqueue.ts). */
export const CUSTOMER_QUEUES = ["CustomerEvents", "SignupCustomerEvents", "QaCustomerEvents"] as const;
export type CustomerQueue = (typeof CUSTOMER_QUEUES)[number];

/** Which worlds each queue serves (worker/enqueue.ts chooses; each worker discards `WRONG_QUEUE`). */
export const QUEUE_WORLDS: Readonly<Record<CustomerQueue, string>> = {
  CustomerEvents: "demo, gNN, gtest, gprobe",
  SignupCustomerEvents: "gs-* (self-signup guests, docs/architecture-guests.md §7)",
  QaCustomerEvents: "qa-*, qamin, sim-*",
};

/** Every queue of the stage: the three FIFO queues, their DLQs, the scan deadlines and the anchor failures. */
export type QueueName = CustomerQueue | `${CustomerQueue}Dlq` | "ScanDeadlines" | "ScanDeadlinesDlq" | "AnchorWriteFailures";

/** Fixed physical name, inside the `sqs:<app>-*` fence of the CI deploy role; FIFO names end in `.fifo`. */
export function queueName(app: string, stage: string, queue: QueueName): string {
  const fifo = (CUSTOMER_QUEUES as readonly string[]).includes(queue.replace(/Dlq$/, ""));
  return `${app}-${stage}-${queue}${fifo ? ".fifo" : ""}`;
}

/** The three event workers run the same code (handlers/event-worker.ts), each on its own queue. */
export const WORKERS = {
  EventWorker: { queue: "CustomerEvents" },
  SignupEventWorker: { queue: "SignupCustomerEvents" },
  QaEventWorker: { queue: "QaCustomerEvents" },
} as const satisfies Partial<Record<LambdaName, { queue: CustomerQueue }>>;
export type WorkerName = keyof typeof WORKERS;

/**
 * Timeout, batch and the queue settings that follow from it (docs/architecture.md §7). The worker reads
 * the same constants (its last delivery, and how long an `inFlight` token may belong to a live message).
 */
export { WORKER_TIMEOUT_SECONDS };
export const CUSTOMER_QUEUE_SETTINGS = {
  /** Six times the worker's timeout, as AWS recommends for an SQS event source mapping. */
  visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  maxReceiveCount: MAX_RECEIVE_COUNT,
  batchSize: 1,
  /** SQS's maximum: a dead-lettered event stays readable for the operator and the QaDriver. */
  dlqRetentionSeconds: 14 * 24 * 60 * 60,
} as const;

/** `ScanDeadlines` (docs/architecture.md §6): standard queue, 120 s delay, consumed by MediaIntake. */
export const SCAN_DEADLINES = {
  delaySeconds: 120,
  /** Six times MediaIntake's timeout. */
  visibilityTimeoutSeconds: 360,
  maxReceiveCount: 3,
  batchSize: 1,
} as const;

/**
 * Reserved concurrency of docs/architecture.md §12 (30 in total). WP-20 applies its four; the Bff
 * (WP-37) and ToolInvestigation (WP-31) read theirs from here. Step 0 requires
 * `UnreservedConcurrentExecutions ≥ 130` (Lambda keeps 100 unreserved).
 */
export const RESERVED_CONCURRENCY = {
  EventWorker: 5,
  SignupEventWorker: 2,
  QaEventWorker: 3,
  Bff: 10,
  InboundWhatsApp: 5,
  ToolInvestigation: 5,
} as const satisfies Partial<Record<LambdaName, number>>;

// ---- Lambdas of WP-20 ---------------------------------------------------------------------------

export type Wp20Lambda = WorkerName | "InboundWhatsApp" | "MediaIntake" | "EmailEvents" | "ScheduleDispatch" | "AnchorWriter" | "CoreMock" | "NetworkMock";

/** Lambda entries; each file belongs to the WP that writes its code (docs/build-plan.md §2). */
export const HANDLERS: Readonly<Record<Wp20Lambda, string>> = {
  InboundWhatsApp: "packages/bff/src/handlers/inbound-whatsapp.handler", // WP-32
  EventWorker: "packages/bff/src/handlers/event-worker.handler", // WP-33
  SignupEventWorker: "packages/bff/src/handlers/event-worker.handler",
  QaEventWorker: "packages/bff/src/handlers/event-worker.handler",
  MediaIntake: "packages/bff/src/handlers/media-intake.handler", // WP-27
  EmailEvents: "packages/bff/src/handlers/email-events.handler", // WP-19
  ScheduleDispatch: "packages/bff/src/handlers/schedule-dispatch.handler", // WP-30
  AnchorWriter: "packages/bff/src/handlers/anchor-writer.handler", // WP-25
  CoreMock: "packages/core-mock/src/handler.handler", // WP-15
  NetworkMock: "packages/network-mock/src/handler.handler", // WP-16
};

export interface FunctionBudget {
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
}

export const FUNCTION_BUDGETS: Readonly<Record<Wp20Lambda, FunctionBudget>> = {
  // Signature, identity, classifier (3 s), acknowledgement and, live, the media download.
  InboundWhatsApp: { timeoutSeconds: 30, memoryMb: 1024 },
  // A turn of the Harness (120 s) with its preloaded reads, obligations and sends.
  EventWorker: { timeoutSeconds: WORKER_TIMEOUT_SECONDS, memoryMb: 1024 },
  SignupEventWorker: { timeoutSeconds: WORKER_TIMEOUT_SECONDS, memoryMb: 1024 },
  QaEventWorker: { timeoutSeconds: WORKER_TIMEOUT_SECONDS, memoryMb: 1024 },
  // Reads a receipt image of up to 3.75 MB (magic type, dimensions) and copies it to quarantine/.
  MediaIntake: { timeoutSeconds: 60, memoryMb: 512 },
  EmailEvents: { timeoutSeconds: 30, memoryMb: 256 },
  // Publishes a settlement batch through NetworkMock and enqueues its rechecks.
  ScheduleDispatch: { timeoutSeconds: 60, memoryMb: 512 },
  AnchorWriter: { timeoutSeconds: 30, memoryMb: 256 },
  CoreMock: { timeoutSeconds: 15, memoryMb: 512 },
  // Writes settlement CSVs of up to 5,000 lines.
  NetworkMock: { timeoutSeconds: 30, memoryMb: 512 },
};

/**
 * `AnchorWriter` (docs/architecture.md §8.3): invoked asynchronously, two retries, and an event that
 * still fails goes to the standard queue `AnchorWriteFailures`, whose `ApproximateNumberOfMessagesVisible`
 * feeds the alarm `AnchorWriteFailed` (WP-37). Lambda sends to an on-failure destination with the
 * function's own role, hence the one action on that queue only.
 */
export const ANCHOR_FAILURES = {
  retries: 2,
  retentionSeconds: 14 * 24 * 60 * 60,
  destinationActions: ["sqs:SendMessage"],
} as const;

/** EventBridge rule of the configuration set's events towards EmailEvents (fixed name, like the scan results'). */
export function emailEventsRuleName(app: string, stage: string): string {
  return `${app}-${stage}-email-events`;
}

/**
 * Linkables of modules evaluated after this wave (infra/late-links.ts, mode `optional`: until their
 * owner exports them the deploy warns and the Lambda answers UNAVAILABLE for what needs them).
 *
 *   Scheduler    infra/scheduler.ts (WP-31): TIMERS (the schedule group, its invocation role) for every
 *                holder of PIPELINE
 *   Harness      infra/agentcore.ts (WP-31): InvokeHarness, InvokeAgentRuntime, RetrieveMemoryRecords for
 *                the event workers
 *   Classifier   infra/agentcore.ts (WP-31): BEDROCK_READ of `classifierModelId` for InboundWhatsApp
 */
export const LATE_LINKS = {
  scheduler: ["Scheduler"],
  /** ScheduleDispatch's TIMERS (infra/scheduler.ts): the `Scheduler` Linkable names it as target. */
  dispatchScheduler: ["DispatchScheduler"],
  workerAgent: ["Harness"],
  classifier: ["Classifier"],
} as const;

/** What an SQS event source mapping polls with; granted on the consumer's own queue only. */
export const QUEUE_CONSUMER_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"] as const;

/** Queues each Lambda of WP-20 consumes (event source mapping). */
export const QUEUE_CONSUMERS: Readonly<Partial<Record<Wp20Lambda, QueueName>>> = {
  EventWorker: "CustomerEvents",
  SignupEventWorker: "SignupCustomerEvents",
  QaEventWorker: "QaCustomerEvents",
  MediaIntake: "ScanDeadlines",
};

/** Queues each Lambda of WP-20 may send to (`sqs:SendMessage` through the producer Linkables). */
export const QUEUE_PRODUCERS: Readonly<Partial<Record<Wp20Lambda, readonly QueueName[]>>> = {
  InboundWhatsApp: [...CUSTOMER_QUEUES, "ScanDeadlines"],
  // A worker re-enqueues only on its own queue (`ANSWER_DUE`, `RECONCILE_DUE`).
  EventWorker: ["CustomerEvents"],
  SignupEventWorker: ["SignupCustomerEvents"],
  QaEventWorker: ["QaCustomerEvents"],
  MediaIntake: [...CUSTOMER_QUEUES],
  EmailEvents: [...CUSTOMER_QUEUES],
  ScheduleDispatch: [...CUSTOMER_QUEUES],
};

/** Actions beyond the data and the links: `ChangeMessageVisibility` of a worker on its own queue (`POISON`). */
export const WORKER_OWN_QUEUE_ACTIONS = ["sqs:ChangeMessageVisibility"] as const;

// ---- Roles ----------------------------------------------------------------------------------------

/** `QaDriver` → `qa-driver`. */
export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Fixed role name `<app>-<stage>-<kebab>` (≤ 64 characters). The mocks recognise their callers by
 * role ARN (`MockCallers`, infra/mocks.ts), which therefore must be known without creating the role;
 * `AnchorWriter` and `QaDriver` are named by the CI boundary as well (docs/architecture.md §1).
 */
export function fixedRoleName(app: string, stage: string, fn: LambdaName): string {
  const name = `${app}-${stage}-${kebab(fn)}`;
  if (name.length > 64) throw new Error(`Role name of ${fn} would be ${name.length} characters; IAM allows 64.`);
  return name;
}

/** ARN of a fixed-name role under the app's IAM path `/<app>/` (infra/ci.ts). */
export function fixedRoleArn(scope: { readonly account: string; readonly app: string; readonly stage: string }, fn: LambdaName): string {
  return `arn:aws:iam::${scope.account}:role/${scope.app}/${fixedRoleName(scope.app, scope.stage, fn)}`;
}

// ---- Data each Lambda reaches (docs/architecture.md §14) --------------------------------------------

export interface TableGrant {
  readonly table: TableName;
  readonly access: Access;
  /** `dynamodb:LeadingKeys` fence (with its Null guard, infra/storage-keys.ts). */
  readonly leadingKeys?: readonly string[];
}

export interface BucketGrant {
  readonly bucket: BucketName;
  readonly access: Exclude<Access, "append">;
  /** Object prefixes; the whole bucket when absent. */
  readonly prefixes?: readonly string[];
}

export interface DataPlan {
  readonly tables: readonly TableGrant[];
  readonly buckets: readonly BucketGrant[];
  readonly secrets: readonly SecretName[];
}

/** World roots a world-fenced role of WP-20 reaches in the buckets (docs/architecture.md §6). */
export const WORLD_BUCKET_PREFIXES: Readonly<Partial<Record<LambdaName, readonly string[]>>> = {
  SignupEventWorker: ["W/gs-"],
};

/**
 * Tables, buckets and secrets of one Lambda, from infra/iam-capabilities.ts. A world-fenced role
 * (WORLD_LEADING_KEYS) gets its leading keys on every table that holds worlds: writes only on its
 * `write` keys, reads also on its `readOnly` ones, and a read-only key only on the tables it can name
 * (`KILL#AGENT` lives in Runtime alone): no statement the role could never use, so the role's inline
 * policy stays under IAM's 10,240 characters (infra/policy-size.ts). `Leads` is never part of a plan
 * (LEADS_GRANTS).
 */
export function dataPlan(fn: LambdaName): DataPlan {
  const fence = Object.hasOwn(WORLD_LEADING_KEYS, fn) ? WORLD_LEADING_KEYS[fn as keyof typeof WORLD_LEADING_KEYS] : undefined;
  const tables: TableGrant[] = [];
  for (const [table, access] of Object.entries(expectedTables(fn)) as Array<[TableName, Access]>) {
    if (table === "Leads") throw new Error(`${fn} would reach Leads through its tables; only LEADS_GRANTS may grant it.`);
    if (fence === undefined || TABLES[table].world === "none") {
      tables.push({ table, access });
      continue;
    }
    const readOnly = fence.readOnly.filter((pattern) => leadingKeyFits(table, pattern));
    const readKeys = [...fence.write, ...readOnly];
    if (access === "read") tables.push({ table, access, leadingKeys: readKeys });
    else tables.push({ table, access, leadingKeys: [...fence.write] }, ...(readOnly.length > 0 ? [{ table, access: "read" as const, leadingKeys: readKeys }] : []));
  }
  const prefixes = WORLD_BUCKET_PREFIXES[fn];
  const buckets = (Object.entries(expectedBuckets(fn)) as Array<[BucketName, Exclude<Access, "append">]>).map(([bucket, access]) => ({ bucket, access, ...(prefixes ? { prefixes } : {}) }));
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  return { tables, buckets, secrets: [...(entry.secrets ?? [])] };
}

export interface TableGroup {
  readonly tables: readonly TableName[];
  readonly access: Access;
  readonly leadingKeys?: readonly string[];
}

/** The grants of a plan with the same level and fence, together: one statement each (`tablesAccess`). */
export function groupTableGrants(grants: readonly TableGrant[]): TableGroup[] {
  const groups = new Map<string, { tables: TableName[]; access: Access; leadingKeys?: readonly string[] }>();
  for (const grant of grants) {
    const key = `${grant.access}|${grant.leadingKeys === undefined ? "-" : grant.leadingKeys.join(",")}`;
    const group = groups.get(key);
    if (group) group.tables.push(grant.table);
    else groups.set(key, { tables: [grant.table], access: grant.access, ...(grant.leadingKeys ? { leadingKeys: grant.leadingKeys } : {}) });
  }
  return [...groups.values()];
}

/**
 * What every holder of PIPELINE reads besides its own secrets: the phone number of live sends and the
 * demo recipients of the recipient fence (`SeedOverrides`, demo only). Linked with `ChannelModes`.
 */
export const PIPELINE_SECRETS = ["WhatsAppPhoneNumberId", "SeedOverrides"] as const satisfies readonly SecretName[];

// ---- WhatsApp inbound (docs/architecture-integrations.md §3, docs/architecture.md §13-§14) -----------

/** Fixed name (docs/architecture.md §1): a WABA has a single event destination, so no stage in it. */
export function whatsAppTopicName(app: string): string {
  return `${app}-wa-inbound`;
}

/** SHA256withRSA signatures, the only version InboundWhatsApp verifies (sns-signature.ts). */
export const WHATSAPP_TOPIC_SIGNATURE_VERSION = 2;
export const SOCIAL_MESSAGING_PRINCIPAL = "social-messaging.amazonaws.com";
/** Value of `WabaId` and `WhatsAppPhoneNumberId` for a deployment that uses only the phone simulator. */
export const NOT_CONNECTED = "not-connected";
export const WHATSAPP_SEND_ACTIONS = ["social-messaging:SendWhatsAppMessage"] as const;
export const WHATSAPP_MEDIA_ACTIONS = ["social-messaging:GetWhatsAppMessageMedia"] as const;
/** `s3:ListBucket` of InboundWhatsApp: only under the live media prefix (docs/architecture.md §6). */
export const LIVE_MEDIA_LIST_PREFIX = "wa/*";

interface Place {
  readonly region: string;
  readonly account: string;
}

/**
 * ARN of an End User Messaging Social resource from the secret that names it, or `undefined` while
 * the secret is `not-connected`. Accepts the service's id (`waba-<id>`, `phone-number-id-<id>`) or the
 * ARN of this account and region; anything else fails the deploy without echoing the value.
 */
function socialMessagingArn(place: Place, kind: "waba" | "phone-number-id", secret: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === NOT_CONNECTED) return undefined;
  const prefix = `arn:aws:social-messaging:${place.region}:${place.account}:${kind}/`;
  const id = trimmed.startsWith(`${kind}-`) ? trimmed.slice(kind.length + 1) : trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : undefined;
  if (id === undefined || !/^[0-9a-zA-Z]+$/.test(id)) {
    throw new Error(`The ${secret} secret must be "${NOT_CONNECTED}", "${kind}-<id>" or an ARN of this account in ${place.region}; load it again with \`npx sst secret set ${secret} … --stage poc\`.`);
  }
  return `${prefix}${id}`;
}

export function wabaArn(place: Place, value: string): string | undefined {
  return socialMessagingArn(place, "waba", "WabaId", value);
}

export function phoneNumberIdArn(place: Place, value: string): string | undefined {
  return socialMessagingArn(place, "phone-number-id", "WhatsAppPhoneNumberId", value);
}

export interface PermissionStatement {
  readonly actions: string[];
  readonly resources: string[];
  readonly conditions?: Array<{ readonly test: string; readonly variable: string; readonly values: string[] }>;
}

/** Statements on the phone number of the secret; none while it is not connected (ADR-0002). */
export function phoneStatements(phoneArn: string | undefined, actions: readonly string[]): PermissionStatement[] {
  return phoneArn === undefined ? [] : [{ actions: [...actions], resources: [phoneArn] }];
}

export interface TopicPolicyStatement {
  readonly Sid: string;
  readonly Effect: "Allow";
  readonly Principal: { readonly Service: string } | { readonly AWS: string };
  readonly Action: string | string[];
  readonly Resource: string;
  readonly Condition?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Policy of the inbound topic. End User Messaging Social may publish only for this account and only
 * for the app's WABA (`aws:SourceAccount` and `aws:SourceArn`); while `WabaId` is `not-connected` that
 * statement is omitted and only the account itself may read the topic's attributes (a policy needs a
 * statement), so nobody outside the account publishes anything.
 */
export function whatsAppTopicPolicy(scope: { readonly topicArn: string; readonly account: string; readonly wabaArn: string | undefined }) {
  const statements: TopicPolicyStatement[] = [
    { Sid: "AccountReadsAttributes", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${scope.account}:root` }, Action: ["sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic"], Resource: scope.topicArn },
  ];
  if (scope.wabaArn !== undefined) {
    statements.push({
      Sid: "EndUserMessagingSocialPublishesForTheWaba",
      Effect: "Allow",
      Principal: { Service: SOCIAL_MESSAGING_PRINCIPAL },
      Action: "sns:Publish",
      Resource: scope.topicArn,
      Condition: { StringEquals: { "aws:SourceAccount": scope.account }, ArnEquals: { "aws:SourceArn": scope.wabaArn } },
    });
  }
  return { Version: "2012-10-17" as const, Statement: statements };
}
