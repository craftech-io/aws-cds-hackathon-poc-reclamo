// `answer_complaint_in_writing` (docs/tool-catalog.md, FL-016, FL-025, FL-030): the written answer of a
// `RESOLVED` (or withdrawn) complaint, by email, as a PDF letter with the attachments the code allows.
// The code decides what the model cannot (complaints/answer.ts): the customer accepted the email
// channel (else `NOT_ELIGIBLE`, and the agent escalates), the complaint is resolved, nothing is in flight
// or sent yet, and the attachments by eligibility. The order is the documented one:
//
//   1. `answer.inFlight` claimed together with `FINAL_ANSWER` in the register (body SHA-256): a double
//      send collides here;
//   2. the PDFs (the letter with the hashes of `FILED` and `FINAL_ANSWER`, then the attachments) in
//      `Documents`;
//   3. the gate (G2 with grounding and the deterministic verification of `draftBody`, `CH-FORMAL-CONTENT`,
//      the recipient fence; the `.eml` is stored by the email transport before SES);
//   4. sent: the answer recorded, `ANSWERED`, milestones cancelled, `AUTO_CLOSE` (complaints/answer.ts).
//
// The message id derives from the complaint, the turn and the draft: the same call retried is the same
// message, and a draft rewritten after a refusal (GROUNDING_FAIL, POLICY_DENIED) is decided again.
// A send that did not happen frees the claim (`releaseAnswer`) so the case can be answered again; an
// unknown delivery keeps it (a person decides, never a blind resend); a deferred send keeps it too,
// since the gate sends it later by itself.
import { ToolError, fail, ok } from "@reclamo/shared";
import { EMAIL_TEXT, fill } from "../../copy";
import { beginAnswer, checkAnswerPreconditions, completeAnswer, releaseAnswer, selectAttachments } from "../../complaints/answer";
import type { ComplaintsDeps } from "../../complaints/deps";
import { checkOutcome } from "../../complaints/outcome";
import type { Complaint } from "../../domain/complaint";
import { sha256Hex } from "../../lib/crypto";
import type { GateOutcome } from "../../outbound/types";
import { type ToolContext, type ToolImplementation, actorOf } from "../common/context";
import type { ToolInput } from "../common/define";
import { requiredComplaint, settingsOf } from "../actions/ports";
import { deferredUntilText, derivedMessageId, gateAnswer, outboundCallOf, turnOf } from "../messaging/outbound";
import { type AnswerFacts, loanIdOf, refundEntriesOf, storeAnswerDocuments } from "./answer-documents";
import type { ComplaintPorts } from "./ports";
import type { COMPLAINTS_TOOLS } from "./schema";

type AnswerInput = ToolInput<(typeof COMPLAINTS_TOOLS)["answer_complaint_in_writing"]>;

/** The outcome of the letter: a withdrawal is always `WITHDRAWN`; a recorded outcome cannot be changed here. */
function outcomeOf(complaint: Complaint, asked: AnswerInput["outcome"]): NonNullable<Complaint["outcome"]> {
  if (complaint.outcome !== undefined && complaint.outcome !== asked) throw new ToolError("INVALID", `the complaint's outcome is ${complaint.outcome}`, "OUTCOME_MISMATCH");
  return asked;
}

async function loanFacts(ctx: ToolContext<AnswerInput>, ports: ComplaintPorts, complaint: Complaint, file: AnswerFacts["file"]): Promise<Pick<AnswerFacts, "loan" | "instalments">> {
  const loanId = loanIdOf(complaint, file);
  if (loanId === undefined) return {};
  const call = { worldId: ctx.session.worldId, simNow: ctx.session.eventAtSim, correlationId: ctx.correlationId };
  const loan = await ports.core().call("getLoan", call, { params: { loanId } });
  if (loan.customerId !== ctx.session.customerId) throw new ToolError("FORBIDDEN", "the loan is not of this customer", "NOT_IN_SESSION");
  const instalments = await ports.core().call("listInstalments", call, { params: { loanId } });
  return { loan, instalments };
}

async function release(deps: ComplaintsDeps, ctx: ToolContext<AnswerInput>, complaint: Complaint, messageId: string): Promise<void> {
  try {
    await releaseAnswer(deps, { worldId: ctx.session.worldId, complaintId: complaint.complaintId, messageId });
  } catch (error) {
    ctx.log.error("tool.answer_release_failed", { error });
  }
}

/** Whether the gate may have handed the email to SES (then the claim stays and a person decides). */
function mayHaveLeft(outcome: GateOutcome): boolean {
  return !outcome.ok && outcome.failure.error.code === "UNKNOWN_DELIVERY";
}

export function answerInWritingTool(ports: ComplaintPorts): ToolImplementation<AnswerInput> {
  return async (ctx) => {
    const { input, session } = ctx;
    const complaint = requiredComplaint(ctx);
    const actor = actorOf(ctx.principal);
    checkAnswerPreconditions(complaint, actor);
    const outcome = outcomeOf(complaint, input.outcome);
    const deps = ports.complaints(ctx.log);
    const file = await ctx.connector.caseItems.caseFile(session.worldId, complaint.complaintId);
    if (complaint.outcome === undefined) checkOutcome(complaint.type, file.actions, outcome);
    const loan = await loanFacts(ctx, ports, complaint, file);
    const selection = selectAttachments({
      complaint,
      ...(loan.loan === undefined ? {} : { loan: { loanId: loan.loan.loanId, status: loan.loan.status } }),
      actions: file.actions,
      ...(input.requestedAttachments === undefined ? {} : { requested: input.requestedAttachments }),
    });
    const settings = await settingsOf(ctx);
    const refunds = await refundEntriesOf(ctx, complaint);

    // The draft is part of the id: a retry of the same call is the same message (the gate answers the
    // first decision), while a rewrite after a refusal is a new message the gate decides again.
    const messageId = derivedMessageId(session.worldId, "FORMAL_ANSWER", complaint.complaintId, session.turnId, sha256Hex(input.draftBody));
    const begun = await beginAnswer(deps, { worldId: session.worldId, complaintId: complaint.complaintId, messageId, body: input.draftBody, outcome, actor, atSim: session.eventAtSim });
    let gate: GateOutcome;
    try {
      const attachments = await storeAnswerDocuments(ports, {
        complaint: begun.complaint,
        file,
        ...loan,
        refunds,
        settings,
        attachments: selection.attachments,
        body: input.draftBody,
        outcome,
        issuedAtSim: session.eventAtSim,
        registerHashes: { ...(begun.filedHash === undefined ? {} : { filed: begun.filedHash }), finalAnswer: begun.finalAnswerHash },
      });
      gate = await ports.gate(
        {
          worldId: session.worldId,
          customerId: session.customerId,
          complaintId: complaint.complaintId,
          sender: "AGENT",
          channel: "EMAIL",
          kind: "FORMAL_ANSWER",
          text: input.draftBody,
          subject: fill(EMAIL_TEXT.SUBJECT_ANSWER, { complaintNumber: complaint.complaintNumber }),
          attachments,
          refs: { tool: ctx.tool, complaintId: complaint.complaintId, complaintNumber: complaint.complaintNumber, outcome },
          ...turnOf(ctx),
          messageId,
          formal: { outcome },
        },
        outboundCallOf(ctx),
      );
    } catch (error) {
      await release(deps, ctx, complaint, messageId);
      throw error;
    }

    const docKinds = [...new Set(["ANSWER", ...selection.attachments])];
    if (!gate.ok || gate.decision === "REROUTED") {
      if (!mayHaveLeft(gate)) await release(deps, ctx, complaint, messageId);
      await ctx.audit({ action: "WRITTEN_ANSWER", outcome: gate.ok ? gate.decision : (gate.decision ?? gate.failure.error.code), ruleIds: [...gate.ruleIds], refs: { messageId } });
      return gateAnswer(gate);
    }
    if (gate.decision === "DEFERRED") {
      await ctx.audit({ action: "WRITTEN_ANSWER", outcome: "DEFERRED", refs: { messageId } });
      return ok({ messageId, decision: gate.decision, ruleIds: [...gate.ruleIds], deferredUntilText: gate.deferredUntilText ?? deferredUntilText(gate.nextAllowedAt), status: "DEFERRED", attachments: docKinds });
    }
    const mailId = gate.mailId;
    if (mailId === undefined) {
      ctx.log.error("tool.answer_without_mail_id", { messageId });
      return fail("UNKNOWN_DELIVERY", "the email may have been sent; a person checks it before anything else is sent");
    }
    await completeAnswer(deps, { worldId: session.worldId, complaintId: complaint.complaintId, messageId, mailId, sentAtSim: session.eventAtSim, outcome, actor });
    await ctx.audit({
      action: "WRITTEN_ANSWER",
      outcome: "SENT",
      refs: { messageId, mailId },
      detail: { outcome, attachments: docKinds, added: [...selection.added], removed: [...selection.removed] },
    });
    return ok({ messageId, mailId, attachments: docKinds, status: "SENT", deliveryProof: "SENT" });
  };
}
