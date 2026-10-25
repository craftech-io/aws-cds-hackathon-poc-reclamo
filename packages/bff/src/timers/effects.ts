// The worker's half of `fire_timer` (docs/architecture.md §7 `TIMER`, §8.4 and §10): the effects that
// write a complaint or send a message, run on the customer's queue so they serialize with the rest of
// the customer's events. Each runs at the event's simulated instant (`eventAtSim = dueAtSim`).
//
//   SLA OPERATOR_REMINDER       note on the case (the inbox marks it), `AuditLog SLA_REMINDER`; no turn,
//                               no message to the customer (FL-077)
//   SLA SUPERVISOR_ESCALATION   `slaState = AT_RISK`, note, `AuditLog SUPERVISOR_ALERT`; the alert email
//                               only in the world `demo`, to the role's demo recipients (FL-078)
//   SLA DEADLINE                `slaState = OVERDUE`, note, `AuditLog SLA_OVERDUE`, metric `SlaOverdue`
//                               for a live complaint (FL-079)
//   AUTO_CLOSE                  ANSWERED → CLOSED when nothing changed since the answer
//   DEFERRED_SEND               the kept request goes through the outbound gate again (it may defer again)
//   FOLLOW_UP                   the worker runs a follow-up turn (`TURN`)
//
// An event runs only while its claim stands: the stored timer must be FIRED at `firedVersion + 1` and
// in the event's epoch. Notes carry derived ids, so a redelivered event collides and does nothing.
import { z } from "zod";
import type { SlaMilestone, SlaState } from "@reclamo/shared";
import { STAFF_TEXT, fill } from "../copy";
import type { ComplaintsDeps } from "../complaints/deps";
import { deadlineText } from "../complaints/sla";
import { transition } from "../complaints/state-machine";
import { isConflict } from "../connector/errors";
import type { Connector } from "../connector/port";
import type { Complaint } from "../domain/complaint";
import { Actor } from "../domain/common";
import type { Timer } from "../domain/timer";
import type { Logger } from "../lib/log";
import type { OutboundGate, OutboundRequest } from "../outbound/types";
import { errorNameOf, newIdOf } from "./deps";
import type { EventOf } from "../worker/events";
import { AutoClosePayload, DeferredSendPayload, FollowUpPayload, SlaPayload } from "./events";

/** The `TIMER` event of the customer queue, as the worker parsed it (worker/events.ts). */
export type TimerQueueEvent = EventOf<"TIMER">;

export interface SupervisorAlert {
  readonly worldId: string;
  readonly complaintId: string;
  readonly complaintNumber: string;
  readonly deadlineSim: string;
}

export interface TimerEffectDeps {
  readonly connector: Connector;
  /** The state machine's deps (AUTO_CLOSE): chain key, anchors, milestone scheduler. */
  readonly complaints: ComplaintsDeps;
  readonly gate: OutboundGate;
  readonly log: Logger;
  readonly realNow: () => Date;
  readonly newId?: (prefix: string) => string;
  /** The supervisor alert email of the world `demo` (to the role's demo recipients only). */
  readonly supervisorAlert?: (alert: SupervisorAlert) => Promise<void>;
}

export type TimerEventOutcome =
  | { readonly status: "DONE"; readonly action: string }
  | { readonly status: "SKIPPED"; readonly reason: string }
  | { readonly status: "DISCARDED"; readonly reason: "STALE_EVENT" }
  | { readonly status: "TURN"; readonly reason: "FOLLOW_UP"; readonly complaintId: string };

const MILESTONE_EFFECT: Readonly<Record<SlaMilestone, { readonly text: keyof typeof STAFF_TEXT; readonly action: string; readonly slaState?: SlaState }>> = {
  OPERATOR_REMINDER: { text: "SLA_OPERATOR_REMINDER", action: "SLA_REMINDER" },
  SUPERVISOR_ESCALATION: { text: "SLA_SUPERVISOR_ESCALATION", action: "SUPERVISOR_ALERT", slaState: "AT_RISK" },
  DEADLINE: { text: "SLA_DEADLINE_OVERDUE", action: "SLA_OVERDUE", slaState: "OVERDUE" },
};

const CLOSED_FOR_SLA: ReadonlySet<Complaint["status"]> = new Set(["ANSWERED", "CLOSED"]);
const ATTEMPTS = 3;

function nextSlaState(current: SlaState, wanted: SlaState | undefined): SlaState | undefined {
  if (wanted === undefined || current === wanted || current === "OVERDUE") return undefined;
  return wanted;
}

async function audit(deps: TimerEffectDeps, timer: Timer, complaint: Complaint, action: string, atSim: string, detail: Record<string, string>) {
  return deps.connector.audit.appendOp({
    worldId: timer.worldId,
    epoch: timer.epoch,
    auditId: newIdOf(deps, "aud"),
    ts: deps.realNow().toISOString(),
    atSim,
    action,
    actor: "SYSTEM",
    refs: { complaintId: complaint.complaintId, complaintNumber: complaint.complaintNumber, timerId: timer.timerId },
    primaryRef: `CMP#${complaint.complaintId}`,
    detail,
  });
}

async function slaMilestone(timer: Timer, event: TimerQueueEvent, deps: TimerEffectDeps): Promise<TimerEventOutcome> {
  const payload = SlaPayload.parse(timer.payload);
  const effect = MILESTONE_EFFECT[payload.milestone];
  const noteId = `sla-${timer.timerId}`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const complaint = await deps.connector.complaints.get(timer.worldId, payload.complaintId, { consistent: true });
    if (!complaint || CLOSED_FOR_SLA.has(complaint.status)) return { status: "SKIPPED", reason: complaint ? `COMPLAINT_${complaint.status}` : "COMPLAINT_MISSING" };
    const text = fill(STAFF_TEXT[effect.text], { complaintNumber: complaint.complaintNumber, deadlineText: deadlineText(complaint.deadlineSim) });
    const slaState = nextSlaState(complaint.slaState, effect.slaState);
    const ops = [
      deps.connector.caseItems.putNoteOp({ worldId: timer.worldId, complaintId: complaint.complaintId, noteId, kind: "SLA", atSim: event.eventAtSim, author: "SYSTEM", text }),
      await audit(deps, timer, complaint, effect.action, event.eventAtSim, { milestone: payload.milestone, ...(slaState ? { slaState } : {}) }),
      ...(slaState ? [deps.connector.complaints.patchOp(timer.worldId, complaint.complaintId, complaint.version, { slaState })] : []),
    ];
    try {
      await deps.connector.transact(ops);
    } catch (error) {
      if (!isConflict(error)) throw error;
      const notes = await deps.connector.caseItems.listNotes(timer.worldId, complaint.complaintId);
      if (notes.some((note) => note.noteId === noteId)) return { status: "SKIPPED", reason: "ALREADY_APPLIED" };
      continue;
    }
    if (payload.milestone === "DEADLINE" && complaint.origin === "LIVE") {
      deps.log.warn("timers.sla_overdue", { metric: "SlaOverdue", worldId: timer.worldId, complaintId: complaint.complaintId });
    }
    if (payload.milestone === "SUPERVISOR_ESCALATION" && timer.worldId === "demo" && deps.supervisorAlert) {
      await deps
        .supervisorAlert({ worldId: timer.worldId, complaintId: complaint.complaintId, complaintNumber: complaint.complaintNumber, deadlineSim: complaint.deadlineSim })
        .catch((error: unknown) => deps.log.warn("timers.supervisor_alert_failed", { worldId: timer.worldId, errorName: errorNameOf(error) }));
    }
    return { status: "DONE", action: effect.action };
  }
  return { status: "SKIPPED", reason: "COMPLAINT_KEPT_MOVING" };
}

async function autoClose(timer: Timer, event: TimerQueueEvent, deps: TimerEffectDeps): Promise<TimerEventOutcome> {
  const { complaintId } = AutoClosePayload.parse(timer.payload);
  const complaint = await deps.connector.complaints.get(timer.worldId, complaintId, { consistent: true });
  if (complaint?.status !== "ANSWERED") return { status: "SKIPPED", reason: complaint ? `COMPLAINT_${complaint.status}` : "COMPLAINT_MISSING" };
  try {
    await transition(deps.complaints, { worldId: timer.worldId, complaintId, to: "CLOSED", cause: "AUTO_CLOSE", actor: "SYSTEM", atSim: event.eventAtSim, complaint });
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (code === "CONFLICT" || code === "NOT_ELIGIBLE") return { status: "SKIPPED", reason: `AUTO_CLOSE_${String(code)}` };
    throw error;
  }
  return { status: "DONE", action: "AUTO_CLOSED" };
}

/** The kept request, as far as the timer can vouch for it: same world and customer as the timer. */
const KeptRequest = z.looseObject({ worldId: z.string(), customerId: z.string(), sender: z.string(), channel: z.enum(["WHATSAPP", "EMAIL"]), kind: z.string(), refs: z.record(z.string(), z.string()) });

async function deferredSend(timer: Timer, event: TimerQueueEvent, deps: TimerEffectDeps): Promise<TimerEventOutcome> {
  const payload = DeferredSendPayload.parse(timer.payload);
  const kept = KeptRequest.safeParse(payload.request);
  const actor = Actor.safeParse(payload.actor);
  if (!kept.success || !actor.success || kept.data.worldId !== timer.worldId || kept.data.customerId !== payload.customerId || payload.customerId !== event.customerId) {
    deps.log.error("timers.deferred_invalid", { worldId: timer.worldId, timerId: timer.timerId });
    return { status: "SKIPPED", reason: "DEFERRED_REQUEST_INVALID" };
  }
  const request = { ...payload.request, refs: { ...kept.data.refs, deferredTimerId: timer.timerId } } as unknown as OutboundRequest;
  const outcome = await deps.gate(request, { actor: actor.data, correlationId: deps.log.correlationId, log: deps.log });
  return outcome.ok ? { status: "DONE", action: `DEFERRED_SEND_${outcome.decision}` } : { status: "SKIPPED", reason: `DEFERRED_SEND_${outcome.decision ?? outcome.failure.error.code}` };
}

/** Runs one `TIMER` event of the customer queue (the worker calls it for `type = TIMER`). */
export async function runTimerEvent(event: TimerQueueEvent, deps: TimerEffectDeps): Promise<TimerEventOutcome> {
  const { kind, timerId, version } = event.payload;
  const timer = await deps.connector.timers.get({ worldId: event.worldId, kind, timerId }, { consistent: true });
  if (!timer || timer.status !== "FIRED" || timer.version !== version + 1 || timer.epoch !== event.epoch) {
    deps.log.info("timers.event_stale", { worldId: event.worldId, kind, eventId: event.eventId });
    return { status: "DISCARDED", reason: "STALE_EVENT" };
  }
  switch (timer.kind) {
    case "SLA":
      return slaMilestone(timer, event, deps);
    case "AUTO_CLOSE":
      return autoClose(timer, event, deps);
    case "DEFERRED_SEND":
      return deferredSend(timer, event, deps);
    case "FOLLOW_UP":
      return { status: "TURN", reason: "FOLLOW_UP", complaintId: FollowUpPayload.parse(timer.payload).complaintId };
    default:
      return { status: "SKIPPED", reason: `NOT_A_WORKER_KIND_${timer.kind}` };
  }
}
