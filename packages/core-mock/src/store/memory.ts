// In-memory adapter of the core's store: the unit tests of the ledger and the local flows
// (`tests/flows`) run the same ledger as the Lambda over it. Same semantics as DynamoDB for what the
// ledger uses: consistent reads, sort-key order, `begins_with` prefixes, `ByOperationCode`,
// `WorldIndex`, and all-or-nothing conditional transactions.
import { type CoreStore, MAX_TRANSACTION_WRITES, type PutWrite, StoreConflictError, type StoredItem } from "./port";

export interface MemoryCoreStore extends CoreStore {
  /** Writes items as they are, without conditions (fixtures of the tests and the local flows). */
  seed(items: readonly StoredItem[]): void;
  /** Every item, sorted by key (assertions). */
  dump(): StoredItem[];
  /** Number of committed transactions (assertions on "nothing moved"). */
  readonly commits: number;
}

function keyOf(pk: string, sk: string): string {
  return `${pk}\u0000${sk}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function satisfied(write: PutWrite, existing: StoredItem | undefined): boolean {
  if (write.condition.kind === "absent") return existing === undefined;
  return existing !== undefined && (existing.version ?? 1) === write.condition.version;
}

export function createMemoryCoreStore(initial: readonly StoredItem[] = []): MemoryCoreStore {
  const items = new Map<string, StoredItem>();
  let commits = 0;

  const sorted = (): StoredItem[] => [...items.values()].sort((a, b) => (a.pk === b.pk ? (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0) : a.pk < b.pk ? -1 : 1));

  const store: MemoryCoreStore = {
    async get(pk, sk) {
      const item = items.get(keyOf(pk, sk));
      return item === undefined ? undefined : copy(item);
    },

    async query(pk, skPrefix = "") {
      return sorted()
        .filter((item) => item.pk === pk && item.sk.startsWith(skPrefix))
        .map(copy);
    },

    async queryByOperationCode(opCodeKey) {
      return sorted()
        .filter((item) => item.opCodeKey === opCodeKey)
        .map(copy);
    },

    async worldHasItems(worldId) {
      const prefix = `W#${worldId}#`;
      return [...items.values()].some((item) => item.pk.startsWith(prefix));
    },

    async transact(writes) {
      if (writes.length === 0) return;
      if (writes.length > MAX_TRANSACTION_WRITES) throw new RangeError(`a transaction holds at most ${MAX_TRANSACTION_WRITES} writes`);
      const keys = writes.map((write) => keyOf(write.item.pk, write.item.sk));
      if (new Set(keys).size !== keys.length) throw new RangeError("a transaction writes each item once");
      const failed = writes.flatMap((write, index) => (satisfied(write, items.get(keys[index] ?? "")) ? [] : [index]));
      if (failed.length > 0) throw new StoreConflictError(failed);
      writes.forEach((write, index) => items.set(keys[index] ?? "", copy(write.item)));
      commits += 1;
    },

    seed(fixtures) {
      for (const item of fixtures) items.set(keyOf(item.pk, item.sk), copy(item));
    },

    dump() {
      return sorted().map(copy);
    },

    get commits() {
      return commits;
    },
  };
  store.seed(initial);
  return store;
}
