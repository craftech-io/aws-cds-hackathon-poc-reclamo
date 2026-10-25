// Monotonic counters and tickets of a world (docs/architecture.md §8.2, §9.3, §10):
//
//   COUNTER#EPOCH               the world epoch; moves from e to e + 1 only (a reset), never back
//   COUNTER#CMP#e<epoch>#<yyyy> the complaint number; advanced in the numbering transaction on the
//                               value the caller read, so a cancelled transaction leaves no gap
//   RESETREQ# / PURGEREQ#       the tickets without which `WorldJanitor` refuses to reset or purge;
//                               claimed with a lease, so two invocations never run the same ticket
import { ConnectorError } from "@reclamo/shared";
import { Counter, Ticket, type TicketKind } from "../../domain/runtime";
import { type NewOf, type RepoContext, decode, decodeOptional, encode, validInput } from "../codec";
import { keys } from "../keys";
import { type StoredItem, type WriteOp, cond } from "../store";
import { expiry } from "../ttl";

const TABLE = "Runtime" as const;

function yearPart(year: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new ConnectorError("VALIDATION", `invalid year ${year}`, TABLE);
  return String(year);
}

/** `current → current + 1`, conditional on the value the caller read (absent for 0). */
function advanceOp(key: { pk: string; sk: string }, current: number, worldId: string, now: Date, retention: "worldRuntime" | undefined): WriteOp {
  return {
    kind: "update",
    table: TABLE,
    key,
    condition: current === 0 ? cond.notExists("value") : cond.eq("value", current),
    update: { set: { value: current + 1, entity: "Counter", worldId, updatedAt: now.toISOString(), ...(retention ? expiry(retention, worldId, now) : {}) } },
  };
}

export function countersRepo(ctx: RepoContext) {
  const epochKey = (worldId: string) => keys.counter(worldId, "EPOCH");
  const complaintKey = (worldId: string, epoch: number, year: number) => keys.counter(worldId, "CMP", keys.epochPart(epoch), yearPart(year));
  const ticketKey = (worldId: string, kind: TicketKind, requestId: string) => keys.runtime(worldId, kind, requestId);
  const valueOf = async (key: { pk: string; sk: string }): Promise<number> => decodeOptional(Counter, await ctx.store.get(TABLE, key, { consistent: true }), TABLE)?.value ?? 0;

  const ticketOp = (kind: TicketKind, worldId: string, requestId: string, condition: WriteOp["condition"], set: Record<string, unknown>, extra: { add?: Record<string, number>; remove?: string[] } = {}): WriteOp => ({
    kind: "update",
    table: TABLE,
    key: ticketKey(worldId, kind, requestId),
    ...(condition ? { condition } : {}),
    update: { set: { ...set, updatedAt: ctx.now().toISOString() }, add: { version: 1, ...extra.add }, ...(extra.remove ? { remove: extra.remove } : {}) },
  });

  return {
    /** The world epoch (0 before the world exists), strongly consistent; never read from a payload. */
    async getEpoch(worldId: string): Promise<number> {
      return valueOf(epochKey(worldId));
    },
    /** `COUNTER#EPOCH` of a new world (factory), written once. The epoch counter never expires. */
    initEpochOp(worldId: string, epoch: number): WriteOp {
      const value = validInput(Counter, { value: epoch }, TABLE);
      return { kind: "put", table: TABLE, item: encode({ ...value, worldId }, { entity: "Counter", key: epochKey(worldId), worldId, now: ctx.now() }), condition: cond.absent() };
    },
    /** `e → e + 1`, part of the reset request transaction. */
    advanceEpochOp(worldId: string, from: number): WriteOp {
      if (from < 1) throw new ConnectorError("VALIDATION", "a world epoch starts at 1", TABLE);
      return advanceOp(epochKey(worldId), from, worldId, ctx.now(), undefined);
    },

    /** Last complaint number of the world's epoch and year (0 before the first). */
    async getComplaintCounter(worldId: string, epoch: number, year: number): Promise<number> {
      return valueOf(complaintKey(worldId, epoch, year));
    },
    /** `n − 1 → n` in the same transaction as the complaint and its `FILED` entry (§8.2). */
    advanceComplaintCounterOp(worldId: string, epoch: number, year: number, current: number): WriteOp {
      return advanceOp(complaintKey(worldId, epoch, year), current, worldId, ctx.now(), "worldRuntime");
    },

    /** An `OPEN` ticket in the world's partition, written only by a role fenced to that world. */
    openTicketOp(ticket: Omit<NewOf<typeof Ticket>, "status" | "attempts" | "leaseUntilReal"> & { attempts?: number }): WriteOp {
      const value = validInput(Ticket, { ...ticket, status: "OPEN", attempts: ticket.attempts ?? 0, version: 1 }, TABLE);
      const item = encode(value, {
        entity: value.kind === "RESETREQ" ? "ResetRequest" : "PurgeRequest",
        key: ticketKey(value.worldId, value.kind, value.requestId),
        worldId: value.worldId,
        retention: value.kind === "RESETREQ" ? "resetTicket" : "purgeTicket",
        now: ctx.now(),
      });
      return { kind: "put", table: TABLE, item, condition: cond.absent() };
    },
    async getTicket(worldId: string, kind: TicketKind, requestId: string): Promise<Ticket | undefined> {
      return decodeOptional(Ticket, await ctx.store.get(TABLE, ticketKey(worldId, kind, requestId), { consistent: true }), TABLE);
    },
    /** `OPEN` (or `CLAIMED` with an expired lease) → `CLAIMED` until `leaseUntilReal`; `undefined` when someone else holds it. */
    async claimTicket(worldId: string, kind: TicketKind, requestId: string, leaseUntilReal: string): Promise<Ticket | undefined> {
      const now = ctx.now().toISOString();
      const claimable = cond.and(cond.present(), cond.or(cond.eq("status", "OPEN"), cond.and(cond.eq("status", "CLAIMED"), cond.lt("leaseUntilReal", now))));
      try {
        const after = await ctx.store.write(ticketOp(kind, worldId, requestId, claimable, { status: "CLAIMED", leaseUntilReal }));
        return decode(Ticket, after as StoredItem, TABLE);
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return undefined;
        throw error;
      }
    },
    /** Saves progress and extends the lease of a claimed ticket (a heartbeat). */
    heartbeatTicketOp(worldId: string, kind: TicketKind, requestId: string, leaseUntilReal: string, progress: { phase?: Ticket["phase"]; detail?: Ticket["detail"] } = {}): WriteOp {
      return ticketOp(kind, worldId, requestId, cond.eq("status", "CLAIMED"), { leaseUntilReal, ...progress });
    },
    /** Gives the ticket back (a continuation invokes itself with it), counting the attempt when asked. */
    releaseTicketOp(worldId: string, kind: TicketKind, requestId: string, options: { countAttempt?: boolean } = {}): WriteOp {
      return ticketOp(kind, worldId, requestId, cond.in("status", ["OPEN", "CLAIMED"]), { status: "OPEN" }, { remove: ["leaseUntilReal"], ...(options.countAttempt ? { add: { attempts: 1 } } : {}) });
    },
    completeTicketOp(worldId: string, kind: TicketKind, requestId: string): WriteOp {
      return ticketOp(kind, worldId, requestId, cond.eq("status", "CLAIMED"), { status: "DONE" }, { remove: ["leaseUntilReal"] });
    },
  };
}

export type CountersRepo = ReturnType<typeof countersRepo>;
