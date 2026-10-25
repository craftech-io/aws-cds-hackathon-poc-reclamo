// The written answer of a complaint (docs/tool-catalog.md `answer_complaint_in_writing` and
// `operator_answer`; FL-025, FL-030, FL-031, FL-089). The code decides what the model cannot:
//
//   - preconditions: the email channel accepted by the customer; the complaint `RESOLVED` (a
//     withdrawal resolves it too), or `HUMAN_REVIEW` when an operator answers;
//   - attachments by eligibility: a debt-free certificate only for a loan `CANCELLED` or
//     `EARLY_CANCELLED` (asked for any other → `NOT_ELIGIBLE`), always added when the loan of the
//     complaint is cancelled; the credit note whenever an executed action issued one; the statement
//     after a payment was applied or when asked for a complaint about a loan;
//   - the order: `answer.inFlight` claimed together with the `FINAL_ANSWER` register entry (with the
//     body's SHA-256), before the PDF is rendered (`beginAnswer`); after the gate sent it, the answer
//     is recorded and the complaint moves to `ANSWERED`, cancelling the milestones and adding
//     `AUTO_CLOSE` (`completeAnswer`); a send that did not happen frees the claim (`releaseAnswer`).
import { z } from "zod";
import { type ComplaintOutcome, ToolError } from "@reclamo/shared";
import type { Action } from "../domain/case-items";
import type { Actor } from "../domain/common";
import type { Complaint, DeliveryProof } from "../domain/complaint";
import { isConflict } from "../connector/errors";
import { sha256Hex } from "../lib/crypto";
import type { ComplaintsDeps } from "./deps";
import { type AppendChainedResult, type ChainBuild, appendChained } from "./register";
import { transition } from "./state-machine";

/** What the agent may ask for (`CED-ATTACHMENTS-ALLOWLIST`); the code adds or removes by eligibility. */
export const AnswerAttachment = z.enum(["PAYOFF_CERTIFICATE", "CREDIT_NOTE", "STATEMENT"]);
export type AnswerAttachment = z.infer<typeof AnswerAttachment>;

/** Loan statuses that have a debt-free certificate. */
export const PAYOFF_ELIGIBLE_LOAN_STATUSES: ReadonlySet<string> = new Set(["CANCELLED", "EARLY_CANCELLED"]);

const CREDIT_NOTE_ACTIONS: ReadonlySet<Action["kind"]> = new Set<Action["kind"]>(["REVERSE_CHARGE", "REFUND_DUPLICATE"]);

export interface AttachmentContext {
  readonly complaint: Pick<Complaint, "type" | "subject">;
  /** The loan of the complaint as the core reports it now (status `ACTIVE`, `IN_ARREARS`, `CANCELLED`, `EARLY_CANCELLED`). */
  readonly loan?: { readonly loanId: string; readonly status: string };
  readonly actions: readonly Pick<Action, "kind" | "status" | "coreRef">[];
  readonly requested?: readonly AnswerAttachment[];
}

export interface AttachmentSelection {
  readonly attachments: readonly AnswerAttachment[];
  /** Added by code although not asked for. */
  readonly added: readonly AnswerAttachment[];
  /** Asked for but not eligible, dropped (never the certificate: that one is refused). */
  readonly removed: readonly AnswerAttachment[];
}

function eligibility(context: AttachmentContext): Readonly<Record<AnswerAttachment, { eligible: boolean; automatic: boolean }>> {
  const loanCancelled = context.loan !== undefined && PAYOFF_ELIGIBLE_LOAN_STATUSES.has(context.loan.status);
  const executed = context.actions.filter((action) => action.status === "EXECUTED");
  const creditNote = executed.some((action) => CREDIT_NOTE_ACTIONS.has(action.kind));
  const paymentApplied = executed.some((action) => action.kind === "APPLY_PAYMENT");
  const aboutLoan = context.loan !== undefined || context.complaint.subject?.loanId !== undefined;
  return {
    PAYOFF_CERTIFICATE: { eligible: loanCancelled, automatic: loanCancelled },
    CREDIT_NOTE: { eligible: creditNote, automatic: creditNote },
    STATEMENT: { eligible: paymentApplied || aboutLoan, automatic: paymentApplied },
  };
}

/** The attachments of a written answer, by eligibility; a certificate for a loan with balance is refused. */
export function selectAttachments(context: AttachmentContext): AttachmentSelection {
  const requested = new Set(AnswerAttachment.array().parse(context.requested ?? []));
  const rules = eligibility(context);
  if (requested.has("PAYOFF_CERTIFICATE") && !rules.PAYOFF_CERTIFICATE.eligible) {
    throw new ToolError("NOT_ELIGIBLE", "the debt-free certificate is issued only for a cancelled loan", "PAYOFF_NOT_ELIGIBLE");
  }
  const attachments: AnswerAttachment[] = [];
  const added: AnswerAttachment[] = [];
  const removed: AnswerAttachment[] = [];
  for (const kind of AnswerAttachment.options) {
    const rule = rules[kind];
    if (rule.eligible && (rule.automatic || requested.has(kind))) attachments.push(kind);
    if (rule.eligible && rule.automatic && !requested.has(kind)) added.push(kind);
    if (!rule.eligible && requested.has(kind)) removed.push(kind);
  }
  return { attachments, added, removed };
}

/** Whether the actor may answer this complaint in writing now (consent, status, no answer yet). */
export function checkAnswerPreconditions(complaint: Complaint, actor: Actor): void {
  if (complaint.emailAnswerConsent.status !== "ACCEPTED") throw new ToolError("NOT_ELIGIBLE", "the customer did not accept the email channel", "EMAIL_NOT_ACCEPTED");
  const operator = actor.startsWith("OPERATOR:");
  if (complaint.status !== "RESOLVED" && !(operator && complaint.status === "HUMAN_REVIEW")) {
    throw new ToolError("NOT_ELIGIBLE", `a ${complaint.status} complaint cannot be answered yet`, "NOT_RESOLVED");
  }
  if (complaint.answer?.messageId) throw new ToolError("CONFLICT", "the written answer was already sent", "ANSWER_SENT");
  if (complaint.answer?.inFlight) throw new ToolError("CONFLICT", "a written answer is being sent", "ANSWER_IN_FLIGHT");
}

export interface BeginAnswerInput {
  readonly worldId: string;
  readonly complaintId: string;
  /** The outbound message id of the answer (the gate's `messageId`). */
  readonly messageId: string;
  /** The final body as it goes in the PDF and the email. */
  readonly body: string;
  readonly outcome: ComplaintOutcome;
  readonly actor: Actor;
  readonly atSim: string;
}

export interface BegunAnswer {
  readonly complaint: Complaint;
  readonly bodySha256: string;
  /** Hashes printed on the `ANSWER` PDF. */
  readonly filedHash?: string;
  readonly finalAnswerHash: string;
  readonly register: AppendChainedResult<"REG">;
}

/** Claims `answer.inFlight` and writes `FINAL_ANSWER` in one transaction; a double send collides here. */
export async function beginAnswer(deps: ComplaintsDeps, input: BeginAnswerInput): Promise<BegunAnswer> {
  const { connector } = deps;
  const bodySha256 = sha256Hex(input.body);
  let complaint: Complaint | undefined;
  const register = await appendChained(deps, {
    chain: "REG",
    worldId: input.worldId,
    epoch: (await readComplaint(deps, input.worldId, input.complaintId)).epoch,
    build: async (): Promise<ChainBuild<"REG">> => {
      complaint = await readComplaint(deps, input.worldId, input.complaintId);
      checkAnswerPreconditions(complaint, input.actor);
      return {
        entry: {
          eventType: "FINAL_ANSWER",
          atSim: input.atSim,
          complaintId: complaint.complaintId,
          complaintNumber: complaint.complaintNumber,
          kind: complaint.kind,
          type: complaint.type,
          channel: "EMAIL",
          origin: complaint.origin,
          status: complaint.status,
          reason: input.outcome,
          answerRef: input.messageId,
          bodySha256,
        },
        extra: [connector.complaints.claimAnswerOp(input.worldId, input.complaintId, input.messageId)],
      };
    },
  });
  const current = complaint as Complaint;
  const entries = await connector.chains.listRegisterByComplaint(input.worldId, current.epoch, current.complaintNumber);
  const filed = entries.find((entry) => entry.eventType === "FILED");
  return { complaint: current, bodySha256, finalAnswerHash: register.entry.hash, register, ...(filed ? { filedHash: filed.hash } : {}) };
}

async function readComplaint(deps: ComplaintsDeps, worldId: string, complaintId: string): Promise<Complaint> {
  const complaint = await deps.connector.complaints.get(worldId, complaintId, { consistent: true });
  if (!complaint) throw new ToolError("NOT_FOUND", "complaint not found");
  return complaint;
}

/** The send did not happen (blocked, deferred, failed before the transport): frees the claim. */
export async function releaseAnswer(deps: ComplaintsDeps, input: { worldId: string; complaintId: string; messageId: string }): Promise<void> {
  await deps.connector.write(deps.connector.complaints.releaseAnswerOp(input.worldId, input.complaintId, input.messageId));
}

export interface CompleteAnswerInput {
  readonly worldId: string;
  readonly complaintId: string;
  readonly messageId: string;
  readonly mailId: string;
  /** Simulated instant SES accepted it: the regulatory clock stops here. */
  readonly sentAtSim: string;
  readonly outcome: ComplaintOutcome;
  readonly actor: Actor;
  readonly holidays?: readonly string[];
}

export interface CompleteAnswerResult {
  readonly complaint: Complaint;
  /** The `ANSWERED` entry this call wrote; absent when a previous attempt already wrote it. */
  readonly register?: AppendChainedResult<"REG">;
}

/**
 * SES accepted the answer: record it, then `ANSWERED` (an operator's human case goes `RESOLVED`
 * first). Safe to retry with the same `messageId`: every step re-reads and runs only what is missing,
 * so a redelivered event after a partial failure still stops the regulatory clock. A complaint has one
 * written answer only (`checkAnswerPreconditions`), so once its history reached `ANSWERED` this send
 * is complete: a late redelivery changes nothing, whatever happened since (a bounce back to
 * `HUMAN_REVIEW`, `CLOSED`).
 */
export async function completeAnswer(deps: ComplaintsDeps, input: CompleteAnswerInput): Promise<CompleteAnswerResult> {
  await recordAnswerSent(deps, input);
  const base = { worldId: input.worldId, complaintId: input.complaintId, actor: input.actor, atSim: input.sentAtSim, ...(input.holidays ? { holidays: input.holidays } : {}) };
  let current = await readComplaint(deps, input.worldId, input.complaintId);
  if (wasAnswered(current)) return { complaint: current };
  if (current.status === "HUMAN_REVIEW" && input.actor.startsWith("OPERATOR:")) {
    current = (await transition(deps, { ...base, complaint: current, to: "RESOLVED", cause: "OPERATOR_ANSWER", patch: { outcome: current.outcome ?? input.outcome } })).complaint;
  }
  return transition(deps, { ...base, complaint: current, to: "ANSWERED", cause: "WRITTEN_ANSWER_SENT", ...(current.outcome ? {} : { patch: { outcome: input.outcome } }) });
}

/** Whether the complaint's one written answer already moved it to `ANSWERED` at some point. */
function wasAnswered(complaint: Complaint): boolean {
  return complaint.statusHistory.some((change) => change.to === "ANSWERED");
}

/** `answer = {messageId, …}` once: a retry that finds this send already recorded skips the write. */
async function recordAnswerSent(deps: ComplaintsDeps, input: CompleteAnswerInput): Promise<void> {
  const { connector } = deps;
  const recorded = async () => (await readComplaint(deps, input.worldId, input.complaintId)).answer?.messageId === input.messageId;
  if (await recorded()) return;
  try {
    await connector.write(connector.complaints.recordAnswerSentOp(input.worldId, input.complaintId, { messageId: input.messageId, mailId: input.mailId, sentAtSim: input.sentAtSim }));
  } catch (error) {
    if (isConflict(error) && (await recorded())) return;
    throw error;
  }
}

/** `DELIVERY_PROOF` in the register with the answer's proof, from the email events (FL-011, §8.3). */
export async function recordDeliveryProof(deps: ComplaintsDeps, input: { worldId: string; complaintId: string; messageId: string; proof: DeliveryProof; atSim: string }): Promise<AppendChainedResult<"REG">> {
  const complaint = await readComplaint(deps, input.worldId, input.complaintId);
  return appendChained(deps, {
    chain: "REG",
    worldId: input.worldId,
    epoch: complaint.epoch,
    build: async ({ attempt }): Promise<ChainBuild<"REG">> => {
      const latest = attempt === 0 ? complaint : await readComplaint(deps, input.worldId, input.complaintId);
      if (latest.answer?.messageId !== input.messageId) throw new ToolError("CONFLICT", "not the sent answer of this complaint", "NOT_THE_ANSWER");
      return {
        entry: {
          eventType: "DELIVERY_PROOF",
          atSim: input.atSim,
          complaintId: latest.complaintId,
          complaintNumber: latest.complaintNumber,
          kind: latest.kind,
          type: latest.type,
          channel: "EMAIL",
          origin: latest.origin,
          status: latest.status,
          reason: input.proof,
          answerRef: input.messageId,
        },
        extra: [deps.connector.complaints.setDeliveryProofOp(input.worldId, input.complaintId, input.messageId, input.proof)],
      };
    },
  });
}
