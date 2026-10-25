// Builds the 41 personas into the ledger (docs/seed-spec.md §5-§8) from their specs and their
// names in copy/persona-scripts.ts: customer, loans with their automatic debits, the payments each
// scenario needs, charges, duplicates, transfers and disbursements. Returns, per persona, the
// payments that receipts are rendered from.
import { PERSONA_SCRIPTS } from "@reclamo/bff/copy/persona-scripts";
import { syntheticCvu, syntheticDocument, syntheticPhone } from "../lib/codes";
import { addMinutes } from "./calendar";
import { type Ledger, type PaymentRecord, addCharge, addDebit, addLoan, addPayment, at, cents, correct, rowOf } from "./ledger";
import { lateInterest, originationFee } from "./loans";
import { DEFAULT_ANNUAL_RATE, PERSONA_SPECS, type PersonaSpec, personaNumber } from "./persona-specs";

export interface PersonaReceiptSource {
  readonly personaId: string;
  readonly variant: "legible" | "blurry" | "injection";
  readonly payment: PaymentRecord;
}

const STREETS = ["Calle de las Acacias", "Pasaje de los Ceibos", "Calle de los Aromos", "Av. de los Lapachos", "Calle de las Tipas", "Pasaje de los Talas"];

export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.split(" ");
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) ?? full };
}

export function syntheticAddress(number: number): string {
  return `${STREETS[number % STREETS.length]} ${100 + ((number * 37) % 1900)}, Ciudad Ficticia`;
}

function scriptName(id: string): string {
  const script = PERSONA_SCRIPTS.find((candidate) => candidate.id === id);
  if (!script) throw new Error(`persona ${id} has no script in copy/persona-scripts.ts`);
  return script.name;
}

function buildPersona(ledger: Ledger, spec: PersonaSpec, receipts: PersonaReceiptSource[]): void {
  const number = personaNumber(spec.id);
  const customerId = `cus-${String(number).padStart(4, "0")}`;
  ledger.customers.push({
    number,
    customerId,
    persona: spec.id,
    ...splitName(scriptName(spec.id)),
    phone: syntheticPhone(number),
    document: syntheticDocument(number),
    cvu: syntheticCvu(number),
    address: syntheticAddress(number),
    optIn: spec.optIn ?? true,
    bounce: spec.bounce ?? false,
    ...(spec.blocked ? { blocked: spec.blocked } : {}),
    walletBalance: cents(spec.walletBalance),
  });
  for (const loanSpec of spec.loans) {
    const loan = addLoan(ledger, {
      loanId: `L-${String(number).padStart(4, "0")}${loanSpec.suffix ?? ""}`,
      customerId,
      principal: cents(loanSpec.principal),
      count: loanSpec.count,
      ...(loanSpec.instalment ? { instalment: cents(loanSpec.instalment) } : {}),
      annualRate: DEFAULT_ANNUAL_RATE,
      firstDue: loanSpec.firstDue,
      ...(loanSpec.disbursement
        ? {
            disbursement: {
              status: loanSpec.disbursement.status,
              at: at(loanSpec.disbursement.at),
              ...(loanSpec.disbursement.expectedBy ? { expectedBy: at(loanSpec.disbursement.expectedBy) } : {}),
              ...(loanSpec.disbursement.returnedAt ? { returnedAt: at(loanSpec.disbursement.returnedAt) } : {}),
            },
          }
        : {}),
    });
    for (let instalment = 1; instalment <= loanSpec.paidThrough; instalment += 1) {
      const due = rowOf(loan, instalment).dueDate;
      if (loanSpec.latePayment?.instalment === instalment) {
        const paidAt = addMinutes(at(`${due} 10:00`), loanSpec.latePayment.days * 24 * 60);
        addPayment(ledger, { loan, network: "WALLET", instalments: [instalment], paidAt, applied: true });
        const fee = lateInterest(rowOf(loan, instalment).amount, loan.annualRate, loanSpec.latePayment.days);
        addCharge(ledger, { customerId, loanId: loan.loanId, instalment, feeCode: "FEE-PUNIT", amount: fee, chargedAt: paidAt, expected: correct(fee, ["T-3.2", "T-3.4"]) });
        continue;
      }
      addDebit(ledger, loan, instalment, at(`${due} 07:00`));
    }
    if (loanSpec.duplicateDebit) addDebit(ledger, loan, loanSpec.duplicateDebit.instalment, at(loanSpec.duplicateDebit.at), false);
    if (loanSpec.jointDebit) for (const instalment of loanSpec.jointDebit.instalments) addDebit(ledger, loan, instalment, at(loanSpec.jointDebit.at));
    for (const payment of loanSpec.payments ?? []) {
      const record = addPayment(ledger, {
        loan,
        network: payment.network,
        instalments: payment.instalments,
        paidAt: at(payment.at),
        ...(payment.amount ? { amount: cents(payment.amount) } : {}),
        applied: payment.applied,
        ...(payment.seq ? { seq: payment.seq } : {}),
        terminal: payment.terminal ?? `T-${String(1000 + ((number * 131) % 9000)).slice(0, 4)}`,
      });
      if (payment.receipt) receipts.push({ personaId: spec.id, variant: payment.receipt, payment: record });
    }
  }
  for (const charge of spec.charges ?? []) {
    const loan = ledger.loans.find((candidate) => candidate.customerId === customerId);
    const chargedAt = at(charge.at);
    if (charge.feeCode === "FEE-CARD-REPL") {
      const amount = cents(2_500);
      addCharge(ledger, {
        customerId,
        feeCode: charge.feeCode,
        amount,
        chargedAt,
        requested: charge.requested === true,
        expected: charge.requested ? correct(amount, ["T-4.6"]) : { verdict: "WRONG", reason: "NOT_REQUESTED", expectedAmount: 0, clauseIds: ["T-4.6"] },
      });
    } else if (charge.feeCode === "FEE-INS") {
      addCharge(ledger, {
        customerId,
        ...(loan ? { loanId: loan.loanId } : {}),
        feeCode: charge.feeCode,
        amount: cents(charge.amount ?? 0),
        chargedAt,
        expected: { verdict: "WRONG", reason: "NOT_CHARGEABLE", expectedAmount: 0, clauseIds: ["T-1.5"] },
      });
    } else {
      if (!loan) throw new Error(`${spec.id}: FEE-ORIG without a loan`);
      addCharge(ledger, {
        customerId,
        loanId: loan.loanId,
        feeCode: charge.feeCode,
        amount: originationFee(loan.principal),
        chargedAt,
        expected: { verdict: "WRONG", reason: "DUPLICATED", expectedAmount: 0, clauseIds: ["T-1.6"] },
      });
    }
  }
  for (const [index, transfer] of (spec.transfers ?? []).entries()) {
    const transferId = `trf-${String(number).padStart(4, "0")}-${index + 1}`;
    ledger.transfers.push({
      transferId,
      customerId,
      direction: transfer.direction,
      amount: cents(transfer.amount),
      at: at(transfer.at),
      status: transfer.status,
      counterpartyMasked: `CVU •••• ${String(4000 + number * 17).slice(-4)}`,
      ...(transfer.traceId ? { traceId: transfer.traceId } : {}),
      ...(transfer.expectedBy ? { expectedBy: at(transfer.expectedBy) } : {}),
      ...(transfer.rejectReason ? { rejectReason: transfer.rejectReason } : {}),
      ...(transfer.reversedAt ? { reversedAt: at(transfer.reversedAt) } : {}),
    });
    const outStatus = transfer.status === "COMPLETED" ? "COMPLETED" : transfer.status === "PENDING" ? "PENDING" : transfer.status === "REJECTED_REVERSED" ? "REVERSED" : "REJECTED";
    ledger.movements.push({ movementId: `mvt-${transferId.slice(4)}`, customerId, kind: "TRANSFER_OUT", at: at(transfer.at), amount: cents(transfer.amount), direction: "OUT", description: "Transferencia saliente", status: outStatus, ref: { transferId } });
    if (transfer.reversedAt) {
      ledger.movements.push({ movementId: `mvt-${transferId.slice(4)}-r`, customerId, kind: "CREDIT", at: at(transfer.reversedAt), amount: cents(transfer.amount), direction: "IN", description: "Reversión de transferencia rechazada", status: "COMPLETED", ref: { transferId } });
    }
  }
}

/** Every persona into `ledger`; the payments their receipts are rendered from. */
export function buildPersonas(ledger: Ledger): PersonaReceiptSource[] {
  const receipts: PersonaReceiptSource[] = [];
  for (const spec of PERSONA_SPECS) buildPersona(ledger, spec, receipts);
  return receipts;
}
