// The one port the core's ledger writes through (table `Core`, docs/architecture.md §5). Two
// adapters implement it: store/dynamo.ts in the Lambda and store/memory.ts in the unit tests and
// the local flows, so the ledger runs the same code with and without AWS.
//
// Every change is one transaction of conditional puts: `absent` for an item that must not exist
// yet (a natural-key claim, a payment, a credit note, a movement) and `version` for an item read
// before (optimistic lock). A failed condition cancels the whole transaction, so money never moves
// halfway.

/** A raw item of the table: string `pk` and `sk` plus its attributes. */
export interface StoredItem {
  readonly pk: string;
  readonly sk: string;
  readonly [attribute: string]: unknown;
}

export type PutCondition = { readonly kind: "absent" } | { readonly kind: "version"; readonly version: number };

export interface PutWrite {
  readonly item: StoredItem;
  readonly condition: PutCondition;
}

/** Partition of the `ByOperationCode` index (`W#<worldId>#<network>#<operationCode>`). */
export type OperationCodeKey = string;

export interface CoreStore {
  /** Strongly consistent read of one item. */
  get(pk: string, sk: string): Promise<StoredItem | undefined>;
  /** Every item of a partition, optionally under a sort-key prefix, in sort-key order (consistent). */
  query(pk: string, skPrefix?: string): Promise<StoredItem[]>;
  /** Payments filed under an operation code (`ByOperationCode`). */
  queryByOperationCode(opCodeKey: OperationCodeKey): Promise<StoredItem[]>;
  /** Whether the world has any item (`WorldIndex`, one key). */
  worldHasItems(worldId: string): Promise<boolean>;
  /** All the puts or none; a failed condition throws `StoreConflictError`. */
  transact(writes: readonly PutWrite[]): Promise<void>;
}

/** A condition of the transaction failed: another writer got there first. */
export class StoreConflictError extends Error {
  override readonly name = "StoreConflictError";
  constructor(
    /** Positions of the writes whose condition failed, when the store can tell. */
    readonly failed: readonly number[],
    options?: ErrorOptions,
  ) {
    super(`transaction cancelled by a failed condition at ${failed.length === 0 ? "an unknown write" : failed.join(", ")}`, options);
  }
}

/** The store could not answer (throttling, timeout, outage): the mock answers 503. */
export class StoreUnavailableError extends Error {
  override readonly name = "StoreUnavailableError";
}

/** DynamoDB's limit on one `TransactWriteItems`. */
export const MAX_TRANSACTION_WRITES = 100;
