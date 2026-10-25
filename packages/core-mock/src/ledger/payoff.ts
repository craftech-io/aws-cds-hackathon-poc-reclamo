// `POST /loans/{loanId}/payoff-quote`: the early payoff quote (`T-6.1`…`T-6.4`), computed by the
// core and stored (`QUOTE#`). The agent reports it as it is and never asks for the payment.
//
//   principal       what is left of the principal of the unpaid instalments
//   accruedInterest interest (with VAT) of the overdue instalments still unpaid, late interest still
//                   owed, and the current period's interest pro rata to the day
//   fee             `FEE-EARLY`: 2 % of that principal, only while less than 25 % of the term has
//                   elapsed (`T-6.2`)
//   validUntilSim   end of the current business day (or of the next one, on a weekend or holiday)
import type { PayoffQuote, PayoffQuoteRequest } from "@reclamo/core-contract";
import { putNew } from "../store/codec";
import type { InstalmentItem, PayoffQuoteItem } from "../store/items";
import { coreKeys } from "../store/keys";
import { loadLoan } from "./bundle";
import { commitWithRetry } from "./claims";
import { type LedgerContext, LedgerError, centsOf, daysBetween, deterministicId, localDate } from "./context";
import { EARLY_PAYOFF_RATE, EARLY_PAYOFF_TERM_SHARE } from "./fees";
import { instalmentOutstanding } from "./loans";

/**
 * Non-business days the core's own calendar knows (Argentina, the stretch the demo covers;
 * docs/seed-spec.md §11). The regulatory clock reads `Reference`; the core is an external system
 * and keeps its own copy.
 */
export const CORE_HOLIDAYS: readonly string[] = ["2026-10-12", "2026-11-09", "2026-11-23", "2026-12-07", "2026-12-08", "2026-12-25", "2027-01-01"];

export function isBusinessDay(date: string, holidays: readonly string[] = CORE_HOLIDAYS): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.includes(date);
}

/** 23:59:59 (Argentina) of `date` if it is a business day, else of the next business day. */
export function endOfBusinessDay(date: string, holidays: readonly string[] = CORE_HOLIDAYS): string {
  let day = date;
  for (let guard = 0; guard < 15 && !isBusinessDay(day, holidays); guard += 1) day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `${day}T23:59:59-03:00`;
}

export interface PayoffFigures {
  readonly principal: number;
  readonly accruedInterest: number;
  readonly fee: number;
  readonly feeApplies: boolean;
}

/** Share of the instalment still unpaid (late interest aside), 0 to 1. */
function unpaidShare(instalment: InstalmentItem): number {
  return instalment.amount === 0 ? 0 : Math.max(0, instalment.amount - instalment.paid) / instalment.amount;
}

/** Pure: the quote's figures on `today` from the loan's instalments. */
export function payoffFigures(instalments: readonly InstalmentItem[], instalmentsCount: number, today: string, disbursedDate?: string): PayoffFigures {
  const sorted = [...instalments].sort((a, b) => a.number - b.number);
  let principal = 0;
  let accrued = 0;
  sorted.forEach((instalment, index) => {
    if (instalmentOutstanding(instalment) === 0) return;
    const share = unpaidShare(instalment);
    principal += centsOf(instalment.principal * share);
    accrued += Math.max(0, instalment.lateInterest - Math.max(0, instalment.paid - instalment.amount));
    const interest = (instalment.interest + instalment.vat) * share;
    if (instalment.dueDate <= today) {
      accrued += centsOf(interest);
      return;
    }
    const previous = sorted[index - 1];
    const periodStart = previous?.dueDate ?? disbursedDate;
    if (periodStart === undefined || periodStart >= today) return;
    const period = daysBetween(periodStart, instalment.dueDate);
    if (period > 0) accrued += centsOf((interest * daysBetween(periodStart, today)) / period);
  });
  const elapsed = sorted.filter((instalment) => instalment.dueDate <= today).length;
  const feeApplies = elapsed < instalmentsCount * EARLY_PAYOFF_TERM_SHARE;
  return { principal, accruedInterest: accrued, fee: feeApplies ? centsOf(principal * EARLY_PAYOFF_RATE) : 0, feeApplies };
}

function toQuote(item: PayoffQuoteItem): PayoffQuote {
  return {
    quoteId: item.quoteId,
    loanId: item.loanId,
    customerId: item.customerId,
    principal: item.principal,
    accruedInterest: item.accruedInterest,
    fee: item.fee,
    ...(item.feeClauseId === undefined ? {} : { feeClauseId: item.feeClauseId }),
    total: item.total,
    asOfSim: item.asOfSim,
    validUntilSim: item.validUntilSim,
  };
}

export async function quoteEarlyPayoff(ctx: LedgerContext, loanId: string, request: PayoffQuoteRequest): Promise<PayoffQuote> {
  return commitWithRetry(async () => {
    const { bundle, state } = await loadLoan(ctx, loanId, request.customerId);
    const loan = state.loan.value;
    if (loan.status === "CANCELLED" || loan.status === "EARLY_CANCELLED") throw new LedgerError("NOT_ELIGIBLE", "the loan is already cancelled");
    const quoteId = deterministicId("q", ctx.worldId, loanId, ctx.simNow);
    const existing = bundle.quotes.get(quoteId);
    if (existing !== undefined) return { writes: [], result: toQuote(existing.value) };
    const today = localDate(ctx.simNow);
    const figures = payoffFigures(
      state.instalments.map((instalment) => instalment.value),
      loan.instalmentsCount,
      today,
      loan.disbursedAtSim === undefined ? undefined : localDate(loan.disbursedAtSim),
    );
    const quote: PayoffQuote = {
      quoteId,
      loanId,
      customerId: request.customerId,
      principal: figures.principal,
      accruedInterest: figures.accruedInterest,
      fee: figures.fee,
      ...(figures.feeApplies ? { feeClauseId: "T-6.2" } : {}),
      total: figures.principal + figures.accruedInterest + figures.fee,
      asOfSim: ctx.simNow,
      validUntilSim: endOfBusinessDay(today),
    };
    const item: PayoffQuoteItem = { entity: "PayoffQuote", ...quote };
    return { writes: [putNew(item, bundle.pk, coreKeys.quoteSk(quoteId), bundle.stamp)], result: quote };
  }, ctx);
}
