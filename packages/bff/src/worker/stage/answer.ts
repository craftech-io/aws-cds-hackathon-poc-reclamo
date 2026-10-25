// The operator's written answer (`OPERATOR_ANSWER`, docs/tool-catalog.md `operator_answer`), run by the
// worker in the customer's order: the same steps as `answer_complaint_in_writing`, with the operator as
// actor and sender (complaints/answer.ts and the letter of agent-tools/complaints/answer-documents.ts):
//
//   1. preconditions for an operator (consent accepted; RESOLVED, or a human case in HUMAN_REVIEW);
//   2. `answer.inFlight` claimed with `FINAL_ANSWER` in the register (a double send collides here);
//   3. the letter and the attachments the code allows, stored in `Documents`;
//   4. the gate (`sender OPERATOR:<staffId>`, `FORMAL_ANSWER` by email);
//   5. sent → `ANSWERED` (a human case goes `RESOLVED` first); anything else frees the claim, except a
//      delivery the gate could not confirm, which a person checks before anything is sent again.
//
// A refusal of the preconditions is final for the event (audited, never retried): the console shows the
// complaint as it is.
import { ToolError } from "@reclamo/shared";
import { type AnswerFacts, loanIdOf, refundEntriesOf, storeAnswerDocuments } from "../../agent-tools/complaints/answer-documents";
import type { DocumentStore } from "../../agent-tools/complaints/ports";
import { EMAIL_TEXT, fill } from "../../copy";
import { beginAnswer, checkAnswerPreconditions, completeAnswer, releaseAnswer, selectAttachments } from "../../complaints/answer";
import type { ComplaintsDeps } from "../../complaints/deps";
import type { Connector } from "../../connector/port";
import type { CoreClient } from "../../core/client";
import type { OutboundGate } from "../../outbound/types";
import { WORKER_ACTIONS, auditOnce } from "../audit";
import type { WorkerContext, WrittenAnswerRequest } from "../ports";

export interface StageAnswerDeps {
  readonly data: Connector;
  readonly core: () => CoreClient;
  readonly gate: OutboundGate;
  readonly complaints: () => ComplaintsDeps;
  readonly documents: () => DocumentStore;
}

async function loanFacts(deps: StageAnswerDeps, request: WrittenAnswerRequest, file: AnswerFacts["file"]): Promise<Pick<AnswerFacts, "loan" | "instalments">> {
  const loanId = loanIdOf(request.complaint, file);
  if (loanId === undefined) return {};
  const call = { worldId: request.event.worldId, simNow: request.event.eventAtSim, correlationId: request.event.correlationId ?? request.event.eventId };
  const loan = await deps.core().call("getLoan", call, { params: { loanId } });
  if (loan.customerId !== request.complaint.customerId) throw new ToolError("FORBIDDEN", "the loan is not of this customer");
  return { loan, instalments: await deps.core().call("listInstalments", call, { params: { loanId } }) };
}

async function refused(deps: StageAnswerDeps, ctx: WorkerContext, request: WrittenAnswerRequest, outcome: string): Promise<void> {
  const { event } = request;
  ctx.log.warn("operator_answer.refused", { outcome });
  await auditOnce({ data: deps.data, now: ctx.now, log: ctx.log }, { action: WORKER_ACTIONS.operatorRefused, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, outcome, refs: { customerId: event.customerId, complaintId: request.complaint.complaintId, staffId: event.payload.staffId } });
}

/** `OPERATOR_ANSWER` in the stage: the written answer of an operator through the one exit. */
export function stageWrittenAnswer(deps: StageAnswerDeps) {
  return async (request: WrittenAnswerRequest, ctx: WorkerContext): Promise<void> => {
    const { event, complaint, actor } = request;
    const { payload } = event;
    const complaintsDeps = deps.complaints();
    try {
      checkAnswerPreconditions(complaint, actor);
      if (complaint.outcome !== undefined && complaint.outcome !== payload.outcome) throw new ToolError("INVALID", `the complaint's outcome is ${complaint.outcome}`, "OUTCOME_MISMATCH");
    } catch (error) {
      if (error instanceof ToolError) return refused(deps, ctx, request, error.reason ?? error.code);
      throw error;
    }
    const file = await deps.data.caseItems.caseFile(event.worldId, complaint.complaintId);
    const loan = await loanFacts(deps, request, file);
    const selection = selectAttachments({ complaint, ...(loan.loan === undefined ? {} : { loan: { loanId: loan.loan.loanId, status: loan.loan.status } }), actions: file.actions, requested: payload.requestedAttachments });
    const [settings, refunds] = await Promise.all([deps.data.worlds.getSettings(event.worldId), refundEntriesOf({ connector: deps.data }, complaint)]);
    if (settings === undefined) throw new Error("the world has no settings: the answer is retried once the world is ready");
    const begun = await beginAnswer(complaintsDeps, { worldId: event.worldId, complaintId: complaint.complaintId, messageId: payload.messageId, body: payload.draftBody, outcome: payload.outcome, actor, atSim: event.eventAtSim });
    let outcome;
    try {
      const attachments = await storeAnswerDocuments(deps, {
        complaint: begun.complaint,
        file,
        ...loan,
        refunds,
        settings,
        attachments: selection.attachments,
        body: payload.draftBody,
        outcome: payload.outcome,
        issuedAtSim: event.eventAtSim,
        registerHashes: { ...(begun.filedHash === undefined ? {} : { filed: begun.filedHash }), finalAnswer: begun.finalAnswerHash },
      });
      outcome = await deps.gate(
        {
          worldId: event.worldId,
          customerId: event.customerId,
          complaintId: complaint.complaintId,
          sender: actor,
          channel: "EMAIL",
          kind: "FORMAL_ANSWER",
          text: payload.draftBody,
          subject: fill(EMAIL_TEXT.SUBJECT_ANSWER, { complaintNumber: complaint.complaintNumber }),
          attachments,
          refs: { eventId: event.eventId, staffId: payload.staffId, complaintId: complaint.complaintId, outcome: payload.outcome },
          triggerEventId: event.eventId,
          messageId: payload.messageId,
          formal: { outcome: payload.outcome },
        },
        { actor, correlationId: event.correlationId ?? event.eventId, log: ctx.log },
      );
    } catch (error) {
      await releaseAnswer(complaintsDeps, { worldId: event.worldId, complaintId: complaint.complaintId, messageId: payload.messageId });
      throw error;
    }
    if (outcome.ok && outcome.decision === "ALLOWED" && outcome.mailId !== undefined) {
      await completeAnswer(complaintsDeps, { worldId: event.worldId, complaintId: complaint.complaintId, messageId: payload.messageId, mailId: outcome.mailId, sentAtSim: event.eventAtSim, outcome: payload.outcome, actor });
      ctx.log.info("operator_answer.sent", { attachments: selection.attachments.length });
      return;
    }
    const unknown = !outcome.ok && outcome.failure.error.code === "UNKNOWN_DELIVERY";
    const deferred = outcome.ok && outcome.decision === "DEFERRED";
    if (!unknown && !deferred) await releaseAnswer(complaintsDeps, { worldId: event.worldId, complaintId: complaint.complaintId, messageId: payload.messageId });
    await refused(deps, ctx, request, outcome.ok ? outcome.decision : (outcome.decision ?? outcome.failure.error.code));
  };
}
