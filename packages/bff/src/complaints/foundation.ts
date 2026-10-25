// Which evidence founds `RESOLVED` for each complaint type (ADR-0005: the code decides), as an allow-list:
//
//   - a type with an investigation tool of its own (a payment, a charge, a duplicate debit, a transfer,
//     a disbursement) is founded only by that tool's evidence;
//   - a certificate, an early payoff or closure and an information request only by the account reads
//     (`LOAN_STATUS`, `PAYOFF_QUOTE`, `TERMS_CLAUSE`), which are their investigation;
//   - an unknown operation, a blocked account and a data change by no evidence at all.
//
// An executed action or an operator founds any type (complaints/state-machine.ts), so evidence filed on
// a complaint nobody investigated, or a receipt image, never closes it.
import type { ComplaintType } from "@reclamo/shared";
import type { EvidenceKind } from "../domain/case-items";

const ACCOUNT_EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set(["LOAN_STATUS", "PAYOFF_QUOTE", "TERMS_CLAUSE"]);

const NONE: ReadonlySet<EvidenceKind> = new Set();

/** The evidence that founds `RESOLVED` on each type. */
const FOUNDING_EVIDENCE: Readonly<Record<ComplaintType, ReadonlySet<EvidenceKind>>> = {
  PAYMENT_NOT_REFLECTED: new Set(["SETTLEMENT_MATCH"]),
  UNRECOGNIZED_CHARGE: new Set(["CHARGE_CHECK"]),
  DUPLICATE_DEBIT: new Set(["DUPLICATE_CHECK"]),
  TRANSFER_NOT_CREDITED: new Set(["TRANSFER_STATUS"]),
  DISBURSEMENT_NOT_RECEIVED: new Set(["DISBURSEMENT"]),
  PAYOFF_CERTIFICATE: ACCOUNT_EVIDENCE_KINDS,
  CLOSURE_OR_EARLY_PAYOFF: ACCOUNT_EVIDENCE_KINDS,
  INFORMATION_REQUEST: ACCOUNT_EVIDENCE_KINDS,
  UNKNOWN_OPERATION: NONE,
  ACCOUNT_BLOCKED: NONE,
  DATA_CHANGE: NONE,
};

/** The evidence kinds that found `RESOLVED` on this type (none: only an action or an operator does). */
export function foundingEvidenceKinds(type: ComplaintType): readonly EvidenceKind[] {
  return [...FOUNDING_EVIDENCE[type]];
}

/** Does one piece of evidence found `RESOLVED` on a complaint of this type? */
export function foundsResolution(type: ComplaintType, kind: EvidenceKind): boolean {
  return FOUNDING_EVIDENCE[type].has(kind);
}
