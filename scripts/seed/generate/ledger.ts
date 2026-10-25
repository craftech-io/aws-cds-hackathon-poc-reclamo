// The simulated lender's books as the generator builds them (centavos, local instants): customers,
// loans with their schedule, payments and how they were allocated, automatic debits, wallet
// movements, charges with the verdict the fee schedule gives, transfers. One mutable `Ledger` per
// seed; generate/core-items.ts turns it into the `Core` and `Networks` items of a template.
import { type CodePrefix, operationCode } from "../lib/codes";
import { localInstant } from "./calendar";
import { type ScheduleRow, instalmentForRate, originationFee, schedule, solveAnnualRate } from "./loans";

export type PayNetwork = "NORTE" | "SUR" | "WALLET";

export interface CustomerRecord {
  readonly number: number;
  readonly customerId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly persona?: string;
  readonly phone: string;
  readonly document: string;
  readonly cvu: string;
  readonly address: string;
  readonly optIn: boolean;
  readonly bounce: boolean;
  readonly blocked?: "IDENTITY_VALIDATION";
  readonly walletBalance: number;
}

export interface Disbursement {
  readonly status: "CREDITED" | "PENDING" | "FAILED_RETURNED";
  readonly gross: number;
  readonly originationFee: number;
  readonly net: number;
  readonly at: string;
  readonly creditedAt?: string;
  readonly expectedBy?: string;
  readonly returnedAt?: string;
}

export interface LoanRecord {
  readonly loanId: string;
  readonly customerId: string;
  readonly label: string;
  readonly principal: number;
  readonly count: number;
  readonly instalment: number;
  readonly annualRate: number;
  readonly rows: readonly ScheduleRow[];
  readonly disbursement: Disbursement;
}

export interface PaymentRecord {
  readonly paymentId: string;
  readonly customerId: string;
  readonly loanId: string;
  readonly network: PayNetwork;
  readonly operationCode: string;
  readonly amount: number;
  readonly paidAt: string;
  readonly instalments: readonly number[];
  readonly applied: boolean;
  appliedAt?: string;
  businessDate?: string;
  readonly terminal?: string;
  readonly debitId?: string;
}

export interface DebitRecord {
  readonly debitId: string;
  readonly customerId: string;
  readonly loanId: string;
  readonly instalment: number;
  readonly amount: number;
  readonly at: string;
  readonly paymentId?: string;
}

export type MovementKind = "PAYMENT" | "CHARGE" | "TRANSFER_IN" | "TRANSFER_OUT" | "DISBURSEMENT" | "DEBIT" | "CREDIT";

export interface MovementRecord {
  readonly movementId: string;
  readonly customerId: string;
  readonly kind: MovementKind;
  readonly at: string;
  readonly amount: number;
  readonly direction: "IN" | "OUT";
  readonly description: string;
  readonly status: "COMPLETED" | "PENDING" | "REJECTED" | "REVERSED";
  readonly ref: Readonly<Record<string, string | number>>;
}

export type ChargeVerdict = "CORRECT" | "WRONG";
export type ChargeReason = "MATCHES_SCHEDULE" | "NOT_REQUESTED" | "NOT_CHARGEABLE" | "DUPLICATED";

export interface ChargeRecord {
  readonly chargeId: string;
  readonly customerId: string;
  readonly loanId?: string;
  readonly instalment?: number;
  readonly feeCode: string;
  readonly amount: number;
  readonly chargedAt: string;
  /** What `check_charge` must answer (invariant 8 recomputes it from the fee schedule). */
  readonly expected: { readonly verdict: ChargeVerdict; readonly reason: ChargeReason; readonly expectedAmount: number; readonly clauseIds: readonly string[] };
  /** `FEE-CARD-REPL`: the customer asked for the card (T-4.6). */
  readonly requested?: boolean;
  reversal?: { readonly actionId: string; readonly creditNoteId: string; readonly complaintId: string; readonly amount: number; readonly compensatoryInterest: number; readonly at: string };
}

export interface TransferRecord {
  readonly transferId: string;
  readonly customerId: string;
  readonly direction: "OUT";
  readonly amount: number;
  readonly at: string;
  readonly status: "COMPLETED" | "PENDING" | "REJECTED_REVERSED" | "REJECTED_NOT_REVERSED";
  readonly traceId?: string;
  readonly expectedBy?: string;
  readonly rejectReason?: string;
  readonly reversedAt?: string;
  readonly counterpartyMasked: string;
}

export interface Ledger {
  readonly customers: CustomerRecord[];
  readonly loans: LoanRecord[];
  readonly payments: PaymentRecord[];
  readonly debits: DebitRecord[];
  readonly movements: MovementRecord[];
  readonly charges: ChargeRecord[];
  readonly transfers: TransferRecord[];
  readonly codeSeq: Map<string, number>;
}

export function newLedger(): Ledger {
  return { customers: [], loans: [], payments: [], debits: [], movements: [], charges: [], transfers: [], codeSeq: new Map() };
}

/** `2026-10-06 18:40` → local instant. */
export function at(text: string): string {
  const [date = "", time = ""] = text.split(" ");
  return localInstant(date, time);
}

export const cents = (pesos: number): number => Math.round(pesos * 100);

/** The next operation code of a prefix and date (sequences from 10000 up; fixed flow codes stay below). */
export function nextCode(ledger: Ledger, prefix: CodePrefix, date: string, fixed?: number): string {
  if (fixed !== undefined) return operationCode(prefix, date, fixed);
  const key = `${prefix}#${date}`;
  const seq = (ledger.codeSeq.get(key) ?? 10_000) + 7;
  ledger.codeSeq.set(key, seq);
  return operationCode(prefix, date, seq);
}

export interface NewLoan {
  readonly loanId: string;
  readonly customerId: string;
  readonly principal: number;
  readonly count: number;
  readonly instalment?: number;
  readonly annualRate: number;
  readonly firstDue: string;
  readonly disbursement?: { readonly status: Disbursement["status"]; readonly at: string; readonly expectedBy?: string; readonly returnedAt?: string };
}

export function addLoan(ledger: Ledger, spec: NewLoan): LoanRecord {
  const instalment = spec.instalment ?? instalmentForRate(spec.principal, spec.count, spec.annualRate);
  const annualRate = solveAnnualRate(spec.principal, spec.count, instalment);
  const fee = originationFee(spec.principal);
  const disbursedAt = spec.disbursement?.at ?? localInstant(addMonthsBack(spec.firstDue), "10:00");
  const status = spec.disbursement?.status ?? "CREDITED";
  const disbursement: Disbursement = {
    status,
    gross: spec.principal,
    originationFee: fee,
    net: spec.principal - fee,
    at: disbursedAt,
    ...(status === "CREDITED" ? { creditedAt: disbursedAt } : {}),
    ...(spec.disbursement?.expectedBy ? { expectedBy: spec.disbursement.expectedBy } : {}),
    ...(spec.disbursement?.returnedAt ? { returnedAt: spec.disbursement.returnedAt } : {}),
  };
  const loan: LoanRecord = {
    loanId: spec.loanId,
    customerId: spec.customerId,
    label: `Préstamo personal ${spec.loanId}`,
    principal: spec.principal,
    count: spec.count,
    instalment,
    annualRate,
    rows: schedule(spec.principal, spec.count, instalment, annualRate, spec.firstDue),
    disbursement,
  };
  ledger.loans.push(loan);
  const disbursementId = `dsb-${spec.loanId.slice(2)}`;
  ledger.movements.push({
    movementId: disbursementId,
    customerId: spec.customerId,
    kind: "DISBURSEMENT",
    at: disbursedAt,
    amount: disbursement.net,
    direction: "IN",
    description: `Desembolso del ${loan.label}, neto de la comisión de otorgamiento`,
    status: status === "CREDITED" ? "COMPLETED" : status === "PENDING" ? "PENDING" : "REJECTED",
    ref: { loanId: spec.loanId },
  });
  if (status === "CREDITED") addCharge(ledger, { customerId: spec.customerId, loanId: spec.loanId, feeCode: "FEE-ORIG", amount: fee, chargedAt: disbursedAt, expected: correct(fee, ["T-1.6"]) });
  return loan;
}

function addMonthsBack(firstDue: string): string {
  const [year = 0, month = 1, day = 1] = firstDue.split("-").map(Number);
  const total = year * 12 + month - 2;
  const last = new Date(Date.UTC(Math.floor(total / 12), (total % 12) + 1, 0)).getUTCDate();
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

export function correct(amount: number, clauseIds: readonly string[]): ChargeRecord["expected"] {
  return { verdict: "CORRECT", reason: "MATCHES_SCHEDULE", expectedAmount: amount, clauseIds };
}

export function addCharge(ledger: Ledger, charge: Omit<ChargeRecord, "chargeId">): ChargeRecord {
  const record: ChargeRecord = { ...charge, chargeId: `chg-${charge.customerId.slice(4)}-${String(ledger.charges.filter((c) => c.customerId === charge.customerId).length + 1).padStart(2, "0")}` };
  ledger.charges.push(record);
  ledger.movements.push({
    movementId: record.chargeId,
    customerId: charge.customerId,
    kind: "CHARGE",
    at: charge.chargedAt,
    amount: charge.amount,
    direction: "OUT",
    description: `Cargo ${charge.feeCode}`,
    status: "COMPLETED",
    ref: { chargeId: record.chargeId, ...(charge.loanId ? { loanId: charge.loanId } : {}) },
  });
  return record;
}

export function loanOf(ledger: Ledger, loanId: string): LoanRecord {
  const loan = ledger.loans.find((candidate) => candidate.loanId === loanId);
  if (!loan) throw new Error(`unknown loan ${loanId}`);
  return loan;
}

export function rowOf(loan: LoanRecord, number: number): ScheduleRow {
  const row = loan.rows[number - 1];
  if (!row) throw new Error(`${loan.loanId} has no instalment ${number}`);
  return row;
}

export interface NewPayment {
  readonly loan: LoanRecord;
  readonly network: PayNetwork;
  readonly instalments: readonly number[];
  readonly paidAt: string;
  readonly amount?: number;
  readonly applied: boolean;
  readonly seq?: number;
  readonly terminal?: string;
  readonly debitId?: string;
  readonly description?: string;
}

const PREFIX: Readonly<Record<PayNetwork, CodePrefix>> = { NORTE: "NTE", SUR: "SUR", WALLET: "BIL" };

/** Records a payment; a wallet payment also moves the wallet. Settlement fields are set by the caller. */
export function addPayment(ledger: Ledger, input: NewPayment): PaymentRecord {
  const amount = input.amount ?? input.instalments.reduce((sum, number) => sum + rowOf(input.loan, number).amount, 0);
  const index = ledger.payments.filter((payment) => payment.loanId === input.loan.loanId).length + 1;
  const payment: PaymentRecord = {
    paymentId: `pay-${input.loan.loanId.slice(2)}-${String(index).padStart(2, "0")}`,
    customerId: input.loan.customerId,
    loanId: input.loan.loanId,
    network: input.network,
    operationCode: nextCode(ledger, PREFIX[input.network], input.paidAt.slice(0, 10), input.seq),
    amount,
    paidAt: input.paidAt,
    instalments: input.instalments,
    applied: input.applied,
    ...(input.applied && input.network === "WALLET" ? { appliedAt: input.paidAt } : {}),
    ...(input.terminal ? { terminal: input.terminal } : {}),
    ...(input.debitId ? { debitId: input.debitId } : {}),
  };
  ledger.payments.push(payment);
  if (input.network === "WALLET") {
    ledger.movements.push({
      movementId: `mvp-${payment.paymentId.slice(4)}`,
      customerId: payment.customerId,
      kind: input.debitId ? "DEBIT" : "PAYMENT",
      at: input.paidAt,
      amount,
      direction: "OUT",
      description: input.description ?? `Pago de la cuota ${input.instalments.join(" y ")} del ${input.loan.label}`,
      status: "COMPLETED",
      ref: { loanId: input.loan.loanId, instalment: input.instalments[0] ?? 1, ...(payment.applied ? { paymentId: payment.paymentId } : {}), ...(input.debitId ? { debitId: input.debitId } : {}) },
    });
  }
  return payment;
}

/** An automatic debit of one instalment from the wallet; `applied` false for the seeded duplicates. */
export function addDebit(ledger: Ledger, loan: LoanRecord, instalment: number, debitAt: string, applied = true): DebitRecord {
  const debitId = `dbt-${loan.loanId.slice(2)}-${String(ledger.debits.filter((debit) => debit.loanId === loan.loanId).length + 1).padStart(2, "0")}`;
  const amount = rowOf(loan, instalment).amount;
  const payment = applied
    ? addPayment(ledger, { loan, network: "WALLET", instalments: [instalment], paidAt: debitAt, applied: true, debitId, description: `Débito automático de la cuota ${instalment} del ${loan.label}` })
    : undefined;
  const debit: DebitRecord = { debitId, customerId: loan.customerId, loanId: loan.loanId, instalment, amount, at: debitAt, ...(payment ? { paymentId: payment.paymentId } : {}) };
  ledger.debits.push(debit);
  if (!payment) {
    ledger.movements.push({
      movementId: `mvd-${debitId.slice(4)}`,
      customerId: loan.customerId,
      kind: "DEBIT",
      at: debitAt,
      amount,
      direction: "OUT",
      description: `Débito automático de la cuota ${instalment} del ${loan.label}`,
      status: "COMPLETED",
      ref: { loanId: loan.loanId, instalment, debitId },
    });
  }
  return debit;
}

/** How much of each instalment the applied payments cover. */
export function appliedByInstalment(ledger: Ledger, loan: LoanRecord): Map<number, number> {
  const covered = new Map<number, number>();
  for (const payment of ledger.payments.filter((candidate) => candidate.loanId === loan.loanId && candidate.applied)) {
    let left = payment.amount;
    for (const number of payment.instalments) {
      const row = rowOf(loan, number);
      const take = Math.min(left, row.amount - (covered.get(number) ?? 0));
      covered.set(number, (covered.get(number) ?? 0) + take);
      left -= take;
    }
  }
  return covered;
}
