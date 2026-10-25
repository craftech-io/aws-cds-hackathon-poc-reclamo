// `Timers/W#<w>#TIMER#<kind>#<timerId>` (docs/architecture.md §10): everything that happens at a
// simulated hour. A timer is processed at its simulated time (`eventAtSim = dueAtSim`) whether the
// clock dispatched it or a Scheduler schedule did; its status changes only with a conditional update
// on status, version and epoch, which is what discards a late or duplicated fire.
import { z } from "zod";
import { IsoInstant, TimerFiredBy, TimerKind, WorldId } from "@reclamo/shared";
import { Epoch, Id, JsonObject, Versioned } from "./common";

export const TimerStatus = z.enum(["SCHEDULED", "FIRED", "CANCELLED", "SKIPPED", "DISCARDED"]);
export type TimerStatus = z.infer<typeof TimerStatus>;

/** Owner of a timer (`CMP#<complaintId>`, `BATCH#<network>#<businessDate>`, `CONV#<customerId>`, `TRF#<transferId>`). */
export const OwnerKey = z.string().regex(/^[A-Z]+#[A-Za-z0-9._:+=@-]{1,80}(#[A-Za-z0-9._:+=@-]{1,80})?$/, "invalid owner key");
export type OwnerKey = z.infer<typeof OwnerKey>;

export const Timer = z.object({
  worldId: WorldId,
  kind: TimerKind,
  timerId: Id,
  dueAtSim: IsoInstant,
  /** Stable tie-break between timers due at the same instant. */
  seq: z.number().int().nonnegative(),
  status: TimerStatus,
  firedBy: TimerFiredBy.optional(),
  firedAtSim: IsoInstant.optional(),
  /** World epoch the timer belongs to: a fire of another epoch is discarded. */
  epoch: Epoch,
  /** Scheduler schedule while the world runs (`tm-<worldId>-e<epoch>-<hash>`). */
  scheduleName: z.string().regex(/^tm-[a-z0-9-]{1,61}$/).optional(),
  ownerKey: OwnerKey.optional(),
  payload: JsonObject.default({}),
  reason: z.string().max(120).optional(),
  ...Versioned,
});
export type Timer = z.infer<typeof Timer>;
