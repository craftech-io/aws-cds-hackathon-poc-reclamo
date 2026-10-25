// Physical layout of the tables the connector reads and writes (docs/architecture.md §5): every
// table has a string partition key `pk` and a string sort key `sk`, and every global secondary index
// is declared here once with its partition and sort attribute. The DynamoDB adapter uses this list
// to name the attributes of a query; the in-memory adapter uses it to build the same indexes from
// the items. infra/storage-tables.ts declares the same names (WP-07).
//
// Every partition value of a world starts with `W#<worldId>#`, in the tables and in the indexes the
// world-fenced roles query, so `dynamodb:LeadingKeys` fences them (docs/architecture.md §14). The
// only index partitions without a world are `BySub` (the pre-token trigger), `ByProviderMessageId`
// and the tape's `ByMessage` (ids that are unique across worlds, read by unfenced roles).
import type { TableName } from "../lib/resource";

export type { TableName } from "../lib/resource";

export const KEY_ATTRIBUTES = ["pk", "sk"] as const;

export type SortType = "S" | "N";

export interface IndexDefinition {
  readonly partition: string;
  readonly sort?: string;
  readonly sortType?: SortType;
  /** Only the keys are projected (WorldIndex): a query returns keys, never data. */
  readonly keysOnly?: boolean;
}

/** `WorldIndex` on every mutable table the world factory enumerates (docs/architecture.md §10). */
const WORLD_INDEX: IndexDefinition = { partition: "worldIndexKey", sort: "worldIndexSort", keysOnly: true };

export const INDEXES: Readonly<Record<TableName, Readonly<Record<string, IndexDefinition>>>> = {
  Worlds: {
    BySub: { partition: "cognitoSubKey" },
    // Sparse, only `gs-*` worlds: the self-signup queue that only WorldJanitor reads.
    GuestIndex: { partition: "guestIndexKey", sort: "guestIndexSort" },
  },
  // The mocks' own tables: their stores write them; the world factory enumerates and wipes them.
  Core: {
    ByPhone: { partition: "phoneHash" },
    ByOperationCode: { partition: "opCodeKey" },
    ByCvu: { partition: "cvuKey" },
    WorldIndex: WORLD_INDEX,
  },
  Networks: {
    WorldIndex: WORLD_INDEX,
  },
  Complaints: {
    InboxIndex: { partition: "inboxKey", sort: "deadlineSort" },
    ByCustomer: { partition: "customerKey", sort: "filedAtSort" },
    ByNumber: { partition: "numberKey" },
    ApprovalIndex: { partition: "approvalKey", sort: "requestedAtSort" },
    WorldIndex: WORLD_INDEX,
  },
  Register: {
    ByComplaint: { partition: "complaintKey", sort: "seq", sortType: "N" },
  },
  Timers: {
    ClockDue: { partition: "clockDueKey", sort: "dueSort" },
    ByOwner: { partition: "ownerIndexKey", sort: "dueSort" },
    WorldIndex: WORLD_INDEX,
  },
  Conversations: {
    ByProviderMessageId: { partition: "providerMessageId" },
    ByCustomerSent: { partition: "customerSentKey", sort: "sentAtSort" },
    EmailIndex: { partition: "emailIndexKey", sort: "sentAtSort" },
    WorldIndex: WORLD_INDEX,
  },
  ComplianceTape: {
    ByComplaint: { partition: "complaintKey", sort: "atSort" },
    ByDecision: { partition: "decisionKey", sort: "atSort" },
    ByMessage: { partition: "messageId" },
    BySeq: { partition: "seqKey", sort: "seq", sortType: "N" },
  },
  AuditLog: {
    ByRef: { partition: "refIndexKey", sort: "ts" },
    ByAction: { partition: "actionKey", sort: "ts" },
  },
  Reference: {},
  Runtime: {},
  Metrics: {},
  // Keys only: uniqueness, recovery and deletion never read a lead's contact data through an index.
  Leads: {
    ByEmailHash: { partition: "emailHashKey", keysOnly: true },
    BySub: { partition: "subKey", keysOnly: true },
  },
};

/** Tables that only ever receive `PutItem` (docs/architecture.md §5, ADR-0014). */
export const APPEND_ONLY_TABLES: ReadonlySet<TableName> = new Set<TableName>(["Register", "ComplianceTape", "AuditLog"]);

// Index attributes that are also domain fields: they stay in what the connector returns.
const DOMAIN_INDEX_ATTRIBUTES: ReadonlySet<string> = new Set(["cognitoSubKey", "phoneHash", "providerMessageId", "messageId", "seq", "ts"]);

/**
 * Attributes that exist only for the storage (keys, index keys, entity tag, TTL): the connector adds
 * them when it writes and strips them before a domain schema parses what it read.
 */
export const STORAGE_ATTRIBUTES: ReadonlySet<string> = new Set(
  [
    ...KEY_ATTRIBUTES,
    "entity",
    "expiresAt",
    ...Object.values(INDEXES).flatMap((indexes) => Object.values(indexes).flatMap((index) => [index.partition, ...(index.sort ? [index.sort] : [])])),
  ].filter((name) => !DOMAIN_INDEX_ATTRIBUTES.has(name)),
);
