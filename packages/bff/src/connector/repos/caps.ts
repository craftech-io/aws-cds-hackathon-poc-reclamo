// Abuse caps on the REAL clock (docs/architecture.md §13): the guest drives the simulated clock, so
// "+1 h" never opens a new bucket. One counter per bucket, incremented with `ADD` only while it is
// below its limit, so the count never passes the cap however many writers race:
//
//   W#<w>#RATE#<phoneHash>#<realHour>        messages per sender per real hour
//   W#<w>#TURNCAP#<realHour|realDay>         turns per world
//   W#<w>#IMGCAP#<customerId>#<realDay>      image reads per conversation per real day
//   W#<w>#RESETCAP#<realDay>                 resets of a self-signup world per real day (worlds/reset.ts)
//   GLOBALCAP#<PUBLIC|QA>#<realHour|realDay> turns and image reads of all public (or QA) worlds
//
// And the identity challenge ledger, `W#<w>#CHALLENGE#<customerId>`: failures of the customer in the
// last 24 real hours (any session, complaint or conversation) and the lock only staff lifts.
import { ConnectorError } from "@reclamo/shared";
import { ChallengeLedger, CapCounter } from "../../domain/runtime-claims";
import { type RepoContext, decode, decodeOptional, encode, validInput } from "../codec";
import { isConflict } from "../errors";
import { keys, segment } from "../keys";
import { type Key, type StoredItem, type WriteOp, cond } from "../store";
import { expiry } from "../ttl";

const TABLE = "Runtime" as const;

/** `2026-10-07T13` (UTC hour) of a real instant. */
export function realHourStamp(at: Date): string {
  return at.toISOString().slice(0, 13);
}

/** `2026-10-07` (UTC day) of a real instant. */
export function realDayStamp(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export type CapBucket =
  | { readonly kind: "RATE"; readonly worldId: string; readonly phoneHash: string; readonly at: Date }
  | { readonly kind: "TURNCAP"; readonly worldId: string; readonly window: "HOUR" | "DAY"; readonly at: Date }
  | { readonly kind: "IMGCAP"; readonly worldId: string; readonly customerId: string; readonly at: Date }
  | { readonly kind: "RESETCAP"; readonly worldId: string; readonly at: Date }
  | { readonly kind: "GLOBALCAP"; readonly pool: "PUBLIC" | "QA"; readonly window: "HOUR" | "DAY"; readonly at: Date };

export interface CapResult {
  readonly allowed: boolean;
  /** The count after the increment (or the count at the cap when refused). */
  readonly count: number;
}

/** The key of a cap bucket; the only global ones are `GLOBALCAP#`. */
export function capKey(bucket: CapBucket): Key {
  switch (bucket.kind) {
    case "RATE":
      return keys.runtime(bucket.worldId, "RATE", segment(bucket.phoneHash, "phone hash"), realHourStamp(bucket.at));
    case "TURNCAP":
      return keys.runtime(bucket.worldId, "TURNCAP", bucket.window === "HOUR" ? realHourStamp(bucket.at) : realDayStamp(bucket.at));
    case "IMGCAP":
      return keys.runtime(bucket.worldId, "IMGCAP", segment(bucket.customerId, "customer id"), realDayStamp(bucket.at));
    case "RESETCAP":
      return keys.runtime(bucket.worldId, "RESETCAP", realDayStamp(bucket.at));
    case "GLOBALCAP":
      return keys.global("GLOBALCAP", bucket.pool, bucket.window === "HOUR" ? realHourStamp(bucket.at) : realDayStamp(bucket.at));
  }
}

/** A counted failure, or the ledger as it is when a lock already holds it (nothing written). */
export type ChallengeFailureResult = { readonly status: "COUNTED" | "LOCKED"; readonly ledger: ChallengeLedger };

export function capsRepo(ctx: RepoContext) {
  const challengeKey = (worldId: string, customerId: string) => keys.runtime(worldId, "CHALLENGE", segment(customerId, "customer id"));
  const worldOf = (bucket: CapBucket) => (bucket.kind === "GLOBALCAP" ? undefined : bucket.worldId);

  /** One more in the bucket, conditional on its count being below `limit` (a failed condition is a conflict). */
  const incrementOp = (bucket: CapBucket, limit: number): WriteOp => {
    const now = ctx.now();
    return {
      kind: "update",
      table: TABLE,
      key: capKey(bucket),
      condition: cond.or(cond.notExists("count"), cond.lt("count", limit)),
      update: { add: { count: 1 }, set: { entity: "CapCounter", updatedAt: now.toISOString(), ...expiry("cap", worldOf(bucket), now) } },
    };
  };

  return {
    incrementOp,
    /** Counts one more unless the bucket already reached `limit`. */
    async increment(bucket: CapBucket, limit: number): Promise<CapResult> {
      if (!Number.isInteger(limit) || limit <= 0) return { allowed: false, count: 0 };
      try {
        const after = await ctx.store.write(incrementOp(bucket, limit));
        return { allowed: true, count: decode(CapCounter, after as StoredItem, TABLE).count };
      } catch (error) {
        if (!isConflict(error)) throw error;
        return { allowed: false, count: limit };
      }
    },
    async peek(bucket: CapBucket): Promise<number> {
      return decodeOptional(CapCounter, await ctx.store.get(TABLE, capKey(bucket), { consistent: true }), TABLE)?.count ?? 0;
    },
    /** Sets a bucket's count (the QA driver's `caps.prime`, only for its own worlds). */
    async set(bucket: CapBucket, count: number): Promise<void> {
      const value = validInput(CapCounter, { count }, TABLE);
      await ctx.store.write({ kind: "put", table: TABLE, item: encode(value, { entity: "CapCounter", key: capKey(bucket), worldId: worldOf(bucket), retention: "cap", now: ctx.now() }) });
    },

    async getChallenge(worldId: string, customerId: string): Promise<ChallengeLedger | undefined> {
      return decodeOptional(ChallengeLedger, await ctx.store.get(TABLE, challengeKey(worldId, customerId), { consistent: true }), TABLE);
    },
    /**
     * One more failure; the ledger lives 24 real hours from the last one. A locked ledger is never
     * touched: re-arming its TTL would let DynamoDB delete the lock (and the count) after one real day.
     */
    async recordChallengeFailure(worldId: string, customerId: string): Promise<ChallengeFailureResult> {
      const key = challengeKey(worldId, customerId);
      const now = ctx.now();
      try {
        const after = await ctx.store.write({
          kind: "update",
          table: TABLE,
          key,
          condition: cond.notExists("lockedAtReal"),
          update: {
            append: { failures: [now.toISOString()] },
            set: { worldId, customerId, entity: "ChallengeLedger", updatedAt: now.toISOString(), ...expiry("challenge", worldId, now) },
            setIfNotExists: { createdAt: now.toISOString() },
          },
        });
        return { status: "COUNTED", ledger: decode(ChallengeLedger, after as StoredItem, TABLE) };
      } catch (error) {
        if (!isConflict(error)) throw error;
        const locked = await ctx.store.get(TABLE, key, { consistent: true });
        // A staff unlock deleted the ledger between the write and this read: the lock no longer holds.
        if (!locked) throw new ConnectorError("CONFLICT", "challenge ledger changed while recording a failure", TABLE, { cause: error });
        return { status: "LOCKED", ledger: decode(ChallengeLedger, locked, TABLE) };
      }
    },
    /** `LOCKED` until a person lifts it: the lock drops the TTL so it never expires on its own. */
    async lockChallenge(worldId: string, customerId: string): Promise<void> {
      await ctx.store.write({
        kind: "update",
        table: TABLE,
        key: challengeKey(worldId, customerId),
        condition: cond.present(),
        update: { set: { lockedAtReal: ctx.now().toISOString(), updatedAt: ctx.now().toISOString() }, remove: ["expiresAt"] },
      });
    },
    /** A passed challenge or a staff unlock (`customers.unlockChallenge`, audited by the caller) resets the count. */
    async clearChallenge(worldId: string, customerId: string): Promise<void> {
      await ctx.store.write({ kind: "delete", table: TABLE, key: challengeKey(worldId, customerId) });
    },
  };
}

export type CapsRepo = ReturnType<typeof capsRepo>;
