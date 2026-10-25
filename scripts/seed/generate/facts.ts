// What the manifest records about each persona (docs/seed-spec.md §8: "the exact amounts, dates and
// codes of each persona come from the generator and stay in the manifest"): customer, phone, loans
// with their instalment, the scenario's payments, charges, debits, transfers and receipts, and the
// amounts docs/flows-catalog.md quotes (invariant 14 compares them).
import { formatPesos } from "@reclamo/shared";
import { seededHistoryBox } from "../lib/kpis";
import type { WorldTemplateFile } from "../lib/template";
import type { Ledger } from "./ledger";
import { PERSONA_SPECS } from "./persona-specs";
import type { ReceiptFile } from "./receipt-catalog";
import { personaCustomerId } from "./worlds";

function quoted(ledger: Ledger): Record<string, Record<string, string>> {
  const loan = (id: string) => ledger.loans.find((candidate) => candidate.customerId === personaCustomerId(id));
  const charge = (id: string, feeCode: string) => ledger.charges.filter((candidate) => candidate.customerId === personaCustomerId(id) && candidate.feeCode === feeCode && candidate.expected.verdict === "WRONG")[0];
  const debit = (id: string) => ledger.debits.find((candidate) => candidate.customerId === personaCustomerId(id) && !candidate.paymentId);
  const payment = (id: string) => ledger.payments.find((candidate) => candidate.customerId === personaCustomerId(id) && candidate.network === "NORTE");
  const c09 = loan("C09");
  return {
    C01: { principal: formatPesos(loan("C01")?.principal ?? 0), instalment: formatPesos(loan("C01")?.instalment ?? 0), paymentCode: payment("C01")?.operationCode ?? "" },
    C03: { duplicateDebit: formatPesos(debit("C03")?.amount ?? 0) },
    C09: { overdueInstalment: formatPesos(c09?.rows[2]?.amount ?? 0), dueDate: c09?.rows[2]?.dueDate ?? "" },
    C13: { payment: formatPesos(payment("C13")?.amount ?? 0) },
    C23: { charge: formatPesos(charge("C23", "FEE-INS")?.amount ?? 0) },
    C24: { charge: formatPesos(charge("C24", "FEE-ORIG")?.amount ?? 0) },
  };
}

function personas(ledger: Ledger, receipts: readonly ReceiptFile[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of PERSONA_SPECS) {
    const customerId = personaCustomerId(spec.id);
    const customer = ledger.customers.find((candidate) => candidate.customerId === customerId);
    out[spec.id] = {
      customerId,
      phone: customer?.phone,
      loans: ledger.loans.filter((loan) => loan.customerId === customerId).map((loan) => ({ loanId: loan.loanId, principal: loan.principal, instalments: loan.count, instalment: loan.instalment, annualRate: loan.annualRate, disbursement: loan.disbursement.status })),
      payments: ledger.payments
        .filter((payment) => payment.customerId === customerId && payment.network !== "WALLET")
        .map((payment) => ({ network: payment.network, operationCode: payment.operationCode, amount: payment.amount, paidAt: payment.paidAt, instalments: payment.instalments, applied: payment.applied, businessDate: payment.businessDate })),
      charges: ledger.charges.filter((charge) => charge.customerId === customerId).map((charge) => ({ feeCode: charge.feeCode, amount: charge.amount, chargedAt: charge.chargedAt, verdict: charge.expected.verdict })),
      duplicateDebits: ledger.debits.filter((debit) => debit.customerId === customerId && !debit.paymentId).map((debit) => ({ instalment: debit.instalment, amount: debit.amount, at: debit.at })),
      transfers: ledger.transfers.filter((transfer) => transfer.customerId === customerId).map((transfer) => ({ transferId: transfer.transferId, amount: transfer.amount, status: transfer.status, at: transfer.at })),
      receipts: receipts.filter((receipt) => receipt.persona === spec.id).map((receipt) => receipt.id),
    };
  }
  return out;
}

/** What `check_charge` must answer for every seeded charge, by template ledger. */
function chargeVerdicts(ledger: Ledger): Record<string, string> {
  return Object.fromEntries(ledger.charges.map((charge) => [charge.chargeId, charge.expected.verdict]));
}

export function manifestFacts(ledger: Ledger, qaLedger: Ledger, receipts: readonly ReceiptFile[], qaMin: WorldTemplateFile): Record<string, unknown> {
  return {
    quoted: quoted(ledger),
    personas: personas(ledger, receipts),
    qaMinSeededHistory: seededHistoryBox(qaMin),
    chargeVerdicts: { full: chargeVerdicts(ledger), "qa-min": chargeVerdicts(qaLedger) },
  };
}
