// `Runtime` state of a world (docs/architecture.md §7, §10, §13): the demo clock, the events in
// flight and the pending emails and scans (quiescence), tombstones of destroyed epochs and the agent
// kill switch, global (`KILL#AGENT`) or per world (`W#<w>#KILL`).
import type { z } from "zod";
import { ConnectorError } from "@reclamo/shared";
import { type ClockState, type ClockStateReader, ClockState as ClockStateSchema } from "../../lib/clock";
import { KillSwitch, Pending, type PendingKind, StoredClock, Tombstone, WorldState } from "../../domain/runtime";
import { type NewOf, type RepoContext, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { isConflict } from "../errors";
import { keys } from "../keys";
import { type WriteOp, cond } from "../store";

const TABLE = "Runtime" as const;

export const ClockPatch = StoredClock.omit({ worldId: true, version: true, createdAt: true, updatedAt: true, synthetic: true }).partial();
export type ClockPatch = z.infer<typeof ClockPatch>;

export function runtimeRepo(ctx: RepoContext) {
  const clockKey = (worldId: string) => keys.runtime(worldId, "CLOCK");
  const worldStateKey = (worldId: string) => keys.runtime(worldId, "WORLDSTATE");
  const killKey = (worldId?: string) => (worldId === undefined ? keys.global("KILL", "AGENT") : keys.runtime(worldId, "KILL"));

  const getClock = async (worldId: string): Promise<StoredClock | undefined> =>
    decodeOptional(StoredClock, await ctx.store.get(TABLE, clockKey(worldId), { consistent: true }), TABLE);

  const putClockOp = (clock: NewOf<typeof StoredClock>, expectedVersion?: number): WriteOp => {
    const value = validInput(StoredClock, { ...clock, version: (expectedVersion ?? 0) + 1 }, TABLE);
    const item = encode(value, { entity: "Clock", key: clockKey(value.worldId), worldId: value.worldId, retention: "worldRuntime", now: ctx.now() });
    return { kind: "put", table: TABLE, item, ...(expectedVersion === undefined ? {} : { condition: cond.eq("version", expectedVersion) }) };
  };

  const removeInFlightOp = (worldId: string, tokens: string | readonly string[]): WriteOp => ({
    kind: "update",
    table: TABLE,
    key: worldStateKey(worldId),
    condition: cond.present(),
    update: { deleteFromSet: { inFlight: typeof tokens === "string" ? [tokens] : [...tokens] }, set: { updatedAt: ctx.now().toISOString() } },
  });

  const getKill = async (worldId?: string): Promise<KillSwitch | undefined> => decodeOptional(KillSwitch, await ctx.store.get(TABLE, killKey(worldId), { consistent: true }), TABLE);

  return {
    /** `W#<w>#CLOCK`, strongly consistent (every simulated "now" re-reads it). */
    getClock,

    /** lib/clock.ts `ClockStateReader`: the part of the stored clock `simNow` depends on. */
    clockState: (async (worldId: string): Promise<ClockState> => {
      const clock = await getClock(worldId);
      if (!clock) throw new ConnectorError("NOT_FOUND", `world ${worldId} has no clock`, TABLE);
      return ClockStateSchema.parse(clock);
    }) satisfies ClockStateReader,

    /** The whole clock: the factory's (no `expectedVersion`) or a move over the version the caller read. */
    putClockOp,
    async putClock(clock: NewOf<typeof StoredClock>, expectedVersion?: number): Promise<void> {
      await ctx.store.write(putClockOp(clock, expectedVersion));
    },
    /** A versioned change of some clock fields (`remove` drops the fields of the mode it leaves). */
    updateClockOp(worldId: string, version: number, patch: ClockPatch, remove: readonly (keyof ClockPatch)[] = []): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: clockKey(worldId),
        condition: cond.eq("version", version),
        update: { set: { ...validInput(ClockPatch, patch, TABLE), version: version + 1, updatedAt: ctx.now().toISOString() }, ...(remove.length > 0 ? { remove: [...remove] } : {}) },
      };
    },

    async getWorldState(worldId: string): Promise<WorldState> {
      const item = await ctx.store.get(TABLE, worldStateKey(worldId), { consistent: true });
      return item ? decode(WorldState, item, TABLE) : { worldId, inFlight: [] };
    },
    /** `ADD inFlight <customerId>#<eventId>~<addedAtMs>` before a producer enqueues. */
    addInFlightOp(worldId: string, token: string): WriteOp {
      return { kind: "update", table: TABLE, key: worldStateKey(worldId), update: { add: { inFlight: [token] }, set: { worldId, entity: "WorldState", updatedAt: ctx.now().toISOString() } } };
    },
    /**
     * A world seeded before `inFlight` was left out of its `WORLDSTATE` row holds it as an empty list,
     * which `ADD` refuses: the first producer replaces that list with the set of its own token.
     */
    replaceInFlightListOp(worldId: string, token: string): WriteOp {
      return { kind: "update", table: TABLE, key: worldStateKey(worldId), condition: cond.attributeType("inFlight", "L"), update: { set: { inFlight: new Set([token]), updatedAt: ctx.now().toISOString() } } };
    },
    /**
     * `DELETE inFlight …` when the worker is done with the event, only on a row that exists: a reset
     * wipe or a destruction may have removed it mid-event, and an unconditional update would recreate
     * a partial row that no longer decodes as a `WorldState`.
     */
    removeInFlightOp,
    /** `removeInFlightOp` on its own: a missing row is nothing to remove (`false`), never an error. */
    async removeInFlight(worldId: string, tokens: string | readonly string[]): Promise<boolean> {
      try {
        await ctx.store.write(removeInFlightOp(worldId, tokens));
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },

    /** An email until its terminal SES event, an image from its binding until its scan resolves. */
    openPendingOp(pending: NewOf<typeof Pending>): WriteOp {
      const value = validInput(Pending, pending, TABLE);
      const item = encode(value, { entity: "Pending", key: keys.pending(value.worldId, value.kind, value.pendingId), worldId: value.worldId, retention: "pending", now: ctx.now() });
      return { kind: "put", table: TABLE, item, condition: cond.absent() };
    },
    /** Closing is deleting: idempotent, a second terminal event finds nothing to close. */
    closePendingOp(worldId: string, kind: PendingKind, pendingId: string): WriteOp {
      return { kind: "delete", table: TABLE, key: keys.pending(worldId, kind, pendingId) };
    },
    async listPending(worldId: string): Promise<Pending[]> {
      const items = await queryAll(ctx.store, { table: TABLE, partition: keys.pendingPartition(worldId), consistent: true });
      return items.map((item) => decode(Pending, item, TABLE));
    },

    /** `W#<w>#TOMB#<epoch>`, written with the reset request (or the destruction) and never removed by it. */
    putTombstoneOp(tombstone: NewOf<typeof Tombstone>): WriteOp {
      const value = validInput(Tombstone, tombstone, TABLE);
      const item = encode(value, { entity: "Tombstone", key: keys.runtime(value.worldId, "TOMB", String(value.epoch)), worldId: value.worldId, retention: "worldRuntime", now: ctx.now() });
      return { kind: "put", table: TABLE, item, condition: cond.absent() };
    },
    async getTombstone(worldId: string, epoch: number): Promise<Tombstone | undefined> {
      return decodeOptional(Tombstone, await ctx.store.get(TABLE, keys.runtime(worldId, "TOMB", String(epoch)), { consistent: true }), TABLE);
    },

    /** The kill switch of a world, or the global one without `worldId`. */
    getKill,
    /** True when the agent is cut for this world: globally or for the world alone. */
    async isAgentKilled(worldId: string): Promise<boolean> {
      const [global, world] = await Promise.all([getKill(), getKill(worldId)]);
      return global !== undefined || world !== undefined;
    },
    /** Turns a kill switch on (put) or off (delete); the caller audits who did it. */
    async setKill(request: { worldId?: string; on: boolean; by: KillSwitch["by"]; atReal: string; reason?: string }): Promise<void> {
      const key = killKey(request.worldId);
      if (!request.on) {
        await ctx.store.write({ kind: "delete", table: TABLE, key });
        return;
      }
      const value = validInput(KillSwitch, { scope: request.worldId === undefined ? "GLOBAL" : "WORLD", worldId: request.worldId, by: request.by, atReal: request.atReal, reason: request.reason }, TABLE);
      await ctx.store.write({ kind: "put", table: TABLE, item: encode(value, { entity: "Kill", key, worldId: request.worldId, retention: "worldRuntime", now: ctx.now() }) });
    },
  };
}

export type RuntimeRepo = ReturnType<typeof runtimeRepo>;
