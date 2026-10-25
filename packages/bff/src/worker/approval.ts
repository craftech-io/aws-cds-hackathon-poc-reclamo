// `execute_approved_action` (docs/architecture.md §8.5, FL-024, FL-087): the only way money moves after a
// person approved it. The `APPROVAL_DECIDED` event carries only the approval's locator; the decision, the
// amount and the action are re-read, never taken from the payload, so a forged or repeated event ends in
// `APPROVAL_NOT_EXECUTABLE` and moves nothing.
//
//   1. strongly consistent read of the `Approval` (and its complaint, of the event's customer): it must be
//      `APPROVED`, decided by a staff member, of the world's current epoch, not expired and not executed;
//   2. one transaction: `SET executedAt` on the approval (conditional) and `Put EXEC#<approvalId>`
//      (`attribute_not_exists`): one execution however many events arrive;
//   3. the amount recomputed by the core with the same evidence and the tier with the world's current caps:
//      more than approved, another action or another tier → `HUMAN_REVIEW` (`ABOVE_CAP`) without executing;
//   4. the core with the approval's idempotency key: its natural-key claim answers `CONFLICT` with the
//      existing action to a second complaint over the same debit, charge or transfer;
//   5. the complaint `AWAITING_APPROVAL → RESOLVED` with its register entry, and `ACTION EXECUTED`.
//
// A delivery that failed after step 2 (the core was down) is resumed by its redelivery: the execution
// claim exists, the complaint is still `AWAITING_APPROVAL`, and the core's idempotency key makes the
// second call answer the first one's result. A delivery that moved the money and resolved the complaint
// but failed later (the customer's turn was throttled) is finished by its redelivery too: the claim names
// this same event and the complaint holds the approval's `ACT#`, so the recorded outcome is returned and
// the dispatcher runs the turn and its obligations again. Another event over the same approval never
// resumes anything. A lapsed pending approval goes back to a person.
import { countAutomaticReversals, checkExecutable, evaluateCap, recheckApproved } from "../complaints/caps";
import { transition } from "../complaints/state-machine";
import { isConflict } from "../connector/errors";
import type { Action, Approval, Execution } from "../domain/case-items";
import type { Complaint } from "../domain/complaint";
import { WORKER_ACTIONS, auditOnce } from "./audit";
import { type HandoffDeps, handOff } from "./escalation";
import type { EventOf } from "./events";
import type { ApprovedMoneyActions, WorkerContext } from "./ports";

export interface ApprovalDeps extends HandoffDeps {
  readonly money: ApprovedMoneyActions;
}

export type ExecutionOutcome =
  | { readonly status: "EXECUTED" | "CONFLICT"; readonly actionId: string; readonly complaint: Complaint }
  | { readonly status: "NOT_EXECUTABLE"; readonly block: string }
  | { readonly status: "REFUSED"; readonly reason: string };

type Event = EventOf<"APPROVAL_DECIDED">;

async function notExecutable(deps: ApprovalDeps, event: Event, block: string): Promise<ExecutionOutcome> {
  await auditOnce(deps, { action: WORKER_ACTIONS.approvalNotExecutable, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, ruleIds: ["CAP"], outcome: block, refs: { customerId: event.customerId, complaintId: event.payload.complaintId, approvalId: event.payload.approvalId } });
  deps.log.warn("approval.not_executable", { block });
  return { status: "NOT_EXECUTABLE", block };
}

/** Step 2: the approval marked executed and `EXEC#` written together; `false` when another delivery did it. */
async function claimExecution(deps: ApprovalDeps, event: Event, approval: Approval): Promise<boolean> {
  try {
    await deps.data.transact([
      deps.data.caseItems.markExecutedOp(event.worldId, approval.complaintId, approval.approvalId, deps.now().toISOString()),
      deps.data.caseItems.putExecutionOp({ worldId: event.worldId, complaintId: approval.complaintId, approvalId: approval.approvalId, executedAtReal: deps.now().toISOString(), executedAtSim: event.eventAtSim, eventId: event.eventId }),
    ]);
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

/** Step 3: the core's amount for the same evidence and the tier of the world's caps now. */
async function recheck(deps: ApprovalDeps, event: Event, approval: Approval, complaint: Complaint): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const settings = await deps.data.worlds.getSettings(event.worldId);
  if (settings === undefined) return { ok: false, reason: "NO_SETTINGS" };
  const quote = await deps.money.quote(approval, complaint, { atSim: event.eventAtSim, correlationId: event.correlationId ?? event.eventId });
  const reversals = await countAutomaticReversals(deps.data, { worldId: event.worldId, customerId: event.customerId, simNow: event.eventAtSim });
  const recomputed = evaluateCap({ action: quote.action, amountCents: quote.amountCents, caps: settings.caps, automaticReversalsIn30Days: reversals });
  return recheckApproved(approval, recomputed);
}

async function refuse(deps: ApprovalDeps, event: Event, complaint: Complaint, reason: string): Promise<ExecutionOutcome> {
  await handOff(deps, { worldId: event.worldId, customerId: event.customerId, epoch: event.epoch, eventId: event.eventId, eventAtSim: event.eventAtSim, reason: "ABOVE_CAP", summary: `ABOVE_CAP · ${reason}`, complaintId: complaint.complaintId, notify: true, cause: "EXECUTION_REFUSED" });
  await auditOnce(deps, { action: WORKER_ACTIONS.executionRefused, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, ruleIds: ["CAP"], outcome: reason, refs: { customerId: event.customerId, complaintId: complaint.complaintId, approvalId: event.payload.approvalId } });
  return { status: "REFUSED", reason };
}

/** Step 5's audit: the action executed (or found already executed by the core), once per event. */
async function auditExecuted(deps: ApprovalDeps, event: Event, approval: Approval, executed: { readonly status: "EXECUTED" | "CONFLICT"; readonly actionId: string }, resumed: boolean): Promise<void> {
  await auditOnce(deps, {
    action: WORKER_ACTIONS.actionExecuted,
    worldId: event.worldId,
    epoch: event.epoch,
    eventId: event.eventId,
    atSim: event.eventAtSim,
    ruleIds: ["CAP"],
    outcome: executed.status,
    refs: { customerId: event.customerId, complaintId: approval.complaintId, approvalId: approval.approvalId, actionId: executed.actionId, decidedBy: approval.decidedBy ?? "" },
    detail: { action: approval.action, tier: approval.capTier, resumed },
  });
}

/** A redelivery of the event that already moved the money: its recorded outcome, so the turn runs again. */
async function finishedByThisEvent(deps: ApprovalDeps, event: Event, approval: Approval, complaint: Complaint, execution: Execution): Promise<ExecutionOutcome | undefined> {
  if (execution.eventId !== event.eventId || complaint.status === "AWAITING_APPROVAL") return undefined;
  const actions = await deps.data.caseItems.listActions(event.worldId, complaint.complaintId);
  const action = actions.find((row): row is Action & { readonly status: "EXECUTED" | "CONFLICT" } => row.approvalId === approval.approvalId && (row.status === "EXECUTED" || row.status === "CONFLICT"));
  if (action === undefined) return undefined;
  await auditExecuted(deps, event, approval, { status: action.status, actionId: action.actionId }, true);
  deps.log.info("approval.redelivery_finished", { status: action.status });
  return { status: action.status, actionId: action.actionId, complaint };
}

async function resolveComplaint(deps: ApprovalDeps, event: Event, complaint: Complaint, approval: Approval): Promise<Complaint> {
  if (complaint.status !== "AWAITING_APPROVAL") return complaint;
  const moved = await transition(deps.complaints, { worldId: event.worldId, complaintId: complaint.complaintId, to: "RESOLVED", cause: "APPROVAL_EXECUTED", actor: `OPERATOR:${approval.decidedBy ?? "stf-unknown"}`, atSim: event.eventAtSim });
  return moved.complaint;
}

export async function executeApprovedAction(deps: ApprovalDeps, _ctx: WorkerContext, event: Event): Promise<ExecutionOutcome> {
  const { complaintId, approvalId } = event.payload;
  const [complaint, approval, meta] = await Promise.all([
    deps.data.complaints.get(event.worldId, complaintId, { consistent: true }),
    deps.data.caseItems.getApproval(event.worldId, complaintId, approvalId),
    deps.data.worlds.getMeta(event.worldId, { consistent: true }),
  ]);
  if (complaint === undefined || approval === undefined || meta === undefined || complaint.customerId !== event.customerId) return notExecutable(deps, event, "NOT_FOUND");
  const check = checkExecutable(approval, { epoch: meta.epoch, simNow: event.eventAtSim });
  let resumed = false;
  if (!check.ok) {
    const execution = check.block === "ALREADY_EXECUTED" && approval.epoch === meta.epoch ? await deps.data.caseItems.getExecution(event.worldId, complaintId, approvalId) : undefined;
    // A delivery that claimed the execution and then failed: the redelivery finishes it (the core is idempotent).
    resumed = execution !== undefined && complaint.status === "AWAITING_APPROVAL";
    const finished = execution === undefined ? undefined : await finishedByThisEvent(deps, event, approval, complaint, execution);
    if (finished !== undefined) return finished;
    if (!resumed) {
      const outcome = await notExecutable(deps, event, check.block);
      if (check.block === "EXPIRED" || check.block === "OTHER_EPOCH") await lapseApproval(deps, event, complaint);
      return outcome;
    }
  }
  if (!resumed && !(await claimExecution(deps, event, approval))) return notExecutable(deps, event, "ALREADY_EXECUTED");
  const rechecked = await recheck(deps, event, approval, complaint);
  if (!rechecked.ok) return refuse(deps, event, complaint, rechecked.reason);
  const executed = await deps.money.execute(approval, complaint, { atSim: event.eventAtSim, correlationId: event.correlationId ?? event.eventId, idempotencyKey: `apr-${approvalId}` });
  // The core could not act: the event is retried, and the redelivery resumes from the claim. A refusal
  // of the core (not eligible any more, above what it allows) goes to a person instead.
  if (executed.status === "FAILED" && executed.retryable) throw new Error(`the approved action could not run: ${executed.reason}`);
  if (executed.status === "FAILED") return refuse(deps, event, complaint, executed.reason);
  const resolved = await resolveComplaint(deps, event, complaint, approval);
  await auditExecuted(deps, event, approval, executed, resumed);
  return { status: executed.status, actionId: executed.actionId, complaint: resolved };
}

/** An approval past its expiry or of another epoch goes back to a person (§8.5). */
async function lapseApproval(deps: ApprovalDeps, event: Event, complaint: Complaint): Promise<void> {
  if (complaint.status !== "AWAITING_APPROVAL") return;
  await handOff(deps, { worldId: event.worldId, customerId: event.customerId, epoch: event.epoch, eventId: event.eventId, eventAtSim: event.eventAtSim, reason: "ABOVE_CAP", summary: "APPROVAL_LAPSED", complaintId: complaint.complaintId, notify: true, cause: "APPROVAL_LAPSED" });
}
