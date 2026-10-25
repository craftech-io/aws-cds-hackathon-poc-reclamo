// The hand-overs the code decides on its own, inside a tool (docs/tool-catalog.md): `verify_challenge`
// with a second failure (`IDENTITY_VERIFICATION`, FL-004) and `reconcile_payment` with a line of another
// payer (`RECEIPT_DOUBT`, FL-111). The model is not asked to escalate: the handler does it, the same way
// `escalate_to_human` would.
//
//   1. every working complaint of the call moves to `HUMAN_REVIEW` with its `handoff` (reason and
//      simulated instant), through `transition()` and its register entry (complaints/state-machine.ts);
//      one already in `HUMAN_REVIEW` keeps its status and takes the code's reason; without a complaint,
//      the conversation gets a human task;
//   2. one fixed `HANDOFF_NOTICE` of copy/ goes to the customer through the outbound gate as `SYSTEM`,
//      with a message id derived from the event, so a retried call never sends it twice;
//   3. the decision is audited by the calling tool.
//
// A refused or unavailable gate does not undo the hand-over: the case is already in a person's queue
// and the worker's obligations still see it.
import type { HandoffReason } from "@reclamo/shared";
import { WHATSAPP_TEXT } from "../../copy";
import { fill } from "../../copy/helpers";
import type { ComplaintsDeps } from "../../complaints/deps";
import { deadlineText } from "../../complaints/sla";
import { allowedFrom, transition } from "../../complaints/state-machine";
import type { Complaint } from "../../domain/complaint";
import { sha256Hex } from "../../lib/crypto";
import type { OutboundGate } from "../../outbound/types";
import type { ToolContext } from "../common/context";

export interface HandoffPorts {
  /** Connector, chain key and anchors of complaints/ (the transition writes the register). */
  readonly complaints: () => ComplaintsDeps;
  readonly gate: OutboundGate;
}

export interface HandoffRequest {
  readonly reason: HandoffReason;
  /** Machine cause stored in the status history and the register (`CHALLENGE_LOCKED`, `PAYER_MISMATCH`). */
  readonly cause: string;
  /** The complaints to hand over (the session's open ones, or the one of the evidence). */
  readonly complaints: readonly Complaint[];
  /** For the operator; ids and codes only, never the customer's data. */
  readonly summary: string;
}

export interface HandoffOutcome {
  readonly handedOver: readonly string[];
  readonly handoffNoticeMessageId?: string;
  readonly noticeDecision?: string;
}

const HANDOFF_FROM = new Set(allowedFrom("HUMAN_REVIEW"));

/** A message id the same event and reason always derive (a retried call finds its own message). */
export function handoffNoticeId(triggerEventId: string, reason: HandoffReason, complaintId?: string): string {
  return `hn-${sha256Hex(`${triggerEventId}|${reason}|${complaintId ?? "-"}`).slice(0, 32)}`;
}

/**
 * A complaint a person already holds keeps its status, but the reason the code established (a locked
 * challenge, a receipt of another payer) replaces the one an earlier escalation guessed.
 */
async function restateReason(ports: HandoffPorts, ctx: ToolContext<unknown>, request: HandoffRequest, complaint: Complaint): Promise<void> {
  if (complaint.handoff?.reason === request.reason) return;
  const atSim = ctx.session.eventAtSim;
  try {
    await ports.complaints().connector.complaints.patch(complaint.worldId, complaint.complaintId, complaint.version, { handoff: { reason: request.reason, atSim, summary: request.summary } });
  } catch (error) {
    ctx.log.warn("tool.handoff_reason_skipped", { complaintId: complaint.complaintId, reason: request.reason, error });
  }
}

async function moveToHumanReview(ports: HandoffPorts, ctx: ToolContext<unknown>, request: HandoffRequest, complaint: Complaint): Promise<boolean> {
  if (complaint.status === "HUMAN_REVIEW") {
    await restateReason(ports, ctx, request, complaint);
    return true;
  }
  if (!HANDOFF_FROM.has(complaint.status)) return false;
  const atSim = ctx.session.eventAtSim;
  try {
    await transition(ports.complaints(), {
      worldId: complaint.worldId,
      complaintId: complaint.complaintId,
      to: "HUMAN_REVIEW",
      cause: request.cause,
      actor: "SYSTEM",
      atSim,
      complaint,
      patch: { handoff: { reason: request.reason, atSim, summary: request.summary } },
    });
    return true;
  } catch (error) {
    // Moved on under us (another writer already handed it over or answered it): nothing left to do.
    ctx.log.warn("tool.handoff_transition_skipped", { complaintId: complaint.complaintId, reason: request.reason, error });
    return false;
  }
}

async function addConversationTask(ports: HandoffPorts, ctx: ToolContext<unknown>, request: HandoffRequest): Promise<void> {
  const { connector } = ports.complaints();
  const atSim = ctx.session.eventAtSim;
  const taskId = `task-${sha256Hex(`${ctx.session.triggerEventId}|${request.reason}`).slice(0, 24)}`;
  try {
    await connector.write(connector.conversations.putTaskOp({ worldId: ctx.session.worldId, customerId: ctx.session.customerId, taskId, atSim, author: "SYSTEM", text: request.summary, task: { status: "OPEN" } }));
  } catch (error) {
    ctx.log.warn("tool.handoff_task_skipped", { reason: request.reason, error });
  }
}

export async function handOverByCode(ports: HandoffPorts, ctx: ToolContext<unknown>, request: HandoffRequest): Promise<HandoffOutcome> {
  const handedOver: string[] = [];
  for (const complaint of request.complaints) {
    if (await moveToHumanReview(ports, ctx, request, complaint)) handedOver.push(complaint.complaintId);
  }
  if (request.complaints.length === 0) await addConversationTask(ports, ctx, request);
  const first = request.complaints[0];
  const text = first === undefined ? WHATSAPP_TEXT.HANDOFF_NOTICE_NO_COMPLAINT : fill(WHATSAPP_TEXT.HANDOFF_NOTICE, { complaintNumber: first.complaintNumber, deadlineText: deadlineText(first.deadlineSim) });
  const messageId = handoffNoticeId(ctx.session.triggerEventId, request.reason, first?.complaintId);
  const outcome = await ports.gate(
    {
      worldId: ctx.session.worldId,
      customerId: ctx.session.customerId,
      ...(first === undefined ? {} : { complaintId: first.complaintId }),
      sender: "SYSTEM",
      channel: "WHATSAPP",
      kind: "HANDOFF_NOTICE",
      text,
      refs: { reason: request.reason, cause: request.cause, tool: ctx.tool },
      turnId: ctx.session.turnId,
      triggerEventId: ctx.session.triggerEventId,
      messageId,
    },
    { actor: "SYSTEM", correlationId: ctx.correlationId, log: ctx.log },
  );
  if (!outcome.ok) {
    ctx.log.warn("tool.handoff_notice_not_sent", { reason: request.reason, code: outcome.failure.error.code });
    return { handedOver, ...(outcome.decision === undefined ? {} : { noticeDecision: outcome.decision }) };
  }
  return { handedOver, handoffNoticeMessageId: outcome.messageId, noticeDecision: outcome.decision };
}
