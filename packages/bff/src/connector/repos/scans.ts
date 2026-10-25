// The scan registry of `Media` (`Runtime/W#<w>#SCANOBJ#<sha256(announceKey)[0:32]>`,
// docs/architecture.md §6): written before an object can exist, so a GuardDuty result that arrives
// before the message still finds it. Its two halves meet with conditional updates, in any order:
// the result (`attribute_not_exists(result)`), the message binding (`attribute_not_exists(messageId)`,
// with the quiescence `PENDING#…SCAN#` in the same transaction) and a single resolution
// (`attribute_not_exists(resolvedAtReal)`). media-intake/resolve.ts decides what each outcome means.
import { ConnectorError } from "@reclamo/shared";
import { Pending } from "../../domain/runtime";
import { ScanObject, type ScanResultStatus } from "../../domain/runtime-claims";
import { sha256Hex } from "../../lib/crypto";
import { type NewOf, type RepoContext, decode, decodeOptional, encode, validInput } from "../codec";
import { isConflict } from "../errors";
import { keys } from "../keys";
import { type Key, type StoredItem, type WriteOp, cond } from "../store";
import { expiry } from "../ttl";

const TABLE = "Runtime" as const;

/** The registry id of an announce key: the first 32 hex characters of its SHA-256. */
export function scanObjectId(announceKey: string): string {
  return sha256Hex(announceKey).slice(0, 32);
}

export function scansRepo(ctx: RepoContext) {
  const key = (worldId: string, announceKey: string): Key => keys.runtime(worldId, "SCANOBJ", scanObjectId(announceKey));
  // Every change pushes the TTL one hour past it (docs/architecture.md §5).
  const touched = (worldId: string) => ({ updatedAt: ctx.now().toISOString(), ...expiry("scanObject", worldId, ctx.now()) });
  const get = async (worldId: string, announceKey: string): Promise<ScanObject | undefined> =>
    decodeOptional(ScanObject, await ctx.store.get(TABLE, key(worldId, announceKey), { consistent: true }), TABLE);
  const update = async (worldId: string, announceKey: string, op: Omit<Extract<WriteOp, { kind: "update" }>, "kind" | "table" | "key">): Promise<ScanObject | undefined> => {
    try {
      const after = await ctx.store.write({ kind: "update", table: TABLE, key: key(worldId, announceKey), ...op });
      return decode(ScanObject, after as StoredItem, TABLE);
    } catch (error) {
      if (isConflict(error)) return undefined;
      throw error;
    }
  };

  return {
    get,

    /** The announcement, before the presigned POST, the media download or the seed copy. */
    async announce(scan: NewOf<typeof ScanObject>): Promise<void> {
      const value = validInput(ScanObject, scan, TABLE);
      const item = encode(value, { entity: "ScanObject", key: key(value.worldId, value.announceKey), worldId: value.worldId, retention: "scanObject", now: ctx.now() });
      await ctx.store.write({ kind: "put", table: TABLE, item, condition: cond.absent() });
    },

    /** The real key of a live object found under its announced prefix; `false` if another key is recorded. */
    async setS3Key(worldId: string, announceKey: string, s3Key: string): Promise<boolean> {
      const after = await update(worldId, announceKey, {
        condition: cond.and(cond.present(), cond.or(cond.notExists("s3Key"), cond.eq("s3Key", s3Key))),
        update: { set: { s3Key, ...touched(worldId) } },
      });
      return after !== undefined;
    },

    /** Records the scan result once; `undefined` when there is no registry (an orphan) or a result already. */
    async recordResult(worldId: string, announceKey: string, result: { status: ScanResultStatus; objectKey: string }): Promise<ScanObject | undefined> {
      return update(worldId, announceKey, {
        condition: cond.and(cond.present(), cond.notExists("result")),
        update: { set: { result: result.status, resultAtReal: ctx.now().toISOString(), ...touched(worldId) }, setIfNotExists: { s3Key: result.objectKey } },
      });
    },

    /**
     * Binds the message and opens the quiescence pending in one transaction, then re-reads the record
     * (a transaction returns no values). `undefined` when a message was already bound.
     */
    async bind(worldId: string, announceKey: string, binding: { messageId: string; customerId: string; pending: NewOf<typeof Pending> }): Promise<ScanObject | undefined> {
      const pending = validInput(Pending, binding.pending, TABLE);
      if (pending.worldId !== worldId || pending.kind !== "SCAN") throw new ConnectorError("VALIDATION", "a scan binding opens a SCAN pending of its own world", TABLE);
      const now = ctx.now();
      const ops: WriteOp[] = [
        {
          kind: "update",
          table: TABLE,
          key: key(worldId, announceKey),
          condition: cond.and(cond.present(), cond.notExists("messageId")),
          update: { set: { messageId: binding.messageId, customerId: binding.customerId, boundAtReal: now.toISOString(), ...touched(worldId) } },
        },
        {
          kind: "put",
          table: TABLE,
          item: encode(pending, { entity: "Pending", key: keys.pending(worldId, "SCAN", pending.pendingId), worldId, retention: "pending", now }),
          condition: cond.absent(),
        },
      ];
      try {
        await ctx.store.transact(ops);
      } catch (error) {
        if (isConflict(error)) return undefined;
        throw error;
      }
      return get(worldId, announceKey);
    },

    /** The single resolution of a record with both halves; `false` when someone already resolved it. */
    async markResolved(worldId: string, announceKey: string, resolution: "RESULT_FIRST" | "BIND_FIRST"): Promise<boolean> {
      const after = await update(worldId, announceKey, {
        condition: cond.and(cond.exists("result"), cond.exists("messageId"), cond.notExists("resolvedAtReal")),
        update: { set: { resolvedAtReal: ctx.now().toISOString(), resolution, ...touched(worldId) } },
      });
      return after !== undefined;
    },
  };
}

export type ScansRepo = ReturnType<typeof scansRepo>;
