// The PDFs of a written answer (docs/architecture-integrations.md §8): the letter (`ANSWER`) always, and
// the attachments complaints/answer.ts selected by eligibility — the debt-free certificate of a cancelled
// loan, one credit note per reversal or refund that issued one, the loan's statement. Every figure comes
// from the core, the refund register or the complaint; the letter prints the hashes of `FILED` and
// `FINAL_ANSWER`. Each PDF is stored in `Documents` before the gate sends the email, and the gate gets
// only its key and hash.
import type { InstalmentList, Loan } from "@reclamo/core-contract";
import { ToolError } from "@reclamo/shared";
import { COMPLAINT_TYPE_LABEL, capitalize } from "../../copy";
import type { AnswerAttachment } from "../../complaints/answer";
import type { CaseFile } from "../../connector/repos/case-items";
import type { Complaint } from "../../domain/complaint";
import type { RefundEntry } from "../../domain/ledger";
import type { WorldSettings } from "../../domain/world";
import { renderDocument } from "../../pdf/documents";
import type { DocumentInput } from "../../pdf/schemas";
import type { OutboundAttachment } from "../../outbound/types";
import type { ToolContext } from "../common/context";
import { type ComplaintPorts, documentKey } from "./ports";

const LOAN_ID = /^L-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const MAX_PAYMENTS = 60;

function stringAt(value: unknown, ...path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined;
  return typeof current === "string" ? current : undefined;
}

/** The loan a complaint is about: its subject, else the loan its evidence names. */
export function loanIdOf(complaint: Complaint, file: Pick<CaseFile, "evidence">): string | undefined {
  if (complaint.subject?.loanId !== undefined) return complaint.subject.loanId;
  for (const item of file.evidence) {
    const candidate = stringAt(item.details, "line", "loanRef") ?? stringAt(item.details, "movement", "loanId") ?? stringAt(item.details, "loanId");
    if (candidate !== undefined && LOAN_ID.test(candidate)) return candidate;
  }
  return undefined;
}

/** Refund register entries of the complaint in its epoch (the refund chain has no per-complaint index). */
export async function refundEntriesOf(ctx: Pick<ToolContext<unknown>, "connector">, complaint: Complaint): Promise<RefundEntry[]> {
  const found: RefundEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.connector.chains.listRegister("RRI", complaint.worldId, complaint.epoch, cursor === undefined ? {} : { cursor });
    found.push(...(page.entries as RefundEntry[]).filter((entry) => entry.complaintId === complaint.complaintId));
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
}

export interface AnswerFacts {
  readonly complaint: Complaint;
  readonly file: CaseFile;
  readonly loan?: Loan;
  readonly instalments?: InstalmentList;
  readonly refunds: readonly RefundEntry[];
  readonly settings: WorldSettings;
  readonly attachments: readonly AnswerAttachment[];
  readonly body: string;
  readonly outcome: NonNullable<Complaint["outcome"]>;
  readonly issuedAtSim: string;
  readonly registerHashes: { readonly filed?: string; readonly finalAnswer: string };
}

function answerInput(facts: AnswerFacts): DocumentInput {
  const { complaint } = facts;
  const filed = facts.registerHashes.filed;
  if (filed === undefined) throw new ToolError("UNAVAILABLE", "the complaint's FILED register entry is not readable yet");
  const label = capitalize(COMPLAINT_TYPE_LABEL[complaint.type]);
  const executed = facts.file.actions.filter((action) => action.status === "EXECUTED" && action.amountCents !== undefined && action.amountCents > 0);
  return {
    docKind: "ANSWER",
    complaintNumber: complaint.complaintNumber,
    issuedAtSim: facts.issuedAtSim,
    type: complaint.type,
    filedAtSim: complaint.filedAtSim,
    outcome: facts.outcome,
    facts: [complaint.summary.trim() === "" ? label : complaint.summary],
    resolution: facts.body,
    actions: executed.slice(0, 10).map((action) => ({ label, amountCents: action.amountCents ?? 0 })),
    attachments: [...facts.attachments],
    registerHashes: { filed, finalAnswer: facts.registerHashes.finalAnswer },
  };
}

function attachmentInputs(facts: AnswerFacts): DocumentInput[] {
  const { complaint, loan } = facts;
  const common = { complaintNumber: complaint.complaintNumber, issuedAtSim: facts.issuedAtSim };
  const inputs: DocumentInput[] = [];
  for (const kind of facts.attachments) {
    if (kind === "PAYOFF_CERTIFICATE" && loan?.cancelledAtSim !== undefined) {
      inputs.push({ docKind: "PAYOFF_CERTIFICATE", ...common, loan: { label: loan.label, principalCents: loan.principal, cancelledAtSim: loan.cancelledAtSim } });
    }
    if (kind === "CREDIT_NOTE") {
      for (const entry of facts.refunds) {
        if (entry.creditNoteId === undefined) continue;
        inputs.push({
          docKind: "CREDIT_NOTE",
          ...common,
          creditNoteId: entry.creditNoteId,
          concept: capitalize(COMPLAINT_TYPE_LABEL[complaint.type]),
          amountCents: entry.amountCents,
          interestCents: entry.interestCents,
          annualRate: facts.settings.referenceRate.annualRate,
          creditedAtSim: entry.atSim,
        });
      }
    }
    if (kind === "STATEMENT" && loan !== undefined && facts.instalments !== undefined) {
      const instalments = facts.instalments.instalments;
      inputs.push({
        docKind: "STATEMENT",
        ...common,
        loan: { label: loan.label, outstandingCents: loan.outstanding },
        instalments: instalments.map((item) => ({ number: item.number, dueDate: item.dueDate, amountCents: item.amount, paidCents: Math.max(0, item.amount - item.outstanding), outstandingCents: item.outstanding, status: item.status })),
        payments: instalments.flatMap((item) => item.payments.map((payment) => ({ instalment: item.number, appliedAtSim: payment.appliedAtSim, amountCents: payment.amount }))).slice(0, MAX_PAYMENTS),
      });
    }
  }
  return inputs;
}

/** Renders the letter and its attachments and stores each in `Documents`; returns what the gate attaches. */
export async function storeAnswerDocuments(ports: Pick<ComplaintPorts, "documents">, facts: AnswerFacts): Promise<OutboundAttachment[]> {
  const store = ports.documents();
  const stored: OutboundAttachment[] = [];
  for (const input of [answerInput(facts), ...attachmentInputs(facts)]) {
    const rendered = renderDocument(input);
    const s3Key = documentKey(facts.complaint.worldId, facts.complaint.complaintId, rendered.docKind, rendered.sha256);
    await store.put(s3Key, rendered.bytes, rendered.contentType);
    stored.push({ docKind: rendered.docKind, s3Key, sha256: rendered.sha256 });
  }
  return stored;
}
