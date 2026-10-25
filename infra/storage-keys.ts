// Keys, indexes, buckets and anchors of the storage layer (docs/architecture.md §5, §6 and §8.3) as
// plain data and pure functions. No SST or Pulumi dependency: infra/storage-tables.ts,
// infra/storage-buckets.ts and infra/storage.ts build the resources from this file, and
// infra/storage-keys.test.ts checks it against the documents and the IAM fences without an account.
//
// Key rules every writer follows (docs/architecture.md §5):
//
//   - every table has a string partition key `pk` and a string sort key `sk`;
//   - every partition of an item of a world starts with `W#<worldId>#`, in every table, and so does
//     the partition of every index a world-fenced role queries (`Bff`, `QaDriver`, `WorldJanitor`):
//     IAM evaluates `dynamodb:LeadingKeys` on the partition key of the index, so one list of
//     `ForAllValues:StringLike` patterns fences a role on every table and index
//     (infra/iam-capabilities.ts, WORLD_LEADING_KEYS);
//   - the only partitions without a world are `Reference` (`REF#…`), the global items of `Runtime`
//     (`LIVEPHONE#`, `GLOBALCAP#`, `KILL#AGENT`, `LEASE#`, `PROBE#` and the self-signup's), the
//     self-signup's audit partition of `AuditLog` (`SIGNUP#AUD#[QA#]<yyyy-mm>`) and `Leads`;
//   - `WorldIndex` (keys only) lists every item of one world in the tables the factory rebuilds: its
//     partition is `W#<worldId>#` (world-fenced roles query it) and its sort `<pk>|<sk>`;
//   - TTL lives in `expiresAt` (epoch seconds), set when the item is written.
//
// The index attribute names are the ones packages/bff/src/connector/tables.ts writes (WP-10); the
// test compares both lists.

import type { BrowserBucket } from "./ci-spec";
import type { Access, AnchorAccess, BucketName, TableName } from "./iam-capabilities";

// ---- Tables ------------------------------------------------------------------------------------

export const PARTITION_KEY = "pk";
export const SORT_KEY = "sk";
export const TTL_ATTRIBUTE = "expiresAt";

export type KeyType = "string" | "number";

export interface IndexSpec {
  readonly hashKey: string;
  readonly rangeKey?: string;
  readonly projection: "all" | "keys-only";
  /** Shape of the partition value, as docs/architecture.md §5 writes it. */
  readonly partition: string;
}

export interface TableSpec {
  /** `all`: every partition belongs to a world · `mixed`: Runtime and AuditLog (plus global items) · `none`: Reference, Leads. */
  readonly world: "all" | "mixed" | "none";
  readonly indexes: Readonly<Record<string, IndexSpec>>;
  readonly ttl: boolean;
  /**
   * `false`: no point-in-time recovery (`Leads`, docs/architecture-guests.md §10): a lead deleted on
   * request must not survive in a copy. Every other table keeps SST's default (recovery on).
   */
  readonly backups?: false;
}

export const WORLD_INDEX = "WorldIndex";
export const WORLD_INDEX_KEY = "worldIndexKey";
export const WORLD_INDEX_SORT = "worldIndexSort";

/** Key attributes stored as numbers; every other key attribute is a string. */
const NUMBER_KEYS: ReadonlySet<string> = new Set(["seq"]);

function index(hashKey: string, partition: string, rangeKey?: string): IndexSpec {
  return { hashKey, partition, projection: "all", ...(rangeKey === undefined ? {} : { rangeKey }) };
}

function keysOnly(hashKey: string, partition: string): IndexSpec {
  return { hashKey, partition, projection: "keys-only" };
}

const worldIndex: IndexSpec = { hashKey: WORLD_INDEX_KEY, rangeKey: WORLD_INDEX_SORT, projection: "keys-only", partition: "W#<worldId>#" };

/** One table per aggregate (docs/architecture.md §5), keyed by the logical name every module links. */
export const TABLES = {
  Worlds: {
    world: "all",
    ttl: true,
    indexes: {
      BySub: index("cognitoSubKey", "SUB#<sub>"),
      // Sparse (only `gs-*` worlds): the self-signup queue, read only by WorldJanitor (docs/architecture-guests.md §5).
      GuestIndex: index("guestIndexKey", "GUEST#<status>", "guestIndexSort"),
    },
  },
  Core: {
    world: "all",
    ttl: true,
    indexes: {
      ByPhone: index("phoneHash", "<phoneHash>"),
      ByOperationCode: index("opCodeKey", "W#<worldId>#<network>#<operationCode>"),
      ByCvu: index("cvuKey", "W#<worldId>#CVU#<syntheticCvu>"),
      [WORLD_INDEX]: worldIndex,
    },
  },
  Networks: { world: "all", ttl: true, indexes: { [WORLD_INDEX]: worldIndex } },
  Complaints: {
    world: "all",
    ttl: true,
    indexes: {
      InboxIndex: index("inboxKey", "W#<worldId>#OPEN", "deadlineSort"),
      ByCustomer: index("customerKey", "W#<worldId>#CUS#<customerId>", "filedAtSort"),
      ByNumber: index("numberKey", "W#<worldId>#<complaintNumber>"),
      ApprovalIndex: index("approvalKey", "W#<worldId>#PENDING", "requestedAtSort"),
      [WORLD_INDEX]: worldIndex,
    },
  },
  Register: { world: "all", ttl: true, indexes: { ByComplaint: index("complaintKey", "W#<worldId>#e<epoch>#<complaintNumber>", "seq") } },
  Timers: {
    world: "all",
    ttl: true,
    indexes: {
      ClockDue: index("clockDueKey", "W#<worldId>#CLOCKDUE", "dueSort"),
      ByOwner: index("ownerIndexKey", "W#<worldId>#<ownerKey>", "dueSort"),
      [WORLD_INDEX]: worldIndex,
    },
  },
  Conversations: {
    world: "all",
    ttl: true,
    indexes: {
      ByProviderMessageId: index("providerMessageId", "<providerMessageId>"),
      ByCustomerSent: index("customerSentKey", "W#<worldId>#CUS#<customerId>", "sentAtSort"),
      EmailIndex: index("emailIndexKey", "W#<worldId>#MAIL", "sentAtSort"),
      [WORLD_INDEX]: worldIndex,
    },
  },
  ComplianceTape: {
    world: "all",
    ttl: true,
    indexes: {
      ByComplaint: index("complaintKey", "W#<worldId>#CMP#<id>", "atSort"),
      ByDecision: index("decisionKey", "W#<worldId>#<decision>", "atSort"),
      ByMessage: index("messageId", "<messageId>"),
      BySeq: index("seqKey", "W#<worldId>#TAPESEQ#e<epoch>", "seq"),
    },
  },
  AuditLog: {
    world: "mixed",
    ttl: true,
    indexes: {
      ByRef: index("refIndexKey", "W#<worldId>#<refKey>", "ts"),
      ByAction: index("actionKey", "W#<worldId>#<action>", "ts"),
    },
  },
  Reference: { world: "none", ttl: false, indexes: {} },
  Runtime: { world: "mixed", ttl: true, indexes: {} },
  Metrics: { world: "all", ttl: true, indexes: {} },
  // Contact data of the self-signup, outside the demo data; indexes carry keys only (docs/architecture-guests.md §10).
  Leads: {
    world: "none",
    ttl: true,
    backups: false,
    indexes: { ByEmailHash: keysOnly("emailHashKey", "EMAIL#<emailHash>"), BySub: keysOnly("subKey", "SUB#<sub>") },
  },
} as const satisfies Record<TableName, TableSpec>;

export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

/** Partitions without a world, per table (docs/architecture.md §5). */
export const GLOBAL_PARTITION_PREFIXES: Readonly<Partial<Record<TableName, readonly string[]>>> = {
  Reference: ["REF#"],
  Runtime: [
    "LIVEPHONE#",
    "GLOBALCAP#",
    "KILL#AGENT",
    "LEASE#",
    "PROBE#",
    // The self-signup (docs/architecture-guests.md §11).
    "KILL#SIGNUP",
    "SWITCH#SIGNUP",
    "SIGNUPCAP#",
    "SIGNUPIP#",
    "SIGNUPCANON#",
    "RECOVERYIP#",
    "AUTHMAIL#",
    "GUESTACCT#",
    "GUESTCAP#",
    "LEADNOTICE#",
  ],
  // The self-signup's audit entries that belong to no world, `SIGNUP#AUD#[QA#]<yyyy-mm>` (packages/bff/src/leads/keys.ts).
  AuditLog: ["SIGNUP#AUD#"],
  Leads: ["SIGNUP#", "PENDING#", "CANON#", "LEAD#", "LEADDEL#", "QASIGNUP#", "QAPENDING#", "QALEAD#"],
};

/** Whether a table has secondary indexes (a statement names `<arn>/index/*` only then). */
export function tableHasIndexes(table: TableName): boolean {
  return Object.keys(TABLES[table].indexes).length > 0;
}

/** World partitions that only one table holds (`W#<w>#METRICS`, packages/bff/src/connector/keys.ts). */
export const TABLE_WORLD_SUFFIXES: Readonly<Partial<Record<TableName, string>>> = { Metrics: "#METRICS" };

/**
 * Whether a leading-key pattern can name a partition of `table`: a world key (`W#…`) on a table that
 * holds worlds (one that ends in a table's own suffix on that table alone), a global key only on the
 * table whose global partitions start like it.
 */
export function leadingKeyFits(table: TableName, pattern: string): boolean {
  if (pattern.startsWith("W#")) {
    const owner = (Object.entries(TABLE_WORLD_SUFFIXES) as Array<[TableName, string]>).find(([, suffix]) => pattern.endsWith(suffix));
    return owner === undefined ? TABLES[table].world !== "none" : owner[0] === table;
  }
  const literal = pattern.replace(/[*?].*$/, "");
  return (GLOBAL_PARTITION_PREFIXES[table] ?? []).some((prefix) => literal.startsWith(prefix) || prefix.startsWith(literal));
}

/** Arguments of `sst.aws.Dynamo`: only key attributes are declared, as DynamoDB requires. */
export interface DynamoTableArgs {
  readonly fields: Record<string, KeyType>;
  readonly primaryIndex: { readonly hashKey: string; readonly rangeKey: string };
  readonly globalIndexes: Record<string, { readonly hashKey: string; readonly rangeKey?: string; readonly projection: "all" | "keys-only" }>;
  readonly ttl?: string;
}

export function dynamoArgs(spec: TableSpec): DynamoTableArgs {
  const fields: Record<string, KeyType> = { [PARTITION_KEY]: "string", [SORT_KEY]: "string" };
  const globalIndexes: DynamoTableArgs["globalIndexes"] = {};
  for (const [name, { hashKey, rangeKey, projection }] of Object.entries(spec.indexes)) {
    for (const key of [hashKey, rangeKey]) if (key !== undefined) fields[key] = NUMBER_KEYS.has(key) ? "number" : "string";
    globalIndexes[name] = { hashKey, projection, ...(rangeKey === undefined ? {} : { rangeKey }) };
  }
  return { fields, primaryIndex: { hashKey: PARTITION_KEY, rangeKey: SORT_KEY }, globalIndexes, ...(spec.ttl ? { ttl: TTL_ATTRIBUTE } : {}) };
}

// ---- Table access ------------------------------------------------------------------------------

const TABLE_READ = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"] as const;

/**
 * DynamoDB actions per access level of infra/iam-capabilities.ts. `append` is `PutItem` on top of
 * the reads and never `UpdateItem`, `DeleteItem` or `BatchWriteItem` (ADR-0014; the CI boundary
 * denies those on Register, ComplianceTape and AuditLog anyway). No level grants `Scan`: a
 * world-fenced role could not use it (Null guard), and nobody else needs it.
 */
export const TABLE_ACTIONS: Readonly<Record<Access, readonly string[]>> = {
  read: TABLE_READ,
  append: [...TABLE_READ, "dynamodb:PutItem"],
  write: [...TABLE_READ, "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
};

export interface IamCondition {
  readonly test: string;
  readonly variable: string;
  readonly values: string[];
}

/** World fence of docs/architecture.md §14: every leading key matches a pattern, and there is one. */
export function leadingKeysConditions(patterns: readonly string[]): IamCondition[] {
  if (patterns.length === 0) throw new Error("A world fence needs at least one leading-key pattern.");
  return [
    { test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...patterns] },
    { test: "Null", variable: "dynamodb:LeadingKeys", values: ["false"] },
  ];
}

// ---- Buckets -----------------------------------------------------------------------------------

/** SST truncates longer logical names inside the bucket prefix the CI role is fenced to (infra/ci-spec.ts). */
export const LOGICAL_BUCKET_NAME_MAX = 16;

export const WORLD_ROOT_PREFIX = "W/";
export const QA_ROOT_PREFIX = "qa/";
export const UPLOAD_PREFIX = "up/";
export const LIVE_MEDIA_PREFIX = "wa/";
export const QUARANTINE_PREFIX = "quarantine/";

/** Days an object under a short-lived prefix lives (`qa/` everywhere, `up/` in Media). */
export const SHORT_LIVED_DAYS = 2;
export const CORS_MAX_AGE_SECONDS = 300;

export type CorsMethod = "GET" | "POST";

export interface BucketSpec {
  /** Fixed physical name (`browserBucketName`): the browser reaches it and the CSP names its host. */
  readonly fixed?: BrowserBucket;
  /** Methods the console may use from its origin; no CORS at all when absent. */
  readonly cors?: readonly CorsMethod[];
  /** Expiration of every object, in days; absent = the life of the stage. */
  readonly expireDays?: number;
  /** Prefixes whose objects live SHORT_LIVED_DAYS. */
  readonly shortLived: readonly string[];
}

/** Buckets of docs/architecture.md §6, keyed by the logical name every module links. */
export const BUCKETS = {
  Media: { fixed: "media", cors: ["GET", "POST"], expireDays: 90, shortLived: [QA_ROOT_PREFIX, UPLOAD_PREFIX] },
  Documents: { fixed: "documents", cors: ["GET"], shortLived: [QA_ROOT_PREFIX] },
  Emails: { fixed: "emails", cors: ["GET"], expireDays: 90, shortLived: [QA_ROOT_PREFIX] },
  Settlements: { shortLived: [QA_ROOT_PREFIX] },
  Exports: { expireDays: 7, shortLived: [] },
  Seed: { shortLived: [] },
} as const satisfies Record<BucketName, BucketSpec>;

export const BUCKET_NAMES = Object.keys(BUCKETS) as BucketName[];

/**
 * Prefixes of Media that GuardDuty scans: live WhatsApp media, simulator uploads and the world roots
 * (seed copies under `<root>/sim/`, QA uploads under `<root>/up/`). `quarantine/` is left out, so a
 * quarantined copy is not scanned (and reported) again.
 */
export const MEDIA_SCANNED_PREFIXES = [LIVE_MEDIA_PREFIX, UPLOAD_PREFIX, WORLD_ROOT_PREFIX, QA_ROOT_PREFIX] as const;

export interface BucketCorsArgs {
  readonly allowOrigins: string[];
  readonly allowMethods: CorsMethod[];
  readonly allowHeaders: string[];
  readonly exposeHeaders: string[];
  readonly maxAge: `${number} seconds`;
}

/**
 * CORS of a bucket: the exact origin of the console, only the methods it uses. A presigned GET read
 * with `fetch()` and a presigned POST of a form are simple requests, so no header is allowed.
 */
export function bucketCors(name: BucketName, origin: string): BucketCorsArgs | false {
  const spec: BucketSpec = BUCKETS[name];
  if (spec.cors === undefined) return false;
  return { allowOrigins: [origin], allowMethods: [...spec.cors], allowHeaders: [], exposeHeaders: [], maxAge: `${CORS_MAX_AGE_SECONDS} seconds` };
}

export interface LifecycleRule {
  readonly id: string;
  readonly status: "Enabled";
  readonly filter: { readonly prefix: string };
  readonly expiration: { readonly days: number };
}

/** Lifecycle of a bucket; S3 honours the shorter expiration where two rules overlap. */
export function lifecycleRules(name: BucketName): LifecycleRule[] {
  const spec: BucketSpec = BUCKETS[name];
  const rule = (id: string, prefix: string, days: number): LifecycleRule => ({ id, status: "Enabled", filter: { prefix }, expiration: { days } });
  const rules: LifecycleRule[] = spec.expireDays === undefined ? [] : [rule(`expire-all-${spec.expireDays}d`, "", spec.expireDays)];
  for (const prefix of spec.shortLived) rules.push(rule(`expire-${prefix.replace(/\/$/, "")}-${SHORT_LIVED_DAYS}d`, prefix, SHORT_LIVED_DAYS));
  return rules;
}

/** S3 actions per access level; listing is a separate grant fenced by `s3:prefix`. */
export const BUCKET_ACTIONS: Readonly<Record<Exclude<Access, "append">, readonly string[]>> = {
  read: ["s3:GetObject"],
  write: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
};

// ---- Register anchors --------------------------------------------------------------------------

/** 180 days (docs/architecture.md §12); the CI boundary denies changing it. */
export const ANCHOR_RETENTION_DAYS = 180;

/** Fixed name of the anchor log group (docs/architecture.md §1); the CI boundary fences it by name. */
export function anchorLogGroupName(app: string, stage: string): string {
  return `/${app}/${stage}/register-anchors`;
}

export interface AnchorGrant {
  readonly actions: readonly string[];
  /** Stream name pattern (`log-stream:<pattern>`); absent = the log group itself. */
  readonly streams?: string;
}

/**
 * Anchor access per kind of infra/iam-capabilities.ts. `CreateLogStream` is authorised on the log
 * group, not on the stream, so the QA streams are fenced where the events are written
 * (`PutLogEvents` on `log-stream:qa-*`); an empty stream proves nothing to the verifier.
 */
export const ANCHOR_ACCESS: Readonly<Record<AnchorAccess, readonly AnchorGrant[]>> = {
  write: [{ actions: ["logs:CreateLogStream"] }, { actions: ["logs:PutLogEvents"], streams: "*" }],
  "write-qa-streams": [{ actions: ["logs:CreateLogStream"] }, { actions: ["logs:PutLogEvents"], streams: "qa-*" }],
  read: [{ actions: ["logs:FilterLogEvents"] }],
};
