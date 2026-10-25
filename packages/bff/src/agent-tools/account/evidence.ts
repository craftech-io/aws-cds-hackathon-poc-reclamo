// What an account read leaves on a complaint it actually investigates: the loan's status (`get_loan`)
// and the early payoff quote (`quote_early_payoff`) go on an open certificate or closure/payoff complaint
// about that loan (or about no loan in particular); the clauses read (`get_terms`, `get_fee_rules`) go
// on an open information request, or on an unrecognized charge once its charge was checked. Any other
// complaint gets nothing: an informational read never founds `RESOLVED` on a complaint it has nothing to
// do with (complaints/foundation.ts). Among the candidates, the one about this very loan wins, then the
// newest. A write that fails never fails the read (the agent reads again when `update_complaint`
// answers `EVIDENCE_REQUIRED`). Details carry ids, codes, statuses and amounts in centavos, never
// personal data.
import type { ComplaintType } from "@reclamo/shared";
import type { EvidenceKind } from "../../domain/case-items";
import type { JsonObject } from "../../domain/common";
import type { Complaint } from "../../domain/complaint";
import type { ToolContext } from "../common/context";
import { openComplaints } from "../common/fences";
import { recordEvidence } from "../investigation/evidence";

type AccountEvidenceKind = Extract<EvidenceKind, "LOAN_STATUS" | "PAYOFF_QUOTE" | "TERMS_CLAUSE">;

const LOAN_TYPES: ReadonlySet<ComplaintType> = new Set(["PAYOFF_CERTIFICATE", "CLOSURE_OR_EARLY_PAYOFF"]);

async function chargeChecked(ctx: ToolContext<unknown>, complaint: Complaint): Promise<boolean> {
  const file = await ctx.connector.caseItems.caseFile(ctx.session.worldId, complaint.complaintId);
  return file.evidence.some((evidence) => evidence.kind === "CHARGE_CHECK");
}

/** The open complaint this read investigates, if any (see the header). */
export async function complaintForRead(ctx: ToolContext<unknown>, kind: AccountEvidenceKind, loanId?: string): Promise<Complaint | undefined> {
  const open = await openComplaints({ session: ctx.session, connector: ctx.connector });
  if (kind === "TERMS_CLAUSE") {
    const candidates: Complaint[] = [];
    for (const complaint of open) {
      if (complaint.type === "INFORMATION_REQUEST" || (complaint.type === "UNRECOGNIZED_CHARGE" && (await chargeChecked(ctx, complaint)))) candidates.push(complaint);
    }
    return candidates.at(-1);
  }
  const about = open.filter((complaint) => LOAN_TYPES.has(complaint.type));
  return about.filter((complaint) => loanId !== undefined && complaint.subject?.loanId === loanId).at(-1) ?? about.filter((complaint) => complaint.subject?.loanId === undefined).at(-1);
}

/** Records `details` on the complaint this read investigates (see the header), if any. */
export async function noteOnComplaint(ctx: ToolContext<unknown>, kind: AccountEvidenceKind, details: JsonObject, loanId?: string): Promise<void> {
  try {
    const complaint = await complaintForRead(ctx, kind, loanId);
    if (complaint === undefined) return;
    await recordEvidence(ctx, kind, details, complaint);
  } catch (error) {
    ctx.log.warn("tool.account_evidence_failed", { kind, error });
  }
}
