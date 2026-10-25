// `Runtime` items that describe the state of a world (docs/architecture.md §5, §7, §10): its demo
// clock, what is in flight, what is pending (emails until their terminal SES event, images until
// their scan resolves), tombstones of destroyed epochs, the agent kill switch and the tickets that
// authorize an asynchronous reset or Memory purge.
import { z } from "zod";
import { ClockMode, IsoInstant, WorldId } from "@reclamo/shared";
import { Actor, Epoch, Id, JsonObject, Stamps, Versioned } from "./common";
import { ResetPhase } from "./world";

/** `W#<w>#CLOCK` as stored; lib/clock.ts `ClockState` is the part `simNow` depends on. */
export const StoredClock = z.object({
  worldId: WorldId,
  mode: ClockMode,
  pausedSimNow: IsoInstant.optional(),
  anchorSim: IsoInstant.optional(),
  anchorReal: IsoInstant.optional(),
  rate: z.number().positive().optional(),
  worldEpoch: Epoch,
  /** A running clock goes back to `PAUSED` on its own after 30 real minutes. */
  runningUntilReal: IsoInstant.optional(),
  /** Last console session of the world (guest "another session" notice). */
  lastSession: z.object({ sessionId: z.string().min(1).max(200), lastActiveAtReal: IsoInstant }).optional(),
  ...Versioned,
});
export type StoredClock = z.infer<typeof StoredClock>;

/** `W#<w>#WORLDSTATE`: the events in flight (`<customerId>#<eventId>`), for quiescence. */
export const WorldState = z.object({ worldId: WorldId, inFlight: z.array(z.string()).default([]), ...Stamps });
export type WorldState = z.infer<typeof WorldState>;

export const PendingKind = z.enum(["MAIL", "SCAN"]);
export type PendingKind = z.infer<typeof PendingKind>;

/** An item of `W#<w>#PENDING`: open until its terminal event deletes it. */
export const Pending = z.object({
  worldId: WorldId,
  kind: PendingKind,
  pendingId: Id,
  openedAtReal: IsoInstant,
  customerId: Id.optional(),
  complaintId: Id.optional(),
  ref: z.string().max(200).optional(),
  ...Stamps,
});
export type Pending = z.infer<typeof Pending>;

/** `W#<w>#TOMB#<epoch>`: every late event of this epoch is discarded (docs/architecture.md §7). */
export const Tombstone = z.object({ worldId: WorldId, epoch: Epoch, reason: z.enum(["RESET", "DESTROY"]), atReal: IsoInstant, ...Stamps });
export type Tombstone = z.infer<typeof Tombstone>;

/** `KILL#AGENT` (global) or `W#<w>#KILL` (one world): the agent kill switch, read before every model call. */
export const KillSwitch = z.object({
  scope: z.enum(["GLOBAL", "WORLD"]),
  worldId: WorldId.optional(),
  by: z.union([Actor, z.literal("BUDGET")]),
  atReal: IsoInstant,
  reason: z.string().max(200).optional(),
  ...Stamps,
});
export type KillSwitch = z.infer<typeof KillSwitch>;

export const TicketKind = z.enum(["RESETREQ", "PURGEREQ"]);
export type TicketKind = z.infer<typeof TicketKind>;

export const TicketStatus = z.enum(["OPEN", "CLAIMED", "DONE"]);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** `W#<w>#RESETREQ#<requestId>` / `W#<w>#PURGEREQ#<requestId>`: the only authorization `WorldJanitor` accepts. */
export const Ticket = z.object({
  worldId: WorldId,
  kind: TicketKind,
  requestId: Id,
  status: TicketStatus,
  openedAtReal: IsoInstant,
  leaseUntilReal: IsoInstant.optional(),
  attempts: z.number().int().nonnegative(),
  phase: ResetPhase.optional(),
  detail: JsonObject.optional(),
  ...Versioned,
});
export type Ticket = z.infer<typeof Ticket>;

/** A monotonic counter (`COUNTER#EPOCH`, `COUNTER#CMP#e<epoch>#<yyyy>`). */
export const Counter = z.object({ value: z.number().int().nonnegative(), ...Stamps });
export type Counter = z.infer<typeof Counter>;
