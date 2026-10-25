// `run_obligations` (docs/architecture.md §7, docs/design-brief.md §8.1, FL-016, FL-107): after a turn
// the code checks what the complaint requires and does not leave it to the model, which may end a turn
// without the call the complaint needs.
//
//   a complaint RESOLVED, or with a money action executed, and no written    one `ANSWER_DUE` turn; if that
//   answer (a freeze of outgoing operations settles nothing: it owes none)   turn does not answer either:
//                                                                            HUMAN_REVIEW `OTHER` + notice,
//                                                                            `ANSWER_OBLIGATION_FAILED`
//   PAYMENT_NOT_REFLECTED with a `READ` reading of this turn and no          the code reconciles: PENDING_BATCH
//   reconciliation of this turn                                              waits for the batch, MATCHED →
//                                                                            `RECONCILE_DUE`, a mismatch → a person
//   a SETTLEMENT_PUBLISHED (or RECONCILE_DUE) turn with MATCHED and no       `RECONCILE_DUE` once; after it, a person
//   `apply_payment`
//   an account closure taken or a data change pending, with no               its confirmation email (confirmations.ts),
//   confirmation sent yet                                                    once per action
//   a customer, receipt, settlement, network or approval turn with no        `HOLDING_NOTICE` (or the handoff
//   outbound and no handoff                                                  if one already went), `AGENT_SILENT`
//
// "A second turn" means only these code-queued turns, never an extra customer message. Every obligation
// fires at most once per complaint and source event (`IDEMP#OBLIGATION#…`).
import type { Action } from "../domain/case-items";
import type { Complaint } from "../domain/complaint";
import { sha256Hex } from "../lib/crypto";
import type { TurnOutcome } from "../turns/deps";
import { WORKER_ACTIONS, auditOnce, countMetric } from "./audit";
import { confirmationKind, confirmationMessageId } from "./confirmations";
import { type HandoffDeps, handOff } from "./escalation";
import { type TurnEvent, answersOf } from "./events";
import { holdingText, sendFixed } from "./notices";
import type { EventHandlers, WorkerContext } from "./ports";

export const OBLIGATIONS_METRIC = "ObligationsFired";

/** Turns that must leave the customer with an answer, a derivation or a holding notice. */
export const SILENCE_TRIGGERS: ReadonlySet<TurnEvent["type"]> = new Set(["CUSTOMER_MESSAGE", "RECEIPT_RECEIVED", "SETTLEMENT_PUBLISHED", "TRANSFER_STATUS_CHANGED", "APPROVAL_DECIDED"]);

/** The actions that settle money and so owe the written answer; a freeze or a pending confirmation does not. */
export const ANSWERING_ACTIONS: ReadonlySet<Action["kind"]> = new Set(["APPLY_PAYMENT", "REVERSE_CHARGE", "REFUND_DUPLICATE", "TRANSFER_REVERSAL"]);

/** Complaint statuses past which nothing is owed by the agent. */
const SETTLED: ReadonlySet<Complaint["status"]> = new Set(["ANSWERED", "CLOSED", "HUMAN_REVIEW"]);

export type CompletedTurn = Extract<TurnOutcome, { kind: "COMPLETED" }>;

export interface ObligationDeps extends HandoffDeps {
  readonly handlers: Pick<EventHandlers, "reconcile" | "confirmAction">;
}

export type ObligationFired = "ANSWER_DUE" | "ANSWER_OBLIGATION_FAILED" | "RECONCILE_DUE" | "RECONCILE_OBLIGATION_FAILED" | "RECONCILED_BY_CODE" | "CONFIRMATION_SENT" | "AGENT_SILENT";

/** The event an obligation answers to: a queued obligation keeps its original source. */
export function sourceEventOf(event: TurnEvent): string {
  return event.type === "ANSWER_DUE" || event.type === "RECONCILE_DUE" ? event.payload.sourceEventId : event.eventId;
}

function obligationKey(kind: string, complaintId: string, sourceEventId: string): string {
  return `${kind}.${sha256Hex(`${complaintId}#${sourceEventId}`).slice(0, 40)}`;
}

async function enqueueOnce(deps: ObligationDeps, ctx: WorkerContext, event: TurnEvent, kind: "ANSWER_DUE" | "RECONCILE_DUE", complaint: Complaint): Promise<boolean> {
  const sourceEventId = sourceEventOf(event);
  const key = obligationKey(kind, complaint.complaintId, sourceEventId);
  const claim = await deps.data.claims.claimOnce(event.worldId, "OBLIGATION", key);
  if (!claim.first) return false;
  await ctx.enqueue({ type: kind, eventId: `obl-${key.toLowerCase().replace(/[^a-z0-9.-]/g, "")}`, worldId: event.worldId, customerId: event.customerId, epoch: event.epoch, eventAtSim: event.eventAtSim, ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }), payload: { complaintId: complaint.complaintId, sourceEventId } });
  await auditOnce(deps, { action: kind === "ANSWER_DUE" ? WORKER_ACTIONS.answerDue : WORKER_ACTIONS.reconcileDue, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, refs: { customerId: event.customerId, complaintId: complaint.complaintId, sourceEventId } });
  return true;
}

async function failObligation(deps: ObligationDeps, event: TurnEvent, complaint: Complaint, kind: "ANSWER_OBLIGATION_FAILED" | "RECONCILE_OBLIGATION_FAILED"): Promise<void> {
  await handOff(deps, { worldId: event.worldId, customerId: event.customerId, epoch: event.epoch, eventId: event.eventId, eventAtSim: event.eventAtSim, reason: "OTHER", summary: kind, complaintId: complaint.complaintId, notify: true, cause: kind });
  await auditOnce(deps, { action: kind === "ANSWER_OBLIGATION_FAILED" ? WORKER_ACTIONS.answerObligationFailed : WORKER_ACTIONS.reconcileObligationFailed, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, refs: { customerId: event.customerId, complaintId: complaint.complaintId } });
}

async function answerObligation(deps: ObligationDeps, ctx: WorkerContext, event: TurnEvent, complaint: Complaint, executedThisEvent: boolean): Promise<ObligationFired | undefined> {
  if (complaint.answer?.messageId !== undefined || complaint.answer?.inFlight !== undefined || SETTLED.has(complaint.status)) return undefined;
  if (complaint.status !== "RESOLVED" && !executedThisEvent) return undefined;
  if (event.type === "ANSWER_DUE" && event.payload.complaintId === complaint.complaintId) {
    await failObligation(deps, event, complaint, "ANSWER_OBLIGATION_FAILED");
    return "ANSWER_OBLIGATION_FAILED";
  }
  return (await enqueueOnce(deps, ctx, event, "ANSWER_DUE", complaint)) ? "ANSWER_DUE" : undefined;
}

async function reconcileObligation(deps: ObligationDeps, ctx: WorkerContext, event: TurnEvent, turn: CompletedTurn, complaint: Complaint): Promise<ObligationFired | undefined> {
  if (complaint.type !== "PAYMENT_NOT_REFLECTED" || SETTLED.has(complaint.status) || complaint.status === "AWAITING_SETTLEMENT") return undefined;
  const file = await deps.data.caseItems.caseFile(event.worldId, complaint.complaintId);
  const applied = file.actions.some((action) => action.kind === "APPLY_PAYMENT" && (action.status === "EXECUTED" || action.status === "CONFLICT"));
  if (applied) return undefined;
  const matched = file.evidence.some((item) => item.kind === "SETTLEMENT_MATCH" && item.details["result"] === "MATCHED");
  if (matched && (event.type === "SETTLEMENT_PUBLISHED" || event.type === "RECONCILE_DUE")) {
    if (event.type === "RECONCILE_DUE") {
      await failObligation(deps, event, complaint, "RECONCILE_OBLIGATION_FAILED");
      return "RECONCILE_OBLIGATION_FAILED";
    }
    return (await enqueueOnce(deps, ctx, event, "RECONCILE_DUE", complaint)) ? "RECONCILE_DUE" : undefined;
  }
  const reading = file.evidence.find((item) => item.kind === "RECEIPT_READING" && item.turnId === turn.turnId && item.details["result"] === "READ");
  const reconciledNow = file.evidence.some((item) => item.kind === "SETTLEMENT_MATCH" && item.turnId === turn.turnId);
  if (reading === undefined || reconciledNow) return undefined;
  const outcome = await deps.handlers.reconcile({ worldId: event.worldId, customerId: event.customerId, complaint, readingEvidenceId: reading.evidenceId, eventId: event.eventId, atSim: event.eventAtSim }, ctx);
  await auditOnce(deps, { action: WORKER_ACTIONS.reconciledByCode, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, outcome: outcome.result, refs: { customerId: event.customerId, complaintId: complaint.complaintId, ...(outcome.evidenceId === undefined ? {} : { evidenceId: outcome.evidenceId }) } });
  if (outcome.result === "MATCHED") await enqueueOnce(deps, ctx, event, "RECONCILE_DUE", complaint);
  if (outcome.result === "NOT_FOUND" || outcome.result === "AMOUNT_MISMATCH" || outcome.result === "PAYER_MISMATCH") {
    await handOff(deps, { worldId: event.worldId, customerId: event.customerId, epoch: event.epoch, eventId: event.eventId, eventAtSim: event.eventAtSim, reason: outcome.result === "PAYER_MISMATCH" ? "RECEIPT_DOUBT" : "RECEIPT_NOT_FOUND", summary: outcome.result, complaintId: complaint.complaintId, notify: true, cause: "RECONCILED_BY_CODE" });
  }
  return "RECONCILED_BY_CODE";
}

/** The confirmation emails the complaint's actions owe and that were not sent yet. */
async function confirmationObligation(deps: ObligationDeps, ctx: WorkerContext, event: TurnEvent, complaint: Complaint, actions: readonly Action[]): Promise<ObligationFired | undefined> {
  let sent = false;
  for (const action of actions) {
    const kind = confirmationKind(action);
    if (kind === undefined) continue;
    if ((await deps.data.conversations.findMessage(event.worldId, event.customerId, confirmationMessageId(action, kind))) !== undefined) continue;
    await deps.handlers.confirmAction({ worldId: event.worldId, customerId: event.customerId, eventId: event.eventId, ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }), eventAtSim: event.eventAtSim, complaint, action }, ctx);
    sent = true;
  }
  return sent ? "CONFIRMATION_SENT" : undefined;
}

/** Did the turn leave the customer with something: an outbound of the turn, an answer, a person? */
async function turnSpoke(deps: ObligationDeps, event: TurnEvent, turn: CompletedTurn, complaints: readonly Complaint[]): Promise<boolean> {
  const [messages, tasks, conversation] = await Promise.all([
    deps.data.conversations.listMessages(event.worldId, event.customerId, { limit: 100, descending: true }),
    deps.data.conversations.listTasks(event.worldId, event.customerId),
    deps.data.conversations.getMeta(event.worldId, event.customerId, { consistent: true }),
  ]);
  if (conversation?.control === "OPERATOR") return true;
  if (messages.some((message) => message.direction === "OUT" && message.turnId === turn.turnId && message.status !== "BLOCKED")) return true;
  if (tasks.some((task) => task.atSim === event.eventAtSim)) return true;
  return complaints.some((complaint) => complaint.answer?.sentAtSim === event.eventAtSim || (complaint.status === "HUMAN_REVIEW" && complaint.handoff?.atSim === event.eventAtSim));
}

async function silenceObligation(deps: ObligationDeps, event: TurnEvent, turn: CompletedTurn, complaints: readonly Complaint[]): Promise<ObligationFired | undefined> {
  if (!SILENCE_TRIGGERS.has(event.type) || (await turnSpoke(deps, event, turn, complaints))) return undefined;
  const complaint = complaints.find((candidate) => !SETTLED.has(candidate.status));
  const messages = await deps.data.conversations.listMessages(event.worldId, event.customerId, { limit: 100, descending: true });
  const heldBefore = messages.some((message) => message.direction === "OUT" && message.kind === "HOLDING_NOTICE" && message.complaintId === complaint?.complaintId);
  if (heldBefore) {
    await handOff(deps, { worldId: event.worldId, customerId: event.customerId, epoch: event.epoch, eventId: event.eventId, eventAtSim: event.eventAtSim, reason: "OTHER", summary: "AGENT_SILENT", ...(complaint === undefined ? {} : { complaintId: complaint.complaintId }), notify: true, cause: "AGENT_SILENT", ...answersOf(event) });
  } else {
    await sendFixed(deps.gate, deps.log, event, { kind: "HOLDING_NOTICE", text: holdingText(complaint), purpose: "HOLDING_NOTICE", turnId: turn.turnId, ...answersOf(event), ...(complaint === undefined ? {} : { complaintId: complaint.complaintId }) });
  }
  await auditOnce(deps, { action: WORKER_ACTIONS.agentSilent, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, outcome: heldBefore ? "HANDOFF_NOTICE" : "HOLDING_NOTICE", refs: { customerId: event.customerId, turnId: turn.turnId, ...(complaint === undefined ? {} : { complaintId: complaint.complaintId }) } });
  return "AGENT_SILENT";
}

/** Runs every obligation of the turn; returns what fired, for the log and the tests. */
export async function runObligations(deps: ObligationDeps, ctx: WorkerContext, event: TurnEvent, turn: CompletedTurn): Promise<ObligationFired[]> {
  const loaded = await Promise.all(turn.complaintIds.map((id) => deps.data.complaints.get(event.worldId, id, { consistent: true })));
  const complaints = loaded.filter((complaint): complaint is Complaint => complaint !== undefined && complaint.customerId === event.customerId);
  const fired: ObligationFired[] = [];
  for (const complaint of complaints) {
    const actions = await deps.data.caseItems.listActions(event.worldId, complaint.complaintId);
    const executedThisEvent = actions.some((action) => ANSWERING_ACTIONS.has(action.kind) && action.status === "EXECUTED" && action.atSim === event.eventAtSim);
    const answer = await answerObligation(deps, ctx, event, complaint, executedThisEvent);
    if (answer !== undefined) fired.push(answer);
    const reconcile = await reconcileObligation(deps, ctx, event, turn, complaint);
    if (reconcile !== undefined) fired.push(reconcile);
    const confirmation = await confirmationObligation(deps, ctx, event, complaint, actions);
    if (confirmation !== undefined) fired.push(confirmation);
  }
  const refreshed = (await Promise.all(complaints.map((complaint) => deps.data.complaints.get(event.worldId, complaint.complaintId, { consistent: true })))).filter((complaint): complaint is Complaint => complaint !== undefined);
  const silent = await silenceObligation(deps, event, turn, refreshed);
  if (silent !== undefined) fired.push(silent);
  for (const kind of fired) countMetric(deps.log, OBLIGATIONS_METRIC, { kind, trigger: event.type });
  return fired;
}
