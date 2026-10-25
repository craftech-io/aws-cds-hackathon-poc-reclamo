// What the worker does with each event type (docs/architecture.md §7):
//
//   CUSTOMER_MESSAGE, OPERATOR_RELEASED, ANSWER_DUE, RECONCILE_DUE   a turn (worker/run-turn.ts)
//   RECEIPT_RECEIVED          the image filed as `RECEIPT_IMAGE` evidence of the open complaint
//                             (worker/receipt.ts), AWAITING_CUSTOMER → INVESTIGATING, then a turn with
//                             the image's line; without an open complaint, no second turn
//   SETTLEMENT_PUBLISHED      the code reconciles the waiting complaint first: still PENDING_BATCH → no
//                             turn; anything else → AWAITING_SETTLEMENT → INVESTIGATING and a turn; a
//                             redelivery whose turn failed finds its own transition and only runs the turn
//   TRANSFER_STATUS_CHANGED   AWAITING_NETWORK → INVESTIGATING, then a turn
//   APPROVAL_DECIDED          `execute_approved_action` (worker/approval.ts); only an executed action
//                             gets the turn that tells the customer and answers in writing
//   MEDIA_REJECTED            the fixed reply the payload names (`IMAGE_NOT_PROCESSED`, `MEDIA_TOO_LARGE`,
//                             `MEDIA_UNSUPPORTED`) through the gate, no turn, no reading
//   TIMER                     `fire_timer` (timers/), `eventAtSim = dueAtSim`, deterministic
//   OPERATOR_SEND             the gate with `sender OPERATOR:<staffId>` (an active case-work staff row); with
//                             `route`, the reroute of the blocked entry `rerouteOf` (outbound/reroute.ts)
//   OPERATOR_ANSWER           the written answer of an operator, through the answer pipeline and the gate
//   EMAIL_EVENT               `record_email_event`; a bounce sends the fixed update through the gate
//   WA_STATUS                 the status of one of our WhatsApp messages (channels/whatsapp/events.ts)
//   HEALTH_PROBE, POISON      QA only: the mocks' health with the worker's role; a deliberate failure
import { ToolError } from "@reclamo/shared";
import { transition } from "../complaints/state-machine";
import { applyStatus } from "../channels/whatsapp/events";
import type { WaStatus } from "../channels/whatsapp/payloads";
import { applyEmailEvent } from "../email-events/apply";
import type { Complaint } from "../domain/complaint";
import { worldClock } from "../lib/clock";
import { WORKER_ACTIONS, auditOnce } from "./audit";
import { executeApprovedAction } from "./approval";
import { queueFor } from "./enqueue";
import type { CustomerEvent, EventOf, TurnEvent } from "./events";
import { derivedMessageId, sendFixed, whatsappText } from "./notices";
import type { WorkerContext, WorkerDeps } from "./ports";
import { fileReceipt } from "./receipt";
import { runTurnEvent } from "./run-turn";

/** Where the delivery came from: what a `POISON` needs to release itself at once. */
export interface DeliveryRef {
  readonly receiptHandle: string;
  readonly queueUrl?: string;
}

export type DispatchContext = WorkerContext & { readonly deadlineMs: number; readonly delivery: DeliveryRef };

/** Roles that do case work in a world (routers/roles.ts `CASE_WORK`). */
const CASE_WORK = new Set(["OPERATOR", "SUPERVISOR", "GUEST"]);

/** A status the worker moves a complaint out of before the turn, when the event says the wait is over. */
async function resume(deps: WorkerDeps, event: TurnEvent, complaintId: string, from: Complaint["status"], cause: string): Promise<Complaint | undefined> {
  const complaint = await deps.data.complaints.get(event.worldId, complaintId, { consistent: true });
  if (complaint === undefined || complaint.customerId !== event.customerId) return undefined;
  if (complaint.status !== from) return complaint;
  try {
    return (await transition(deps.complaints, { worldId: event.worldId, complaintId, to: "INVESTIGATING", cause, actor: "SYSTEM", atSim: event.eventAtSim, complaint })).complaint;
  } catch (error) {
    if (error instanceof ToolError && error.code === "CONFLICT") return deps.data.complaints.get(event.worldId, complaintId, { consistent: true });
    throw error;
  }
}

/** This event already moved the complaint out of its wait: a redelivery whose turn failed resumes at the turn. */
function resumedBy(complaint: Complaint, event: TurnEvent, cause: string): boolean {
  const at = Date.parse(event.eventAtSim);
  return complaint.status === "INVESTIGATING" && complaint.statusHistory.some((change) => change.to === "INVESTIGATING" && change.cause === cause && Date.parse(change.atSim) === at);
}

async function settlementPublished(deps: WorkerDeps, ctx: DispatchContext, event: EventOf<"SETTLEMENT_PUBLISHED">): Promise<void> {
  const complaint = await deps.data.complaints.get(event.worldId, event.payload.complaintId, { consistent: true });
  if (complaint !== undefined && complaint.customerId === event.customerId && resumedBy(complaint, event, "SETTLEMENT_PUBLISHED")) {
    ctx.log.info("settlement.turn_resumed");
    await runTurnEvent(deps, ctx, event);
    return;
  }
  if (complaint === undefined || complaint.customerId !== event.customerId || complaint.status !== "AWAITING_SETTLEMENT") {
    ctx.log.info("settlement.nothing_waiting", { status: complaint?.status ?? "NONE" });
    return;
  }
  const readings = (await deps.data.caseItems.listEvidence(event.worldId, complaint.complaintId)).filter((item) => item.kind === "RECEIPT_READING" && item.details["result"] === "READ");
  const reading = readings.sort((a, b) => Date.parse(b.atSim) - Date.parse(a.atSim))[0];
  if (reading !== undefined) {
    const outcome = await deps.handlers.reconcile({ worldId: event.worldId, customerId: event.customerId, complaint, readingEvidenceId: reading.evidenceId, eventId: event.eventId, atSim: event.eventAtSim }, ctx);
    await auditOnce({ data: deps.data, now: ctx.now, log: ctx.log }, { action: WORKER_ACTIONS.reconciledByCode, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, outcome: outcome.result, refs: { customerId: event.customerId, complaintId: complaint.complaintId } });
    if (outcome.result === "PENDING_BATCH") return;
  }
  await resume(deps, event, complaint.complaintId, "AWAITING_SETTLEMENT", "SETTLEMENT_PUBLISHED");
  await runTurnEvent(deps, ctx, event);
}

async function activeCaseWorker(deps: WorkerDeps, ctx: DispatchContext, event: EventOf<"OPERATOR_SEND" | "OPERATOR_ANSWER">): Promise<boolean> {
  const staff = await deps.data.worlds.getStaff(event.worldId, event.payload.staffId);
  if (staff !== undefined && staff.active && CASE_WORK.has(staff.role)) return true;
  await auditOnce({ data: deps.data, now: ctx.now, log: ctx.log }, { action: WORKER_ACTIONS.operatorRefused, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, ruleIds: ["CH-SENDER"], refs: { customerId: event.customerId, staffId: event.payload.staffId, type: event.type } });
  return false;
}

async function operatorSend(deps: WorkerDeps, ctx: DispatchContext, event: EventOf<"OPERATOR_SEND">): Promise<void> {
  if (!(await activeCaseWorker(deps, ctx, event))) return;
  const { payload } = event;
  const sender = `OPERATOR:${payload.staffId}` as const;
  const call = { actor: sender, correlationId: event.correlationId ?? event.eventId, log: ctx.log };
  if (payload.route !== undefined && payload.rerouteOf !== undefined) {
    const rerouted = await deps.reroute({ worldId: event.worldId, customerId: event.customerId, tapeId: payload.rerouteOf, route: payload.route, by: sender, messageId: payload.messageId }, call);
    ctx.log.info("operator_reroute.decided", { ok: rerouted.ok, decision: rerouted.ok ? rerouted.decision : rerouted.decision ?? "UNDECIDED", route: payload.route });
    return;
  }
  const outcome = await deps.gate(
    {
      worldId: event.worldId,
      customerId: event.customerId,
      ...(payload.complaintId === undefined ? {} : { complaintId: payload.complaintId }),
      sender,
      channel: payload.channel,
      kind: payload.kind,
      ...(payload.text === undefined ? {} : { text: payload.text }),
      ...(payload.template === undefined ? {} : { template: payload.template }),
      ...(payload.subject === undefined ? {} : { subject: payload.subject }),
      refs: { eventId: event.eventId, staffId: payload.staffId },
      triggerEventId: event.eventId,
      ...(payload.rerouteOf === undefined ? {} : { rerouteOf: payload.rerouteOf }),
      messageId: payload.messageId,
    },
    call,
  );
  ctx.log.info("operator_send.decided", { ok: outcome.ok, decision: outcome.ok ? outcome.decision : outcome.decision ?? "UNDECIDED", kind: payload.kind });
}

async function operatorAnswer(deps: WorkerDeps, ctx: DispatchContext, event: EventOf<"OPERATOR_ANSWER">): Promise<void> {
  if (!(await activeCaseWorker(deps, ctx, event))) return;
  const complaint = await deps.data.complaints.get(event.worldId, event.payload.complaintId, { consistent: true });
  if (complaint === undefined || complaint.customerId !== event.customerId) {
    ctx.log.warn("operator_answer.no_complaint");
    return;
  }
  await deps.handlers.writtenAnswer({ event, complaint, actor: `OPERATOR:${event.payload.staffId}` }, ctx);
}

async function emailEvent(deps: WorkerDeps, ctx: DispatchContext, event: EventOf<"EMAIL_EVENT">): Promise<void> {
  const clock = worldClock(event.worldId, deps.data.runtime.clockState);
  const result = await applyEmailEvent(event.payload, { connector: deps.data, effects: deps.handlers.emailEffects(event, ctx), simNow: () => clock.now(), now: ctx.now, log: ctx.log });
  if (result.outcome !== "APPLIED" || result.notify === undefined) return;
  const notice = result.notify;
  const outcome = await deps.gate(
    {
      worldId: notice.worldId,
      customerId: notice.customerId,
      complaintId: notice.complaintId,
      sender: "SYSTEM",
      channel: notice.channel,
      kind: notice.kind,
      template: { name: notice.template, params: [...notice.params] },
      refs: { eventId: event.eventId, mailId: event.payload.mailId },
      triggerEventId: event.eventId,
      messageId: derivedMessageId(event.eventId, "EMAIL_UNDELIVERED"),
    },
    { actor: "SYSTEM", correlationId: event.correlationId ?? event.eventId, log: ctx.log },
  );
  ctx.log.info("email_event.notice", { ok: outcome.ok });
}

async function waStatus(deps: WorkerDeps, ctx: DispatchContext, event: EventOf<"WA_STATUS">): Promise<void> {
  // The phone never travels in a queue message; `applyStatus` reads the message by its provider id only.
  const status = { ...event.payload.status, recipient_id: "00000000" } as WaStatus;
  const scope = event.payload.simulated ? { simulated: true as const, worldId: event.worldId } : { simulated: false as const, isLiveWorld: async (worldId: string) => worldId === event.worldId };
  const outcome = await applyStatus(status, { data: deps.data, log: ctx.log }, scope);
  ctx.log.info("wa_status.applied", { outcome: outcome.outcome });
}

async function healthProbe(deps: WorkerDeps, ctx: DispatchContext, event: EventOf<"HEALTH_PROBE">): Promise<void> {
  const health = await deps.handlers.healthProbe(event, ctx);
  await deps.data.claims.putProbe({ probeId: event.payload.probeId, atReal: ctx.now().toISOString(), data: { core: health.core, networks: health.networks, worldId: event.worldId } });
}

async function poison(deps: WorkerDeps, ctx: DispatchContext, event: EventOf<"POISON">): Promise<never> {
  if (ctx.delivery.queueUrl !== undefined) {
    try {
      await deps.queue.releaseNow(ctx.delivery.receiptHandle, ctx.delivery.queueUrl);
    } catch (error) {
      ctx.log.warn("poison.release_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }
  }
  throw new Error(`POISON ${event.eventId}: failing on purpose (FL-108)`);
}

export async function dispatchEvent(deps: WorkerDeps, ctx: DispatchContext, event: CustomerEvent): Promise<void> {
  switch (event.type) {
    case "CUSTOMER_MESSAGE":
    case "OPERATOR_RELEASED":
    case "ANSWER_DUE":
    case "RECONCILE_DUE":
      await runTurnEvent(deps, ctx, event);
      return;
    case "RECEIPT_RECEIVED": {
      const filed = await fileReceipt(deps.data, ctx, event);
      if (filed?.payload.complaintId === undefined) return;
      await resume(deps, filed, filed.payload.complaintId, "AWAITING_CUSTOMER", "RECEIPT_RECEIVED");
      await runTurnEvent(deps, ctx, filed);
      return;
    }
    case "TRANSFER_STATUS_CHANGED":
      await resume(deps, event, event.payload.complaintId, "AWAITING_NETWORK", "NETWORK_STATUS_CHANGED");
      await runTurnEvent(deps, ctx, event);
      return;
    case "SETTLEMENT_PUBLISHED":
      return settlementPublished(deps, ctx, event);
    case "APPROVAL_DECIDED": {
      const executed = await executeApprovedAction({ data: deps.data, complaints: deps.complaints, gate: deps.gate, now: ctx.now, log: ctx.log, money: deps.handlers.money }, ctx, event);
      if (executed.status === "EXECUTED" || executed.status === "CONFLICT") await runTurnEvent(deps, ctx, event);
      return;
    }
    case "MEDIA_REJECTED":
      await sendFixed(deps.gate, ctx.log, event, { kind: "REPLY", text: whatsappText(event.payload.reply), purpose: "MEDIA_REJECTED" });
      return;
    case "TIMER":
      return deps.handlers.fireTimer(event, ctx);
    case "OPERATOR_SEND":
      return operatorSend(deps, ctx, event);
    case "OPERATOR_ANSWER":
      return operatorAnswer(deps, ctx, event);
    case "EMAIL_EVENT":
      return emailEvent(deps, ctx, event);
    case "WA_STATUS":
      return waStatus(deps, ctx, event);
    case "HEALTH_PROBE":
    case "POISON":
      // QA only (worker/enqueue.ts refuses them elsewhere); anything else is dropped, never run.
      if (queueFor(event.worldId) !== "QaCustomerEvents") {
        ctx.log.warn("qa_event.outside_qa", { type: event.type });
        return;
      }
      return event.type === "HEALTH_PROBE" ? healthProbe(deps, ctx, event) : poison(deps, ctx, event);
  }
}
