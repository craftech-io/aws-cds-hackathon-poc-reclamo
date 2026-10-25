// In-memory `NetworkStore` over raw items, with the DynamoDB adapter's semantics (conditional,
// all-or-nothing writes). Unit tests and the local flows seed it with the same raw items the world
// factory writes (`items.*`), so what runs in process is what runs in the Lambda.
import { Fault } from "../faults";
import {
  FaultsItem,
  type Key,
  NetworkWorld,
  ReversalClaim,
  StoredBatch,
  StoredLine,
  StoredTransfer,
  fromRaw,
  items,
  keys,
} from "./items";
import type { CollectionWrite, NetworkStore, Publication, SettlementObjects, WriteOutcome } from "./port";

type Raw = Record<string, unknown>;

export interface MemoryNetworkStore extends NetworkStore {
  /** Writes raw items as the world factory does (a `PutItem` each). */
  putRaw(...raws: Raw[]): void;
  /** Every raw item, for assertions. */
  dump(): Raw[];
}

function id(key: Key): string {
  return `${key.pk}\u0000${key.sk}`;
}

function keyOf(raw: Raw): Key {
  const { pk, sk } = raw;
  if (typeof pk !== "string" || typeof sk !== "string") throw new TypeError("a raw item carries string pk and sk");
  return { pk, sk };
}

/** A rewritten item keeps the creation stamp of the one it replaces. */
function keepCreatedAt(previous: Raw | undefined, next: Raw): Raw {
  return previous?.createdAt === undefined ? next : { ...next, createdAt: previous.createdAt };
}

export function createMemoryNetworkStore(options: { realNow?: () => Date } = {}): MemoryNetworkStore {
  const rows = new Map<string, Raw>();
  const realNow = options.realNow ?? (() => new Date("2026-10-07T13:10:00.000Z"));

  const get = (key: Key): Raw | undefined => {
    const raw = rows.get(id(key));
    return raw === undefined ? undefined : structuredClone(raw);
  };
  const put = (raw: Raw): void => void rows.set(id(keyOf(raw)), structuredClone(raw));
  const query = (pk: string, from: string, to: string): Raw[] =>
    [...rows.values()]
      .filter((raw) => raw.pk === pk && typeof raw.sk === "string" && raw.sk >= from && raw.sk <= to)
      .sort((a, b) => String(a.sk).localeCompare(String(b.sk)))
      .map((raw) => structuredClone(raw));
  const versionOf = (key: Key): number | undefined => {
    const version = get(key)?.version;
    return typeof version === "number" ? version : undefined;
  };

  return {
    putRaw(...raws) {
      for (const raw of raws) put(raw);
    },
    dump: () => [...rows.values()].map((raw) => structuredClone(raw)),

    async getWorld(worldId) {
      const raw = get(keys.config(worldId));
      return raw === undefined ? undefined : fromRaw(NetworkWorld, raw);
    },
    async getFaults(worldId) {
      const raw = get(keys.faults(worldId));
      return raw === undefined ? [] : fromRaw(FaultsItem, raw).faults.map((fault) => Fault.parse(fault));
    },
    async getBatch(worldId, network, businessDate) {
      const raw = get(keys.batch(worldId, network, businessDate));
      return raw === undefined ? undefined : fromRaw(StoredBatch, raw);
    },
    async listBatches(worldId, network, from, to) {
      return query(keys.network(worldId, network), keys.batch(worldId, network, from).sk, keys.batch(worldId, network, to).sk).map((raw) => fromRaw(StoredBatch, raw));
    },
    async listLines(worldId, network, businessDate) {
      const start = keys.linePrefix(businessDate);
      return query(keys.network(worldId, network), start, `${start}￿`).map((raw) => fromRaw(StoredLine, raw));
    },
    async getCodeClaim(worldId, network, operationCode) {
      const raw = get(keys.operationCode(worldId, network, operationCode));
      return raw === undefined ? undefined : fromRaw(StoredLine, raw);
    },
    async writeCollection(write: CollectionWrite): Promise<WriteOutcome> {
      const batchKey = keys.batch(write.worldId, write.network, write.businessDate);
      const stored = get(batchKey);
      if ("create" in write.batch) {
        if (stored !== undefined) return "STALE";
      } else if (stored === undefined || stored.status !== "PENDING" || stored.version !== write.batch.expectVersion) {
        return "STALE";
      }
      if (write.lines.some((line) => get(keys.operationCode(write.worldId, line.line.network, line.line.operationCode)) !== undefined)) return "CODE_TAKEN";
      const now = realNow();
      if ("create" in write.batch) put(items.batch(write.batch.create, now));
      else if (stored !== undefined) put({ ...stored, version: write.batch.expectVersion + 1, updatedAt: now.toISOString() });
      for (const line of write.lines) {
        put(items.line(line, now));
        put(items.operationCode(line, now));
      }
      return "OK";
    },
    async deferBatch(batch, publishAtSim) {
      const key = keys.batch(batch.worldId, batch.network, batch.businessDate);
      const stored = get(key);
      if (stored === undefined || stored.status !== "PENDING" || stored.version !== batch.version) return "STALE";
      put({ ...stored, publishAtSim, deferred: true, version: batch.version + 1, updatedAt: realNow().toISOString() });
      return "OK";
    },
    async markPublished(batch, publication: Publication) {
      const key = keys.batch(batch.worldId, batch.network, batch.businessDate);
      const stored = get(key);
      if (stored === undefined || stored.status !== "PENDING" || stored.version !== batch.version) return "STALE";
      put({ ...stored, ...publication, status: "PUBLISHED", version: batch.version + 1, updatedAt: realNow().toISOString() });
      return "OK";
    },
    async getTransfer(worldId, transferId) {
      const raw = get(keys.transfer(worldId, transferId));
      return raw === undefined ? undefined : fromRaw(StoredTransfer, raw);
    },
    async updateTransfer(next, expectVersion) {
      const key = keys.transfer(next.worldId, next.transferId);
      if (versionOf(key) !== expectVersion) return "STALE";
      put(keepCreatedAt(get(key), items.transfer({ ...next, version: expectVersion + 1 }, realNow())));
      return "OK";
    },
    async getReversalClaim(worldId, transferId) {
      const raw = get(keys.reversalClaim(worldId, transferId));
      return raw === undefined ? undefined : fromRaw(ReversalClaim, raw);
    },
    async reverseTransfer(claim, next, expectVersion) {
      if (get(keys.reversalClaim(claim.worldId, claim.transferId)) !== undefined) return "CODE_TAKEN";
      const key = keys.transfer(next.worldId, next.transferId);
      if (versionOf(key) !== expectVersion) return "STALE";
      const now = realNow();
      put(items.reversalClaim(claim, now));
      put(keepCreatedAt(get(key), items.transfer({ ...next, version: expectVersion + 1 }, now)));
      return "OK";
    },
  };
}

/** In-memory `Settlements` bucket. */
export function createMemorySettlementObjects(): SettlementObjects & { readonly objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async put(key, body) {
      objects.set(key, body);
    },
  };
}
