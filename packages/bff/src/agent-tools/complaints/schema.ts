// Target `complaints` (`ToolComplaints`, docs/tool-catalog.md): the complaint's number on the spot, its
// state and the written answer. `register_complaint` needs no identification (the number is given before
// the challenge, ADR-0015); `update_complaint` and the written answer act on the complaint and need it. The code writes the number, the deadline and the acknowledgement. Statuses
// the agent may not ask for here (`HUMAN_REVIEW`, `AWAITING_APPROVAL`, `ANSWERED`, `CLOSED`) are not in the
// enum. The zod here is the only source of the Gateway schema of these tools.
import { z } from "zod";
import { ComplaintOutcome, ComplaintType, IsoInstant, PresentationKind } from "@reclamo/shared";
import { boundedText, complaintIdField, defineTool, idField } from "../common/define";

/** Statuses `update_complaint` may ask the state machine for (docs/tool-catalog.md). */
export const AgentStatus = z.enum(["AWAITING_CUSTOMER", "AWAITING_SETTLEMENT", "AWAITING_NETWORK", "INVESTIGATING", "RESOLVED"]);

/** Attachments the written answer may ask for (CED-ATTACHMENTS-ALLOWLIST repeats the list). */
export const AnswerAttachment = z.enum(["PAYOFF_CERTIFICATE", "CREDIT_NOTE", "STATEMENT"]);


export const COMPLAINTS_TOOLS = {
  register_complaint: defineTool({
    name: "register_complaint",
    description:
      "Registers what the customer presented and gives the complaint number on the spot, before the identity challenge and before investigating. The code writes the number, the 10-business-day deadline and the acknowledgement to the customer. existing = true when an open complaint of the same type and object already exists (its number comes back). A CONSULTA uses type INFORMATION_REQUEST: register as a CONSULTA a question that needs more than the reads already in the envelope (older operations, a statement, a check).",
    fields: {
      kind: PresentationKind.describe("CONSULTA (a question) or RECLAMO (a complaint)."),
      type: ComplaintType.describe("What the presentation is about."),
      summary: boundedText(200, "One sentence in Spanish, no personal data."),
      sourceMessageId: idField("Leave it out: the code takes the customer's message of this turn. Only to name an earlier inbound message of the customer.").optional(),
    },
    check: (input, ctx) => {
      if (input.kind === "CONSULTA" && input.type !== "INFORMATION_REQUEST") ctx.addIssue({ code: "custom", path: ["type"], message: "a CONSULTA uses type INFORMATION_REQUEST" });
    },
    scoped: { sourceMessageId: "MESSAGE" },
  }),

  update_complaint: defineTool({
    name: "update_complaint",
    description:
      "Moves a complaint of this session to a status the state machine allows for the agent, records its outcome when RESOLVED or withdrawn, schedules a follow-up or adds an internal note. RESOLVED needs an action or an evidence that supports it. Escalations, approvals and the written answer have their own tools.",
    fields: {
      complaintId: complaintIdField(),
      status: AgentStatus.optional().describe("New status."),
      outcome: ComplaintOutcome.optional().describe("Outcome, only with RESOLVED or a withdrawal."),
      withdrawn: z.boolean().optional().describe("The customer withdrew the complaint."),
      followUpAtSim: IsoInstant.optional().describe("When to look at it again (ISO instant of the world clock)."),
      note: boundedText(300, "Internal note for the operators, in Spanish.").optional(),
    },
    check: (input, ctx) => {
      if (input.status === undefined && input.withdrawn === undefined && input.followUpAtSim === undefined && input.note === undefined) {
        ctx.addIssue({ code: "custom", path: ["status"], message: "nothing to update" });
      }
      if (input.outcome !== undefined && input.status !== "RESOLVED" && input.withdrawn !== true) {
        ctx.addIssue({ code: "custom", path: ["outcome"], message: "outcome only with RESOLVED or a withdrawal" });
      }
    },
    scoped: { complaintId: "COMPLAINT" },
    // It acts on the complaint (a withdrawal resolves it and cancels its regulatory clock): only an
    // identified customer, and never while an operator holds the conversation.
    fences: { identified: true, complaint: true, control: true },
  }),

  answer_complaint_in_writing: defineTool({
    name: "answer_complaint_in_writing",
    description:
      "Sends the written answer of a RESOLVED (or withdrawn) complaint by email as a PDF letter, to the address the customer accepted. Every fact of draftBody must come from this turn's tool results. The code adds or removes attachments by eligibility: asking for the PAYOFF_CERTIFICATE of a loan that is not cancelled answers NOT_ELIGIBLE PAYOFF_NOT_ELIGIBLE, so send the answer again without it (outcome INFORMATIONAL). Without the customer's email consent it answers NOT_ELIGIBLE EMAIL_NOT_ACCEPTED: escalate instead.",
    fields: {
      complaintId: complaintIdField(),
      outcome: ComplaintOutcome.describe("Outcome of the complaint."),
      draftBody: boundedText(2500, "Body of the letter in Spanish."),
      requestedAttachments: z.array(AnswerAttachment).max(3).optional().describe("Attachments to include, if eligible."),
    },
    check: (input, ctx) => {
      const attachments = input.requestedAttachments ?? [];
      if (new Set(attachments).size !== attachments.length) ctx.addIssue({ code: "custom", path: ["requestedAttachments"], message: "an attachment appears twice" });
    },
    scoped: { complaintId: "COMPLAINT" },
    fences: { identified: true, complaint: true, control: true },
  }),
} as const;
