// `POST /loans/{loanId}/payments`: the imputation of a reconciled payment (docs/architecture-
// integrations.md §5). In order:
//
//   1. the loan is the session customer's, else `FORBIDDEN` (a payment line of another payer never
//      lands on this loan);
//   2. claim `OPC#<network>#<operationCode>`: one imputation per operation code, ever;
//   3. `amount ≤ cap` (the caller's tier), else `ABOVE_CAP`;
//   4. late interest (`T-3.2`: 50 % of the compensatory rate, daily, on the overdue amount) accrues
//      only past the 2-day tolerance of `T-3.4`, counted to the day the customer paid (not the day
//      the network settled);
//   5. `amount ≤` what the loan owes, else `EXCEEDS_OUTSTANDING`;
//   6. the amount goes to the oldest instalment first; a loan left at zero is `CANCELLED`.
//
// Claim, payment, instalments, loan and the movement are one transaction.
import { type PaymentRequest, type PaymentResult, PaymentResult as PaymentResultSchema } from "@reclamo/core-contract";
import { putChanged, putNew } from "../store/codec";
import type { InstalmentItem, MovementItem, PaymentItem } from "../store/items";
import { coreKeys } from "../store/keys";
import type { PutWrite } from "../store/port";
import { loadLoan } from "./bundle";
import { actionIdFor, answerTakenClaim, type ClaimRef, claimWrite, commitWithRetry, readClaim } from "./claims";
import { type LedgerContext, LedgerError, centsOf, daysBetween, deterministicId, localDate } from "./context";
import { instalmentOutstanding, instalmentStatus } from "./loans";

/** `T-3.4`: no late interest when the customer paid within this many calendar days of the due date. */
export const LATE_TOLERANCE_DAYS = 2;
/** `T-3.2`: the late rate is half the compensatory rate. */
export const LATE_RATE_FACTOR = 0.5;

/** Late interest of `base` for `days` late at a nominal annual rate, past the tolerance; 0 within it. */
export function lateInterestFor(base: number, annualRate: number, daysLate: number): number {
  if (daysLate <= LATE_TOLERANCE_DAYS || base <= 0) return 0;
  return centsOf((base * annualRate * LATE_RATE_FACTOR * daysLate) / 365);
}

export interface AllocationPlan {
  readonly allocations: ReadonlyArray<{ readonly instalment: number; readonly amount: number }>;
  /** Late interest added by this payment. */
  readonly lateInterest: number;
  /** Every instalment after the payment, same order. */
  readonly after: readonly InstalmentItem[];
  /** What the loan owed at the payment date, late interest included. */
  readonly owedBefore: number;
}

/**
 * Pure: late interest to the payment date, then the amount to the oldest instalment first. The
 * caller checks `amount ≤ owedBefore` before writing.
 */
export function planAllocation(instalments: readonly InstalmentItem[], amount: number, paidDate: string, annualRate: number): AllocationPlan {
  let lateInterest = 0;
  const withLate = [...instalments]
    .sort((a, b) => a.number - b.number)
    .map((instalment) => {
      const unpaidBase = Math.max(0, instalment.amount - instalment.paid);
      const accrued = lateInterestFor(unpaidBase, annualRate, daysBetween(instalment.dueDate, paidDate));
      const late = Math.max(instalment.lateInterest, accrued);
      lateInterest += late - instalment.lateInterest;
      return { ...instalment, lateInterest: late };
    });
  const owedBefore = withLate.reduce((sum, instalment) => sum + instalmentOutstanding(instalment), 0);
  let remaining = amount;
  const allocations: Array<{ instalment: number; amount: number }> = [];
  const after = withLate.map((instalment) => {
    const owed = instalmentOutstanding(instalment);
    if (remaining <= 0 || owed === 0) return instalment;
    const applied = Math.min(owed, remaining);
    remaining -= applied;
    allocations.push({ instalment: instalment.number, amount: applied });
    return { ...instalment, paid: instalment.paid + applied };
  });
  return { allocations, lateInterest, after, owedBefore };
}

const NETWORK_LABEL: Readonly<Record<PaymentRequest["network"], string>> = {
  NORTE: "Red de cobro Norte",
  SUR: "Red de cobro Sur",
  TRANSFER: "transferencia",
  WALLET: "billetera",
};

export async function applyPayment(ctx: LedgerContext, loanId: string, request: PaymentRequest): Promise<PaymentResult> {
  const ref: ClaimRef = { kind: "OPC", naturalKey: `${request.network}#${request.operationCode}` };
  return commitWithRetry(async () => {
    const { bundle, state } = await loadLoan(ctx, loanId, request.customerId);
    const taken = await readClaim(ctx, ref);
    if (taken !== undefined) return { writes: [], result: answerTakenClaim(taken.value, request.idempotencyKey, PaymentResultSchema) };
    if (request.amount > request.cap) throw new LedgerError("ABOVE_CAP", "the amount is above the caller's cap");
    const loan = state.loan.value;
    if (loan.status === "CANCELLED" || loan.status === "EARLY_CANCELLED") throw new LedgerError("EXCEEDS_OUTSTANDING", "the loan is already cancelled");

    const paidDate = localDate(request.paidAtSim);
    const plan = planAllocation(
      state.instalments.map((instalment) => instalment.value),
      request.amount,
      paidDate,
      loan.annualRate,
    );
    if (request.amount > plan.owedBefore) throw new LedgerError("EXCEEDS_OUTSTANDING", "the amount is above what the loan owes");

    const today = localDate(ctx.simNow);
    const actionId = actionIdFor(ctx, ref);
    const paymentId = deterministicId("pay", ctx.worldId, ref.naturalKey);
    const cancelled = plan.after.every((instalment) => instalmentOutstanding(instalment) === 0);
    const outstandingAfter = plan.after.reduce((sum, instalment) => sum + instalmentOutstanding(instalment), 0);
    const result: PaymentResult = {
      actionId,
      paymentId,
      applied: request.amount,
      lateInterest: plan.lateInterest,
      allocations: plan.allocations.map((allocation) => {
        const instalment = plan.after.find((candidate) => candidate.number === allocation.instalment);
        return { instalment: allocation.instalment, amount: allocation.amount, statusAfter: instalment === undefined ? "DUE" : instalmentStatus(instalment, today) };
      }),
      loanStatusAfter: cancelled ? "CANCELLED" : plan.after.some((instalment) => instalment.dueDate < today && instalmentOutstanding(instalment) > 0) ? "IN_ARREARS" : "ACTIVE",
      outstandingAfter,
    };

    const payment: PaymentItem = {
      entity: "Payment",
      paymentId,
      loanId,
      customerId: request.customerId,
      network: request.network,
      operationCode: request.operationCode,
      amount: request.amount,
      paidAtSim: request.paidAtSim,
      appliedAtSim: ctx.simNow,
      source: request.source,
      allocations: plan.allocations.map((allocation) => ({ ...allocation })),
      lateInterest: plan.lateInterest,
      complaintId: request.complaintId,
      actionId,
      opCodeKey: coreKeys.opCodeKey(ctx.worldId, request.network, request.operationCode),
    };
    const movement: MovementItem = {
      entity: "Movement",
      movementId: deterministicId("mov", ctx.worldId, paymentId),
      customerId: request.customerId,
      kind: "PAYMENT",
      atSim: ctx.simNow,
      amount: request.amount,
      direction: "OUT",
      description: `Pago imputado al préstamo ${loan.label} (${NETWORK_LABEL[request.network]})`.slice(0, 140),
      status: "COMPLETED",
      ref: { loanId, paymentId, ...(plan.allocations[0] === undefined ? {} : { instalment: plan.allocations[0].instalment }) },
    };

    const writes: PutWrite[] = [
      claimWrite(ctx, ref, bundle.stamp, { customerId: request.customerId, complaintId: request.complaintId, amount: request.amount, idempotencyKey: request.idempotencyKey, result }),
      putNew(payment, bundle.pk, coreKeys.paymentSk(loanId, paymentId), bundle.stamp),
      putNew(movement, bundle.pk, coreKeys.movementSk(ctx.simNow, movement.movementId), bundle.stamp),
      putChanged(state.loan, cancelled ? { ...loan, status: "CANCELLED", cancelledAtSim: ctx.simNow } : loan, bundle.stamp),
    ];
    for (const stored of state.instalments) {
      const next = plan.after.find((instalment) => instalment.number === stored.value.number);
      if (next !== undefined && (next.paid !== stored.value.paid || next.lateInterest !== stored.value.lateInterest)) writes.push(putChanged(stored, next, bundle.stamp));
    }
    return { writes, result };
  }, ctx);
}
