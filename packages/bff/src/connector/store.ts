// The storage port under the connector: a small, typed description of DynamoDB's write, read and
// query operations that two engines execute, `DynamoStore` (dynamo/engine.ts, the AWS SDK) and
// `MemoryStore` (memory/engine.ts, the local flows and unit tests). The use-case methods of the
// connector (repos/) are written once over this port, so the condition that guards a transition is
// the same object whether it runs against DynamoDB or in memory, and the memory engine evaluates it
// with DynamoDB's semantics (missing attribute, nested paths, transaction cancellation).
//
// Paths are dotted attribute names (`answer.inFlight`); no attribute of this app contains a dot.
import { ConnectorError } from "@reclamo/shared";
import { APPEND_ONLY_TABLES, type TableName } from "./tables";

export interface Key {
  readonly pk: string;
  readonly sk: string;
}

/** An item as stored: its key plus plain data (strings, numbers, booleans, lists, maps, string sets). */
export type StoredItem = Key & Readonly<Record<string, unknown>>;

export type Scalar = string | number | boolean;

/** DynamoDB's type descriptors that `attribute_type` checks: string, number, list, map, string set. */
export type AttributeType = "S" | "N" | "L" | "M" | "SS";

export type Condition =
  | { readonly op: "exists"; readonly path: string }
  | { readonly op: "notExists"; readonly path: string }
  | { readonly op: "eq"; readonly path: string; readonly value: unknown }
  | { readonly op: "lt" | "le" | "gt" | "ge"; readonly path: string; readonly value: string | number }
  | { readonly op: "in"; readonly path: string; readonly values: readonly Scalar[] }
  | { readonly op: "beginsWith"; readonly path: string; readonly value: string }
  | { readonly op: "contains"; readonly path: string; readonly value: Scalar }
  | { readonly op: "attributeType"; readonly path: string; readonly type: AttributeType }
  | { readonly op: "and" | "or"; readonly conditions: readonly Condition[] }
  | { readonly op: "not"; readonly condition: Condition };

/** Condition builders, so a repository reads like the rule it enforces. */
export const cond = {
  exists: (path: string): Condition => ({ op: "exists", path }),
  notExists: (path: string): Condition => ({ op: "notExists", path }),
  eq: (path: string, value: unknown): Condition => ({ op: "eq", path, value }),
  lt: (path: string, value: string | number): Condition => ({ op: "lt", path, value }),
  le: (path: string, value: string | number): Condition => ({ op: "le", path, value }),
  gt: (path: string, value: string | number): Condition => ({ op: "gt", path, value }),
  ge: (path: string, value: string | number): Condition => ({ op: "ge", path, value }),
  in: (path: string, values: readonly Scalar[]): Condition => ({ op: "in", path, values }),
  beginsWith: (path: string, value: string): Condition => ({ op: "beginsWith", path, value }),
  contains: (path: string, value: Scalar): Condition => ({ op: "contains", path, value }),
  attributeType: (path: string, type: AttributeType): Condition => ({ op: "attributeType", path, type }),
  and: (...conditions: Condition[]): Condition => (conditions.length === 1 && conditions[0] ? conditions[0] : { op: "and", conditions }),
  or: (...conditions: Condition[]): Condition => (conditions.length === 1 && conditions[0] ? conditions[0] : { op: "or", conditions }),
  not: (condition: Condition): Condition => ({ op: "not", condition }),
  /** The item does not exist yet (`attribute_not_exists(pk)`): every create and every append. */
  absent: (): Condition => ({ op: "notExists", path: "pk" }),
  /** The item exists (`attribute_exists(pk)`). */
  present: (): Condition => ({ op: "exists", path: "pk" }),
};

export interface UpdateSpec {
  /** `SET path = value`. The parent of a nested path must exist, as in DynamoDB. */
  readonly set?: Readonly<Record<string, unknown>>;
  /** `SET path = if_not_exists(path, value)`. */
  readonly setIfNotExists?: Readonly<Record<string, unknown>>;
  /** `SET path = list_append(if_not_exists(path, []), values)`. */
  readonly append?: Readonly<Record<string, readonly unknown[]>>;
  /** `ADD path value`: a number, or elements of a string set. */
  readonly add?: Readonly<Record<string, number | readonly string[]>>;
  /** `DELETE path values` from a string set; an empty set disappears. */
  readonly deleteFromSet?: Readonly<Record<string, readonly string[]>>;
  /** `REMOVE path`. */
  readonly remove?: readonly string[];
}

export type WriteOp =
  | { readonly kind: "put"; readonly table: TableName; readonly item: StoredItem; readonly condition?: Condition }
  | { readonly kind: "update"; readonly table: TableName; readonly key: Key; readonly update: UpdateSpec; readonly condition?: Condition }
  | { readonly kind: "delete"; readonly table: TableName; readonly key: Key; readonly condition?: Condition }
  | { readonly kind: "check"; readonly table: TableName; readonly key: Key; readonly condition: Condition };

export type SortCondition =
  | { readonly op: "eq" | "lt" | "le" | "gt" | "ge"; readonly value: string | number }
  | { readonly op: "beginsWith"; readonly value: string }
  | { readonly op: "between"; readonly low: string | number; readonly high: string | number };

export interface QuerySpec {
  readonly table: TableName;
  /** A global secondary index of the table (tables.ts); the table itself when absent. */
  readonly index?: string;
  /** Value of the partition attribute (`pk`, or the index's partition attribute). */
  readonly partition: string;
  /** Condition on the sort attribute (`sk`, or the index's sort attribute). */
  readonly sort?: SortCondition;
  readonly limit?: number;
  readonly descending?: boolean;
  /** Strongly consistent read; only on the table, never on an index. */
  readonly consistent?: boolean;
  /** Opaque position returned by the previous page. */
  readonly cursor?: string;
}

export interface QueryPage {
  readonly items: readonly StoredItem[];
  readonly cursor?: string;
}

export interface GetOptions {
  readonly consistent?: boolean;
  /**
   * Only these top-level attributes (`ProjectionExpression`, `Select SPECIFIC_ATTRIBUTES`): a role
   * whose IAM allows only some attributes of an item (`dynamodb:Attributes`) reads with this.
   */
  readonly attributes?: readonly string[];
}

/** One request of a batch: an unconditional put or delete (`BatchWriteItem`). */
export type BatchRequest = { readonly put: StoredItem } | { readonly delete: Key };

export interface TableStore {
  get(table: TableName, key: Key, options?: GetOptions): Promise<StoredItem | undefined>;
  /** One operation; an `update` returns the item after the update, the others `undefined`. */
  write(op: WriteOp): Promise<StoredItem | undefined>;
  /** All or nothing (`TransactWriteItems`); a failed condition cancels the whole transaction. */
  transact(ops: readonly WriteOp[]): Promise<void>;
  query(spec: QuerySpec): Promise<QueryPage>;
  /**
   * Unconditional puts and deletes of one table in batches of 25 (the world factory's blocks and its
   * wipe). Never on an append-only table: IAM denies `BatchWriteItem` there for every role.
   */
  batchWrite(table: TableName, requests: readonly BatchRequest[]): Promise<void>;
}

/** DynamoDB's limit of requests in one `BatchWriteItem`. */
export const MAX_BATCH_REQUESTS = 25;

/** Checks shared by both engines before a batch: a mutable table, string keys, one request per item. */
export function validateBatch(table: TableName, requests: readonly BatchRequest[]): void {
  if (APPEND_ONLY_TABLES.has(table)) throw new ConnectorError("VALIDATION", `${table} is append-only: no batch writes`, table);
  const seen = new Set<string>();
  for (const request of requests) {
    const key = "put" in request ? request.put : request.delete;
    if (typeof key.pk !== "string" || typeof key.sk !== "string") throw new ConnectorError("VALIDATION", "an item needs string pk and sk", table);
    const id = `${key.pk}\u0000${key.sk}`;
    if (seen.has(id)) throw new ConnectorError("VALIDATION", "a batch cannot touch the same item twice", table);
    seen.add(id);
  }
}

/** DynamoDB's limit of operations in one `TransactWriteItems`. */
export const MAX_TRANSACTION_OPS = 100;

function segmentsOf(path: string): string[] {
  return path.split(".");
}

function overlaps(a: string, b: string): boolean {
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  const shortest = Math.min(left.length, right.length);
  for (let index = 0; index < shortest; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** Every path an update touches, in clause order. */
export function updatePaths(update: UpdateSpec): string[] {
  return [
    ...Object.keys(update.set ?? {}),
    ...Object.keys(update.setIfNotExists ?? {}),
    ...Object.keys(update.append ?? {}),
    ...Object.keys(update.add ?? {}),
    ...Object.keys(update.deleteFromSet ?? {}),
    ...(update.remove ?? []),
  ];
}

/**
 * Rules DynamoDB enforces on an update, checked before either engine runs it: no key attribute, no
 * two clauses on overlapping paths, `ADD`/`DELETE` only on top-level attributes, at least one clause.
 */
export function validateUpdate(table: TableName, update: UpdateSpec): void {
  const paths = updatePaths(update);
  if (paths.length === 0) throw new ConnectorError("VALIDATION", "an update needs at least one clause", table);
  for (const path of paths) {
    if (path === "" || segmentsOf(path).some((segment) => segment === "")) throw new ConnectorError("VALIDATION", `invalid path "${path}"`, table);
    if (path === "pk" || path === "sk") throw new ConnectorError("VALIDATION", "key attributes cannot be updated", table);
  }
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const a = paths[i] as string;
      const b = paths[j] as string;
      if (overlaps(a, b)) throw new ConnectorError("VALIDATION", `two clauses touch overlapping paths "${a}" and "${b}"`, table);
    }
  }
  for (const path of [...Object.keys(update.add ?? {}), ...Object.keys(update.deleteFromSet ?? {})]) {
    if (path.includes(".")) throw new ConnectorError("VALIDATION", `ADD and DELETE apply to top-level attributes, not "${path}"`, table);
  }
  for (const [path, value] of Object.entries(update.add ?? {})) {
    if (Array.isArray(value) && value.length === 0) throw new ConnectorError("VALIDATION", `ADD of an empty set on "${path}"`, table);
  }
  for (const [path, value] of Object.entries(update.deleteFromSet ?? {})) {
    if (value.length === 0) throw new ConnectorError("VALIDATION", `DELETE of an empty set on "${path}"`, table);
  }
}

/**
 * `Register`, `ComplianceTape` and `AuditLog` only ever receive a `PutItem` that cannot overwrite
 * (ADR-0014): IAM denies the rest for every role; the connector refuses to even build it.
 */
export function assertAppendOnly(op: WriteOp): void {
  if (!APPEND_ONLY_TABLES.has(op.table)) return;
  if (op.kind === "check") return;
  if (op.kind !== "put") throw new ConnectorError("VALIDATION", `${op.table} is append-only: ${op.kind} is not allowed`, op.table);
  if (!op.condition || op.condition.op !== "notExists" || op.condition.path !== "pk") {
    throw new ConnectorError("VALIDATION", `${op.table} is append-only: a put must carry attribute_not_exists(pk)`, op.table);
  }
}

/** Checks shared by both engines before they run a transaction. */
export function validateTransaction(ops: readonly WriteOp[]): void {
  if (ops.length === 0) throw new ConnectorError("VALIDATION", "a transaction needs at least one operation");
  if (ops.length > MAX_TRANSACTION_OPS) throw new ConnectorError("VALIDATION", `a transaction takes at most ${MAX_TRANSACTION_OPS} operations`);
  const seen = new Set<string>();
  for (const op of ops) {
    validateWrite(op);
    const key = keyOf(op);
    const id = `${op.table}\u0000${key.pk}\u0000${key.sk}`;
    if (seen.has(id)) throw new ConnectorError("VALIDATION", "a transaction cannot touch the same item twice", op.table);
    seen.add(id);
  }
}

function defined(values: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
  if (!values) return undefined;
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * Drops `undefined` values from `SET` clauses (an optional field left out is not a change; removing
 * an attribute is always an explicit `REMOVE`) and from put items, as the DocumentClient does with
 * `removeUndefinedValues`. Both engines run the normalized operation.
 */
export function normalizeWrite(op: WriteOp): WriteOp {
  if (op.kind === "put") return { ...op, item: defined(op.item) as StoredItem };
  if (op.kind !== "update") return op;
  const { set, setIfNotExists, ...rest } = op.update;
  const normalized: UpdateSpec = { ...rest, ...(defined(set) ? { set: defined(set) } : {}), ...(defined(setIfNotExists) ? { setIfNotExists: defined(setIfNotExists) } : {}) };
  return { ...op, update: normalized };
}

/** Checks shared by both engines before they run one operation. */
export function validateWrite(op: WriteOp): void {
  assertAppendOnly(op);
  if (op.kind === "update") validateUpdate(op.table, op.update);
  if (op.kind === "put" && (typeof op.item.pk !== "string" || typeof op.item.sk !== "string")) {
    throw new ConnectorError("VALIDATION", "an item needs string pk and sk", op.table);
  }
}

/** The key of the item an operation targets. */
export function keyOf(op: WriteOp): Key {
  return op.kind === "put" ? { pk: op.item.pk, sk: op.item.sk } : op.key;
}
