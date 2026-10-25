// Step 2 of the gate for email (docs/architecture-integrations.md §1, §4): the subject and the body a
// customer email carries, decided by code from the kind. The subject is always copy/es-AR.ts filled
// with the complaint number (a caller never writes it); the body is the greeting, the paragraphs the
// sender gave (a fixed text of copy/, the agent's draft of a written answer, an operator's text) and
// the fixed footer of channels/email/content.ts. The formal debt notice has no free text at all: its
// body is copy/ filled with the loan the core returned, and its detail travels in the PDF the code
// renders from the core (FL-065).
import type { MessageKind } from "@reclamo/shared";
import { ToolError } from "@reclamo/shared";
import { EMAIL_TEXT, fill } from "../../copy";
import type { EmailTextKey } from "../../copy";
import { renderEmailContent } from "../../channels/email/content";
import type { DebtDetail } from "../deps";
import { GATE_REASON } from "../types";

export interface EmailRenderInput {
  readonly kind: MessageKind;
  /** The sender's paragraphs; absent (and refused) for the formal debt notice. */
  readonly text?: string;
  readonly firstName: string;
  readonly complaintNumber?: string;
  /** The core's detail of the overdue loan (`COLLECTION_NOTICE_EMAIL` only). */
  readonly debt?: DebtDetail;
}

export interface EmailDraft {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** The part a person or the agent wrote (verified like any free text); absent when all of it is code. */
  readonly freeText?: string;
}

interface SubjectRule {
  readonly key: EmailTextKey;
  readonly needsComplaint: boolean;
}

/** Subject by kind; a kind that is never an email has none (CH-KIND-CHANNEL blocks it before). */
const SUBJECTS: Partial<Record<MessageKind, SubjectRule>> = {
  ACK_EMAIL: { key: "SUBJECT_ACK", needsComplaint: true },
  FORMAL_ANSWER: { key: "SUBJECT_ANSWER", needsComplaint: true },
  COMPLAINT_UPDATE: { key: "SUBJECT_UPDATE", needsComplaint: true },
  CLOSURE_CONFIRMATION: { key: "SUBJECT_CLOSURE", needsComplaint: true },
  DATA_CHANGE_CONFIRMATION: { key: "SUBJECT_DATA_CHANGE", needsComplaint: false },
  COLLECTION_NOTICE_EMAIL: { key: "SUBJECT_COLLECTION_NOTICE", needsComplaint: false },
  SUPERVISOR_ALERT: { key: "SUBJECT_SUPERVISOR_ALERT", needsComplaint: true },
};

/** Emails that carry the right to go to the BCRA in their footer. */
const BCRA_FOOTER: ReadonlySet<MessageKind> = new Set(["FORMAL_ANSWER", "CLOSURE_CONFIRMATION"]);

function invalid(message: string): ToolError {
  return new ToolError("INVALID", message, GATE_REASON.CONTENT_INVALID);
}

function subjectOf(kind: MessageKind, complaintNumber: string | undefined): string {
  const rule = SUBJECTS[kind];
  if (rule === undefined) throw invalid(`${kind} is never an email`);
  if (!rule.needsComplaint) return EMAIL_TEXT[rule.key];
  if (complaintNumber === undefined) throw invalid(`${kind} by email names its complaint`);
  return fill(EMAIL_TEXT[rule.key], { complaintNumber });
}

function paragraphsOf(input: EmailRenderInput): { readonly paragraphs: string[]; readonly freeText?: string } {
  if (input.kind === "COLLECTION_NOTICE_EMAIL") {
    if (input.text !== undefined && input.text.trim() !== "") throw invalid("the formal debt notice carries no free text: the code renders it");
    if (input.debt === undefined) throw invalid("the formal debt notice needs the core's detail");
    return { paragraphs: [fill(EMAIL_TEXT.COLLECTION_NOTICE_BODY, { loanLabel: input.debt.loanLabel }), EMAIL_TEXT.COLLECTION_NOTICE_RIGHTS] };
  }
  const text = input.text?.trim() ?? "";
  if (text === "") throw invalid(`${input.kind} needs a body`);
  return { paragraphs: [text], freeText: text };
}

export function renderEmail(input: EmailRenderInput): EmailDraft {
  const subject = subjectOf(input.kind, input.complaintNumber);
  const { paragraphs, freeText } = paragraphsOf(input);
  const content = renderEmailContent({
    greeting: fill(EMAIL_TEXT.GREETING, { firstName: input.firstName }),
    paragraphs,
    ...(input.complaintNumber === undefined ? {} : { complaintNumber: input.complaintNumber }),
    bcraFooter: BCRA_FOOTER.has(input.kind),
  });
  return { subject, text: content.text, html: content.html, ...(freeText === undefined ? {} : { freeText }) };
}
