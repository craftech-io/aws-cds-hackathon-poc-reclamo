// The worker's deterministic handoff to a person (docs/architecture.md §7 and §9.1, docs/design-brief.md
// §8.1): a turn cut by a cap or the kill switch, a failed turn (fallback), a guardrail block, an
// obligation that the model did not fulfil and an email that could not be delivered. The model takes no
// part: the code picks the complaint, moves it to `HUMAN_REVIEW` with `transition()` (its register entry
// in the same transaction) and the handoff reason, or opens a human task on the conversation when the
// customer has no open complaint (a refusal before any complaint registers none), and sends the fixed
// `HANDOFF_NOTICE` through the gate unless the caller already sent the customer its own fixed message.
//
// Idempotent per event: a complaint already in `HUMAN_REVIEW` is left there, the task id and the
// notice's message id derive from the event, and the audit entry is written once.
import type { HandoffReason } from "@reclamo/shared";
import { ToolError } from "@reclamo/shared";
import type { ComplaintsDeps } from "../complaints/deps";
import { canTransition, transition } from "../complaints/state-machine";
import { isConflict } from "../connector/errors";
import type { Connector } from "../connector/port";
import type { Complaint } from "../domain/complaint";
import type { Logger } from "../lib/log";
import type { OutboundGate } from "../outbound/types";
import { OPEN_FOR_SESSION } from "../turns/facts";
import { WORKER_ACTIONS, auditOnce, countMetric } from "./audit";
import { derivedMessageId, handoffText, sendFixed } from "./notices";

export interface HandoffDeps {
  readonly data: Connector;
  readonly complaints: ComplaintsDeps;
  readonly gate: OutboundGate;
  readonly now: () => Date;
  readonly log: Logger;
}

export interface HandoffInput {
  readonly worldId: string;
  readonly customerId: string;
  readonly epoch: number;
  readonly eventId: string;
  readonly eventAtSim: string;
  readonly correlationId?: string;
  readonly reason: HandoffReason;
  /** For the operator: a fixed text of the worker, never the customer's words. */
  readonly summary: string;
  /** The complaint to hand off; the customer's most recent open one when absent. */
  readonly complaintId?: string;
  /** `false` when the caller already sent the customer its fixed message (a guardrail refusal). */
  readonly notify: boolean;
  /** Why the worker hands off, for the audit (`TURN_CAP`, `AGENT_FALLBACK`, `GUARDRAIL_BLOCK`…). */
  readonly cause: string;
  /** The customer's inbound message the notice answers: a reply inside the window, not a proactive contact. */
  readonly answers?: string;
}

export interface HandoffResult {
  readonly complaint?: Complaint;
  readonly taskId?: string;
  readonly noticeMessageId?: string;
}

/** The complaint a handoff applies to: the named one of the customer, or the most recent open one. */
export async function handoffTarget(data: Pick<Connector, "complaints">, input: Pick<HandoffInput, "worldId" | "customerId" | "complaintId">): Promise<Complaint | undefined> {
  if (input.complaintId !== undefined) {
    const named = await data.complaints.get(input.worldId, input.complaintId, { consistent: true });
    if (named !== undefined && named.customerId === input.customerId) return named;
  }
  const mine = await data.complaints.listByCustomer(input.worldId, input.customerId, 50);
  return mine.filter((complaint) => OPEN_FOR_SESSION.has(complaint.status)).sort((a, b) => Date.parse(b.filedAtSim) - Date.parse(a.filedAtSim))[0];
}

async function toHumanReview(deps: HandoffDeps, input: HandoffInput, complaint: Complaint): Promise<Complaint> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = attempt === 0 ? complaint : await deps.data.complaints.get(input.worldId, complaint.complaintId, { consistent: true });
    if (current === undefined || current.status === "HUMAN_REVIEW" || !canTransition(current.status, "HUMAN_REVIEW")) return current ?? complaint;
    try {
      const moved = await transition(deps.complaints, {
        worldId: input.worldId,
        complaintId: current.complaintId,
        to: "HUMAN_REVIEW",
        cause: `HANDOFF_${input.reason}`,
        actor: "SYSTEM",
        atSim: input.eventAtSim,
        complaint: current,
        patch: { handoff: { reason: input.reason, atSim: input.eventAtSim, summary: input.summary.slice(0, 500) }, ...(input.reason === "FRAUD" ? { priority: "HIGH" as const } : {}) },
      });
      return moved.complaint;
    } catch (error) {
      // The status moved under us (another writer of the same customer): re-read once and decide again.
      if (!(error instanceof ToolError && error.code === "CONFLICT")) throw error;
    }
  }
  return complaint;
}

async function openTask(deps: HandoffDeps, input: HandoffInput): Promise<string> {
  const taskId = `task-${derivedMessageId(input.eventId, `HANDOFF_${input.reason}`).slice(2, 26)}`;
  const op = deps.data.conversations.putTaskOp({ worldId: input.worldId, customerId: input.customerId, taskId, atSim: input.eventAtSim, author: "SYSTEM", text: input.summary.slice(0, 2_000), task: { status: "OPEN" } });
  try {
    await deps.data.write(op);
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  return taskId;
}

/** Hands the customer's matter to a person: complaint to `HUMAN_REVIEW`, or a task, and the notice. */
export async function handOff(deps: HandoffDeps, input: HandoffInput): Promise<HandoffResult> {
  const target = await handoffTarget(deps.data, input);
  const complaint = target === undefined ? undefined : await toHumanReview(deps, input, target);
  const taskId = complaint === undefined ? await openTask(deps, input) : undefined;
  let noticeMessageId: string | undefined;
  if (input.notify) {
    const outcome = await sendFixed(deps.gate, deps.log, input, { kind: "HANDOFF_NOTICE", text: handoffText(complaint), purpose: `HANDOFF_NOTICE_${input.cause}`, ...(complaint === undefined ? {} : { complaintId: complaint.complaintId }), ...(input.answers === undefined ? {} : { answers: input.answers }) });
    noticeMessageId = outcome.messageId;
  }
  await auditOnce(deps, {
    action: WORKER_ACTIONS.handoff,
    worldId: input.worldId,
    epoch: input.epoch,
    eventId: input.eventId,
    atSim: input.eventAtSim,
    outcome: input.reason,
    refs: { customerId: input.customerId, cause: input.cause, ...(complaint === undefined ? {} : { complaintId: complaint.complaintId }), ...(taskId === undefined ? {} : { taskId }) },
    detail: { notified: noticeMessageId !== undefined },
  });
  countMetric(deps.log, "WorkerHandoffs", { reason: input.reason, cause: input.cause });
  return { ...(complaint === undefined ? {} : { complaint }), ...(taskId === undefined ? {} : { taskId }), ...(noticeMessageId === undefined ? {} : { noticeMessageId }) };
}
