// Loans and instalments as the core shows them (`GET /loans/{loanId}`, `/instalments`,
// `/disbursement`): statuses that depend on the date are derived from the world's simulated day,
// never stored, so advancing the clock moves an instalment to `OVERDUE` without a write.
import type { Disbursement, Instalment, InstalmentList, InstalmentStatus, Loan, LoanStatus, LoanSummary } from "@reclamo/core-contract";
import type { InstalmentItem } from "../store/items";
import type { CustomerBundle, LoanState } from "./bundle";
import { loadLoan } from "./bundle";
import { type LedgerContext, LedgerError, localDate } from "./context";

/** What is still owed on an instalment: its amount plus late interest, minus what was applied. */
export function instalmentOutstanding(instalment: Pick<InstalmentItem, "amount" | "lateInterest" | "paid">): number {
  return Math.max(0, instalment.amount + instalment.lateInterest - instalment.paid);
}

export function instalmentStatus(instalment: InstalmentItem, today: string): InstalmentStatus {
  if (instalmentOutstanding(instalment) === 0) return "PAID";
  if (instalment.paid > 0) return "PARTIALLY_PAID";
  return instalment.dueDate < today ? "OVERDUE" : "DUE";
}

export function loanOutstanding(state: LoanState): number {
  return state.instalments.reduce((sum, instalment) => sum + instalmentOutstanding(instalment.value), 0);
}

/** `CANCELLED`/`EARLY_CANCELLED` are final and stored; otherwise `IN_ARREARS` with any overdue balance. */
export function loanStatus(state: LoanState, today: string): LoanStatus {
  const stored = state.loan.value.status;
  if (stored === "CANCELLED" || stored === "EARLY_CANCELLED") return stored;
  const overdue = state.instalments.some((instalment) => instalment.value.dueDate < today && instalmentOutstanding(instalment.value) > 0);
  return overdue ? "IN_ARREARS" : "ACTIVE";
}

export function loanSummary(state: LoanState, today: string): LoanSummary {
  return { loanId: state.loan.value.loanId, label: state.loan.value.label, status: loanStatus(state, today), outstanding: loanOutstanding(state) };
}

export function toLoan(state: LoanState, today: string): Loan {
  const loan = state.loan.value;
  const next = state.instalments.find((instalment) => instalmentOutstanding(instalment.value) > 0);
  return {
    loanId: loan.loanId,
    customerId: loan.customerId,
    label: loan.label,
    principal: loan.principal,
    instalmentsCount: loan.instalmentsCount,
    paidCount: state.instalments.filter((instalment) => instalmentOutstanding(instalment.value) === 0).length,
    annualRate: loan.annualRate,
    status: loanStatus(state, today),
    outstanding: loanOutstanding(state),
    ...(loan.disbursedAtSim === undefined ? {} : { disbursedAtSim: loan.disbursedAtSim }),
    ...(loan.cancelledAtSim === undefined ? {} : { cancelledAtSim: loan.cancelledAtSim }),
    ...(next === undefined ? {} : { nextDue: { number: next.value.number, dueDate: next.value.dueDate, amount: instalmentOutstanding(next.value) } }),
  };
}

export function toInstalment(state: LoanState, instalment: InstalmentItem, today: string): Instalment {
  const payments = state.payments
    .flatMap((payment) =>
      payment.value.allocations
        .filter((allocation) => allocation.instalment === instalment.number)
        .map((allocation) => ({
          paymentId: payment.value.paymentId,
          network: payment.value.network,
          operationCode: payment.value.operationCode,
          amount: allocation.amount,
          paidAtSim: payment.value.paidAtSim,
          appliedAtSim: payment.value.appliedAtSim,
        })),
    )
    .slice(-20);
  return {
    number: instalment.number,
    dueDate: instalment.dueDate,
    principal: instalment.principal,
    interest: instalment.interest,
    vat: instalment.vat,
    amount: instalment.amount,
    lateInterest: instalment.lateInterest,
    outstanding: instalmentOutstanding(instalment),
    status: instalmentStatus(instalment, today),
    payments,
  };
}

export async function getLoan(ctx: LedgerContext, loanId: string): Promise<Loan> {
  const { state } = await loadLoan(ctx, loanId);
  return toLoan(state, localDate(ctx.simNow));
}

export async function listInstalments(ctx: LedgerContext, loanId: string): Promise<InstalmentList> {
  const { state } = await loadLoan(ctx, loanId);
  const today = localDate(ctx.simNow);
  return { loanId, customerId: state.loan.value.customerId, instalments: state.instalments.map((instalment) => toInstalment(state, instalment.value, today)) };
}

export async function getDisbursement(ctx: LedgerContext, loanId: string): Promise<Disbursement> {
  const { state } = await loadLoan(ctx, loanId);
  const record = state.loan.value.disbursement;
  if (record === undefined) throw new LedgerError("NOT_FOUND", "the loan has no disbursement record");
  return { loanId, customerId: state.loan.value.customerId, ...record };
}

/** Loans of a customer that still carry a balance (closure conditions, challenge questions). */
export function openLoans(bundle: CustomerBundle): LoanState[] {
  return [...bundle.loans.values()].filter((state) => loanOutstanding(state) > 0 && state.loan.value.status !== "CANCELLED" && state.loan.value.status !== "EARLY_CANCELLED");
}
