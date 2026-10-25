// Check (c) of `PolicyAudit` (docs/architecture.md §12, docs/architecture-integrations.md §6): no
// imputation rests on someone else's settlement line. An imputation is an executed `APPLY_PAYMENT`
// (its founding evidence) or a `MATCHED` reconciliation (`SETTLEMENT_MATCH`), the evidence that lets one
// happen. The line must name the complaint's customer (`customerRef`) and one of that customer's loans
// (`loanRef`, read from the core; without the core, at least the complaint's own loan). An executed
// imputation without a matched line it rests on is a finding too. Seeded summaries (no `result`) are not
// imputations and are not read.
import { type MatchedPayment, MatchedPaymentDetails, matchedPaymentOf } from "../agent-tools/actions/evidence";
import type { CaseFile } from "../connector/repos/case-items";
import type { Complaint } from "../domain/complaint";
import type { Evidence } from "../domain/case-items";
import type { CustomerFacts } from "../outbound/deps";
import type { Finding } from "./record";

export type ImputationReason = "PAYER_NOT_CUSTOMER" | "LOAN_NOT_CUSTOMERS" | "LOAN_NOT_SUBJECT" | "IMPUTATION_WITHOUT_LINE";

interface Candidate {
  readonly evidenceId: string;
  readonly atSim: string;
  readonly actionId?: string;
  /** `undefined`: an executed imputation whose founding evidence is not a matched line. */
  readonly payment?: MatchedPayment;
}

function matched(evidence: Evidence | undefined): MatchedPayment | undefined {
  if (evidence === undefined || evidence.kind !== "SETTLEMENT_MATCH") return undefined;
  const parsed = MatchedPaymentDetails.safeParse(evidence.details);
  return parsed.success ? matchedPaymentOf(parsed.data) : undefined;
}

/** The imputations of one complaint: executed `APPLY_PAYMENT` actions and `MATCHED` reconciliations. */
export function imputationsOf(file: CaseFile): Candidate[] {
  const byId = new Map(file.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const candidates = new Map<string, Candidate>();
  for (const evidence of file.evidence) {
    if (evidence.kind !== "SETTLEMENT_MATCH" || evidence.details["result"] !== "MATCHED") continue;
    const payment = matched(evidence);
    candidates.set(evidence.evidenceId, { evidenceId: evidence.evidenceId, atSim: evidence.atSim, ...(payment === undefined ? {} : { payment }) });
  }
  for (const action of file.actions) {
    if (action.kind !== "APPLY_PAYMENT" || action.status !== "EXECUTED") continue;
    const evidence = action.evidenceId === undefined ? undefined : byId.get(action.evidenceId);
    const payment = matched(evidence);
    const evidenceId = action.evidenceId ?? `none-${action.actionId}`;
    candidates.set(evidenceId, { evidenceId, atSim: action.atSim, actionId: action.actionId, ...(payment === undefined ? {} : { payment }) });
  }
  return [...candidates.values()];
}

function reasonOf(candidate: Candidate, complaint: Complaint, customer: CustomerFacts | undefined): ImputationReason | undefined {
  const { payment } = candidate;
  if (payment === undefined) return "IMPUTATION_WITHOUT_LINE";
  if (payment.customerRef !== undefined && payment.customerRef !== complaint.customerId) return "PAYER_NOT_CUSTOMER";
  if (customer !== undefined) return customer.loans.some((loan) => loan.loanId === payment.loanId) ? undefined : "LOAN_NOT_CUSTOMERS";
  const subject = complaint.subject?.loanId;
  return subject !== undefined && subject !== payment.loanId ? "LOAN_NOT_SUBJECT" : undefined;
}

/** The findings of check (c) for one complaint, and how many imputations it looked at. */
export function imputationFindings(complaint: Complaint, file: CaseFile, customer: CustomerFacts | undefined): { readonly checked: number; readonly findings: Finding[] } {
  const candidates = imputationsOf(file);
  const findings: Finding[] = [];
  for (const candidate of candidates) {
    const reason = reasonOf(candidate, complaint, customer);
    if (reason === undefined) continue;
    findings.push({
      check: "FOREIGN_SETTLEMENT",
      key: `FOREIGN_SETTLEMENT#${complaint.complaintId}#${candidate.evidenceId}`,
      ruleIds: ["LAM-EVIDENCE"],
      reason,
      refs: { complaintId: complaint.complaintId, evidenceId: candidate.evidenceId, ...(candidate.actionId === undefined ? {} : { actionId: candidate.actionId }) },
      atSim: candidate.atSim,
      primaryRef: `CMP#${complaint.complaintId}`,
    });
  }
  return { checked: candidates.length, findings };
}
