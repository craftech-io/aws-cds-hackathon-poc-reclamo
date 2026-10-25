// The follow-up turn of a `FOLLOW_UP` timer (docs/architecture.md §10: `update_complaint({followUpAtSim})`
// → "Turno de seguimiento"). `fire_timer` answers `TURN` for it (timers/effects.ts); the worker queues the
// turn behind the customer's other events as a `TRANSFER_STATUS_CHANGED` with `followUp`, the event of a
// complaint that waited for something outside (the follow-up's flows wait for a network: FL-047): the
// wait ends (`AWAITING_NETWORK → INVESTIGATING`) and the turn checks it again. Its id derives from the
// timer event, so a redelivered timer queues it once. A complaint that no longer waits (answered, closed,
// with a person) gets no turn: `FOLLOW_UP_SKIPPED`.
import type { Complaint } from "../domain/complaint";
import { sha256Hex } from "../lib/crypto";
import { WORKER_ACTIONS, auditOnce } from "./audit";
import type { CustomerEventInput, EventOf } from "./events";
import type { WorkerContext } from "./ports";
import type { Connector } from "../connector/port";

/** Statuses in which a complaint still waits for its follow-up. */
export const FOLLOW_UP_STATUSES: ReadonlySet<Complaint["status"]> = new Set(["REGISTERED", "INVESTIGATING", "AWAITING_CUSTOMER", "AWAITING_SETTLEMENT", "AWAITING_NETWORK"]);

/** The follow-up turn of a fired `FOLLOW_UP` timer, or `undefined` when the complaint no longer waits. */
export function followUpEvent(event: EventOf<"TIMER">, complaint: Complaint | undefined): CustomerEventInput | undefined {
  if (complaint === undefined || complaint.customerId !== event.customerId || !FOLLOW_UP_STATUSES.has(complaint.status)) return undefined;
  return {
    type: "TRANSFER_STATUS_CHANGED",
    eventId: `fup-${sha256Hex(`FOLLOW_UP#${event.eventId}`).slice(0, 32)}`,
    worldId: event.worldId,
    customerId: event.customerId,
    epoch: event.epoch,
    eventAtSim: event.eventAtSim,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    payload: { complaintId: complaint.complaintId, followUp: true },
  };
}

/** Queues the follow-up turn (in flight before the timer event leaves it), or audits why there is none. */
export async function queueFollowUp(data: Connector, ctx: WorkerContext, event: EventOf<"TIMER">, complaintId: string): Promise<boolean> {
  const complaint = await data.complaints.get(event.worldId, complaintId, { consistent: true });
  const next = followUpEvent(event, complaint);
  if (next !== undefined) {
    await ctx.enqueue(next);
    return true;
  }
  await auditOnce({ data, now: ctx.now, log: ctx.log }, { action: WORKER_ACTIONS.followUpSkipped, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, outcome: complaint?.status ?? "NOT_FOUND", refs: { customerId: event.customerId, complaintId } });
  return false;
}
