// The edges of the timers (docs/architecture.md §7 and §10), validated with zod:
//
//   ScheduleInput      what a Scheduler schedule hands `ScheduleDispatch`:
//                      {worldId, timerKey, version, epoch, dueAtSim, scheduleArn}; the ARN is the
//                      Scheduler's context attribute. Nothing in it decides: the dispatcher reads the
//                      stored timer, tombstone and clock (decide.ts).
//   TimerQueueEvent    what a fired timer puts on the world's customer queue through `worker/enqueue.ts`
//                      (`TimerEventSink`), in the queue's own schema (worker/events.ts): `TIMER` (the
//                      effects that write a complaint or need the gate, effects.ts), `SETTLEMENT_PUBLISHED`
//                      (publication or safety-net recheck) and `TRANSFER_STATUS_CHANGED` (a scheduled
//                      network change with a complaint waiting for it).
//   *Payload           the `payload` each producer writes on a timer of its kind.
//
// Event ids are derived, never random: the same fire produces the same id whoever dispatches it (the
// clock or a schedule), so the queue's deduplication and the worker's `IDEMP#` run it once.
import { z } from "zod";
import { IsoInstant, SlaMilestone, TimerKind, WorldId } from "@reclamo/shared";
import { ComplaintNumber, CustomerId, Epoch, Id, JsonObject } from "../domain/common";
import { sha256Hex } from "../lib/crypto";
import type { CustomerEventInput } from "../worker/events";

/** `W#<worldId>#TIMER#<kind>#<timerId>`, as the connector writes it. */
export const TimerKey = z.string().regex(/^W#[a-z0-9-]{1,48}#TIMER#[A-Z_]{2,32}#[A-Za-z0-9][A-Za-z0-9._:+=@-]{0,159}$/, "invalid timer key");

export const ScheduleInput = z
  .object({
    worldId: WorldId,
    timerKey: TimerKey,
    version: z.number().int().positive(),
    epoch: Epoch,
    dueAtSim: IsoInstant,
    scheduleArn: z.string().min(1).max(2_048),
  })
  .strict()
  .refine((input) => input.timerKey.startsWith(`W#${input.worldId}#TIMER#`), { message: "the timer key belongs to another world", path: ["timerKey"] });
export type ScheduleInput = z.infer<typeof ScheduleInput>;

/** The part of a timer key after its world: kind and id. */
export function kindAndIdOf(timerKey: string): { readonly kind: TimerKind; readonly timerId: string } {
  const [, , marker, kind, timerId, ...rest] = timerKey.split("#");
  const parsed = TimerKind.safeParse(kind);
  if (marker !== "TIMER" || !parsed.success || !timerId || rest.length > 0) throw new RangeError("invalid timer key");
  return { kind: parsed.data, timerId };
}

/**
 * What a fired timer puts on the customer's queue (worker/events.ts, the schema of the queue): `TIMER`
 * (the worker runs effects.ts), `SETTLEMENT_PUBLISHED` and `TRANSFER_STATUS_CHANGED` (a turn).
 */
export type TimerQueueEvent = Extract<CustomerEventInput, { type: "TIMER" | "SETTLEMENT_PUBLISHED" | "TRANSFER_STATUS_CHANGED" }>;

/**
 * Producer of the customer queues (`worker/enqueue.ts`, the only one): picks the queue by the world's
 * class and origin, `MessageGroupId = <worldId>#<customerId>`, `MessageDeduplicationId = eventId`,
 * `inFlight` before `SendMessage`. Tests record the events (timers/sink.ts adapts the producer).
 */
export interface TimerEventSink {
  enqueue(event: TimerQueueEvent): Promise<void>;
}

function derivedId(prefix: string, ...parts: readonly (string | number)[]): string {
  return `${prefix}-${sha256Hex(parts.join("|")).slice(0, 40)}`;
}

/** The `TIMER` event of one claimed fire: the same for the clock and the Scheduler. */
export function timerEventId(timerKey: string, epoch: number, firedVersion: number): string {
  return derivedId("tmr", timerKey, epoch, firedVersion);
}

/** `SETTLEMENT_PUBLISHED` of one complaint for one fire (a recheck's, or the publication's own). */
export function settlementEventId(firingTimerKey: string, epoch: number, firedVersion: number, complaintId: string): string {
  return derivedId("stl", firingTimerKey, epoch, firedVersion, complaintId);
}

/** `TRANSFER_STATUS_CHANGED` of one complaint for one network transition. */
export function transitionEventId(timerKey: string, epoch: number, firedVersion: number, complaintId: string): string {
  return derivedId("trn", timerKey, epoch, firedVersion, complaintId);
}

// ---- Payloads of each kind ---------------------------------------------------------------------

/** `SLA`: complaints/sla.ts `milestoneTimers`. */
export const SlaPayload = z.object({ milestone: SlaMilestone, complaintId: Id, complaintNumber: ComplaintNumber, deadlineSim: IsoInstant });

/** `AUTO_CLOSE`: complaints/sla.ts `autoCloseTimer`. */
export const AutoClosePayload = z.object({ complaintId: Id });

/** `SETTLEMENT_PUBLISH`: the world factory and the network mock. */
export const SettlementPublishPayload = z.object({ network: z.enum(["NORTE", "SUR"]), businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** `SETTLEMENT_RECHECK`: `reconcile_payment` and the worker's obligation, owner `BATCH#<network>#<businessDate>`. */
export const SettlementRecheckPayload = z.object({ complaintId: Id, customerId: CustomerId.optional() });

/** `NETWORK_TRANSITION`: a transfer of the network (`TRF#…`) or a disbursement of the core (`LOAN#…`). */
export const NetworkTransitionPayload = z.union([
  z.object({ transferId: Id, to: z.enum(["COMPLETED", "REJECTED_REVERSED", "REJECTED_NOT_REVERSED"]), rejectReason: z.string().min(1).max(200).optional() }),
  z.object({ loanId: Id, to: z.literal("CREDITED") }),
]);
export type NetworkTransitionPayload = z.infer<typeof NetworkTransitionPayload>;

/** `FOLLOW_UP`: `update_complaint({followUpAtSim})`. */
export const FollowUpPayload = z.object({ complaintId: Id, customerId: CustomerId.optional(), note: z.string().max(200).optional() });

/**
 * `DEFERRED_SEND`: the gate's `DEFERRED` decision keeps the request it will evaluate again
 * (`outbound/types.ts` `OutboundRequest` as data) and the actor that asked for it.
 */
export const DeferredSendPayload = z.object({
  customerId: CustomerId,
  complaintId: Id.optional(),
  request: JsonObject,
  actor: z.string().min(1).max(80),
  tapeId: Id.optional(),
});
export type DeferredSendPayload = z.infer<typeof DeferredSendPayload>;
