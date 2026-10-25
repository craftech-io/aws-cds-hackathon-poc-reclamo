// In-memory engine of the storage port: what the local flows (`LF`), the UI server and the unit tests
// run the connector on. It keeps DynamoDB's semantics where the domain depends on them: conditions
// on missing attributes, all-or-nothing transactions with per-operation cancellation reasons, one
// operation per item in a transaction, sparse indexes, key order, append-only tables. Reads return
// copies, so a caller can never mutate what is stored.
//
// `beforeWrite` lets a test run a competing writer between a read and the commit of the code under
// test (a chain head that moves after it was read, docs/test-plan.md §3).
import { ConnectorError } from "@reclamo/shared";
import { TransactionCancelledError } from "../errors";
import {
  type BatchRequest,
  type GetOptions,
  type Key,
  type QueryPage,
  type QuerySpec,
  type StoredItem,
  type TableStore,
  type WriteOp,
  keyOf,
  normalizeWrite,
  validateBatch,
  validateTransaction,
  validateWrite,
} from "../store";
import { INDEXES, type TableName } from "../tables";
import { applyUpdate, compareSortValues, evaluate, matchesSort, stored } from "./evaluate";

export interface MemoryStoreOptions {
  /** Runs before every write or transaction is applied (after validation), with the operations. */
  readonly beforeWrite?: (ops: readonly WriteOp[]) => void | Promise<void>;
}

type Row = Record<string, unknown> & Key;

function rowId(key: Key): string {
  return `${key.pk}\u0000${key.sk}`;
}

// Like DynamoDB's `LastEvaluatedKey`: the position of the last item returned, so a page after a
// delete (a wipe that pages while it deletes) continues after that item, never skips one.
interface Position {
  readonly sort?: unknown;
  readonly pk: string;
  readonly sk: string;
}

function encodeCursor(position: Position): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): Position | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof Reflect.get(parsed, "pk") === "string" && typeof Reflect.get(parsed, "sk") === "string") return parsed as Position;
  } catch {
    // falls through to the validation error
  }
  throw new ConnectorError("VALIDATION", "invalid query cursor");
}

export class MemoryStore implements TableStore {
  private readonly tables = new Map<TableName, Map<string, Row>>();

  constructor(private readonly options: MemoryStoreOptions = {}) {}

  private table(name: TableName): Map<string, Row> {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = new Map();
      this.tables.set(name, rows);
    }
    return rows;
  }

  async get(table: TableName, key: Key, options: GetOptions = {}): Promise<StoredItem | undefined> {
    const row = this.table(table).get(rowId(key));
    if (!row) return undefined;
    const item = stored(row);
    const { attributes } = options;
    if (!attributes?.length) return item;
    return Object.fromEntries(Object.entries(item).filter(([name]) => attributes.includes(name))) as StoredItem;
  }

  async write(raw: WriteOp): Promise<StoredItem | undefined> {
    const op = normalizeWrite(raw);
    validateWrite(op);
    if (op.kind === "check") throw new ConnectorError("VALIDATION", "a condition check only exists inside a transaction", op.table);
    await this.options.beforeWrite?.([op]);
    const current = this.table(op.table).get(rowId(keyOf(op)));
    if (op.condition && !evaluate(op.condition, current)) throw new ConnectorError("CONFLICT", "the conditional request failed", op.table);
    const after = this.apply(op, current);
    return op.kind === "update" && after ? stored(after) : undefined;
  }

  async transact(raw: readonly WriteOp[]): Promise<void> {
    const ops = raw.map(normalizeWrite);
    validateTransaction(ops);
    await this.options.beforeWrite?.(ops);
    const reasons = ops.map((op) => {
      const current = this.table(op.table).get(rowId(keyOf(op)));
      return !op.condition || evaluate(op.condition, current) ? "None" : "ConditionalCheckFailed";
    });
    if (reasons.some((reason) => reason !== "None")) throw new TransactionCancelledError("CONFLICT", reasons, ops.find((_, index) => reasons[index] !== "None")?.table);
    for (const op of ops) this.apply(op, this.table(op.table).get(rowId(keyOf(op))));
  }

  async batchWrite(table: TableName, requests: readonly BatchRequest[]): Promise<void> {
    validateBatch(table, requests);
    const ops = requests.map((request): WriteOp => ("put" in request ? { kind: "put", table, item: request.put } : { kind: "delete", table, key: request.delete }));
    await this.options.beforeWrite?.(ops);
    for (const op of ops) this.apply(op, undefined);
  }

  private apply(op: WriteOp, current: Row | undefined): Row | undefined {
    const rows = this.table(op.table);
    const id = rowId(keyOf(op));
    switch (op.kind) {
      case "put": {
        const row = stored(op.item) as Row;
        rows.set(id, row);
        return row;
      }
      case "update": {
        const row = applyUpdate(current ?? { pk: op.key.pk, sk: op.key.sk }, op.update) as Row;
        rows.set(id, row);
        return row;
      }
      case "delete":
        rows.delete(id);
        return undefined;
      case "check":
        return current;
    }
  }

  async query(spec: QuerySpec): Promise<QueryPage> {
    const index = spec.index === undefined ? undefined : INDEXES[spec.table][spec.index];
    if (spec.index !== undefined && !index) throw new ConnectorError("VALIDATION", `${spec.table} has no index ${spec.index}`, spec.table);
    if (index && spec.consistent) throw new ConnectorError("VALIDATION", "a consistent read is not supported on a global secondary index", spec.table);
    const partitionAttribute = index ? index.partition : "pk";
    const sortAttribute = index ? index.sort : "sk";
    const matches = [...this.table(spec.table).values()].filter((row) => {
      if (row[partitionAttribute] !== spec.partition) return false;
      // A global secondary index is sparse: an item without its sort attribute is not in it.
      if (sortAttribute !== undefined && row[sortAttribute] === undefined) return false;
      return matchesSort(sortAttribute === undefined ? undefined : row[sortAttribute], spec.sort);
    });
    const direction = spec.descending ? -1 : 1;
    const order = (a: Position, b: Position): number => {
      const bySort = sortAttribute === undefined ? 0 : compareSortValues(a.sort, b.sort);
      return direction * (bySort !== 0 ? bySort : compareSortValues(`${a.pk}\u0000${a.sk}`, `${b.pk}\u0000${b.sk}`));
    };
    const positionOf = (row: Row): Position => ({ ...(sortAttribute === undefined ? {} : { sort: row[sortAttribute] }), pk: row.pk, sk: row.sk });
    const after = decodeCursor(spec.cursor);
    const remaining = matches.filter((row) => !after || order(positionOf(row), after) > 0).sort((a, b) => order(positionOf(a), positionOf(b)));
    const page = remaining.slice(0, spec.limit ?? remaining.length);
    const last = page[page.length - 1];
    const projected = index?.keysOnly ? page.map((row) => this.keysOf(row, index.partition, index.sort)) : page;
    return { items: projected.map((row) => stored(row) as StoredItem), ...(last && page.length < remaining.length ? { cursor: encodeCursor(positionOf(last)) } : {}) };
  }

  private keysOf(row: Row, partition: string, sort: string | undefined): Row {
    return { pk: row.pk, sk: row.sk, [partition]: row[partition], ...(sort ? { [sort]: row[sort] } : {}) };
  }

  /** Every stored item of a table, in key order (tests and the local UI server's snapshot). */
  dump(table: TableName): StoredItem[] {
    return [...this.table(table).values()].sort((a, b) => compareSortValues(`${a.pk}\u0000${a.sk}`, `${b.pk}\u0000${b.sk}`)).map((row) => stored(row));
  }

  /** Writes items as they are, with no condition and no validation (seeding a test). */
  load(table: TableName, items: readonly StoredItem[]): void {
    for (const item of items) this.table(table).set(rowId(item), stored(item) as Row);
  }
}
