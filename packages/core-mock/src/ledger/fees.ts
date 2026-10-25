// `POST /charges/{chargeId}/check`: a charge against the fee schedule in force on its date
// (docs/seed-spec.md §3, `FEES#v001`). Deterministic: the verdict, the expected amount and the
// clauses come from the core's rows and this table, never from what the customer or the model say.
//
//   FEE-ORIG       3 % of the principal + VAT, once at disbursement (`T-1.6`); a second one is `DUPLICATED`
//   FEE-PUNIT      late interest (`T-3.2`), none within the 2-day tolerance (`T-3.4`) → `WITHIN_TOLERANCE`
//   FEE-CARD-REPL  $ 2.500 only if the customer asked for the card (`T-4.6`) → else `NOT_REQUESTED`
//   FEE-EARLY      2 % of the principal cancelled early, only before 25 % of the term (`T-6.2`)
//   FEE-INS        never charged to the customer (`T-1.5`) → `NOT_CHARGEABLE`
//
// A charge already reversed (`REV#<chargeId>` taken) keeps its verdict and carries its `reversal`, so
// nobody reverses it or asks to again.
import type { ChargeCheck, ChargeCheckReason, ChargeVerdict } from "@reclamo/core-contract";
import type { ChargeItem, InstalmentItem, LoanItem, PaymentItem } from "../store/items";
import type { CustomerBundle } from "./bundle";
import { loadCharge } from "./bundle";
import { type LedgerContext, centsOf, compareText, daysBetween, instantMs, localDate } from "./context";
import { lateInterestFor } from "./payments";

export const FEE_SCHEDULE_VERSION = "v001";
export const VAT_RATE = 0.21;
export const ORIGINATION_RATE = 0.03;
export const CARD_REPLACEMENT_FEE = 250_000;
export const EARLY_PAYOFF_RATE = 0.02;
/** `T-6.2`: the early-payoff fee applies only while less than this share of the term has elapsed. */
export const EARLY_PAYOFF_TERM_SHARE = 0.25;
/** Rounding slack between the charged and the expected amount (one peso). */
export const AMOUNT_TOLERANCE = 100;

export const FEE_CLAUSES: Readonly<Record<string, readonly string[]>> = {
  "FEE-ORIG": ["T-1.6"],
  "FEE-PUNIT": ["T-3.2", "T-3.4"],
  "FEE-CARD-REPL": ["T-4.6"],
  "FEE-EARLY": ["T-6.2"],
  "FEE-INS": ["T-1.5"],
};

export interface ChargeFacts {
  readonly charge: ChargeItem;
  readonly loan?: LoanItem;
  readonly instalment?: InstalmentItem;
  /** Payments of the charge's loan (the date the late instalment was paid). */
  readonly payments: readonly PaymentItem[];
  /** Other charges of the same customer (a second origination fee). */
  readonly otherCharges: readonly ChargeItem[];
}

export interface ChargeVerdictDetail {
  readonly verdict: ChargeVerdict;
  readonly expectedAmount: number;
  readonly reason: ChargeCheckReason;
}

/** Correct when the charged amount matches the expected one within a peso; wrong when it is above it. */
function compare(charged: number, expected: number): ChargeVerdictDetail {
  if (Math.abs(charged - expected) <= AMOUNT_TOLERANCE) return { verdict: "CORRECT", expectedAmount: expected, reason: "MATCHES_SCHEDULE" };
  if (charged > expected) return { verdict: "WRONG", expectedAmount: expected, reason: "AMOUNT_DIFFERS" };
  return { verdict: "UNDETERMINED", expectedAmount: expected, reason: "AMOUNT_DIFFERS" };
}

const undetermined: ChargeVerdictDetail = { verdict: "UNDETERMINED", expectedAmount: 0, reason: "NO_RULE" };

/** Origination fee of a principal: 3 % plus 21 % VAT. */
export function originationFee(principal: number): number {
  return centsOf(principal * ORIGINATION_RATE * (1 + VAT_RATE));
}

/** The day the instalment was settled (last payment applied to it), else the charge's own date. */
function settledDate(facts: ChargeFacts, instalment: InstalmentItem): string {
  const paidDates = facts.payments
    .filter((payment) => payment.allocations.some((allocation) => allocation.instalment === instalment.number))
    .map((payment) => payment.paidAtSim)
    .sort((a, b) => instantMs(a) - instantMs(b));
  const last = paidDates[paidDates.length - 1];
  return localDate(last ?? facts.charge.chargedAtSim);
}

function checkLateInterest(facts: ChargeFacts): ChargeVerdictDetail {
  const { loan, instalment } = facts;
  if (loan === undefined || instalment === undefined) return undetermined;
  const daysLate = daysBetween(instalment.dueDate, settledDate(facts, instalment));
  const expected = lateInterestFor(instalment.amount, loan.annualRate, daysLate);
  if (expected === 0) return { verdict: "WRONG", expectedAmount: 0, reason: "WITHIN_TOLERANCE" };
  return compare(facts.charge.amount, expected);
}

function checkOrigination(facts: ChargeFacts): ChargeVerdictDetail {
  const { charge, loan } = facts;
  if (loan === undefined) return undetermined;
  const earlier = facts.otherCharges.some(
    (other) =>
      other.feeCode === "FEE-ORIG" &&
      other.loanId === charge.loanId &&
      (instantMs(other.chargedAtSim) < instantMs(charge.chargedAtSim) ||
        (instantMs(other.chargedAtSim) === instantMs(charge.chargedAtSim) && compareText(other.chargeId, charge.chargeId) < 0)),
  );
  if (earlier) return { verdict: "WRONG", expectedAmount: 0, reason: "DUPLICATED" };
  return compare(charge.amount, originationFee(loan.principal));
}

function checkEarlyPayoff(facts: ChargeFacts): ChargeVerdictDetail {
  const { charge, loan } = facts;
  if (loan === undefined || charge.basisAmount === undefined || loan.disbursedAtSim === undefined) return undetermined;
  const elapsedMonths = daysBetween(localDate(loan.disbursedAtSim), localDate(charge.chargedAtSim)) / 30;
  if (elapsedMonths >= loan.instalmentsCount * EARLY_PAYOFF_TERM_SHARE) return { verdict: "WRONG", expectedAmount: 0, reason: "NOT_CHARGEABLE" };
  return compare(charge.amount, centsOf(charge.basisAmount * EARLY_PAYOFF_RATE));
}

/** Pure: the verdict of a charge given the facts the core holds. */
export function evaluateCharge(facts: ChargeFacts): ChargeVerdictDetail {
  switch (facts.charge.feeCode) {
    case "FEE-ORIG":
      return checkOrigination(facts);
    case "FEE-PUNIT":
      return checkLateInterest(facts);
    case "FEE-CARD-REPL":
      return facts.charge.requested === true ? compare(facts.charge.amount, CARD_REPLACEMENT_FEE) : { verdict: "WRONG", expectedAmount: 0, reason: "NOT_REQUESTED" };
    case "FEE-EARLY":
      return checkEarlyPayoff(facts);
    case "FEE-INS":
      return { verdict: "WRONG", expectedAmount: 0, reason: "NOT_CHARGEABLE" };
    default:
      return undetermined;
  }
}

export function chargeFacts(bundle: CustomerBundle, charge: ChargeItem): ChargeFacts {
  const state = charge.loanId === undefined ? undefined : bundle.loans.get(charge.loanId);
  const instalment = charge.instalment === undefined ? undefined : state?.instalments.find((candidate) => candidate.value.number === charge.instalment)?.value;
  return {
    charge,
    ...(state === undefined ? {} : { loan: state.loan.value }),
    ...(instalment === undefined ? {} : { instalment }),
    payments: state?.payments.map((payment) => payment.value) ?? [],
    otherCharges: [...bundle.charges.values()].map((stored) => stored.value).filter((other) => other.chargeId !== charge.chargeId),
  };
}

export function toChargeCheck(charge: ChargeItem, detail: ChargeVerdictDetail): ChargeCheck {
  return {
    chargeId: charge.chargeId,
    customerId: charge.customerId,
    ...(charge.loanId === undefined ? {} : { loanId: charge.loanId }),
    feeCode: charge.feeCode,
    charged: charge.amount,
    chargedAtSim: charge.chargedAtSim,
    verdict: detail.verdict,
    expectedAmount: detail.expectedAmount,
    clauseIds: [...(FEE_CLAUSES[charge.feeCode] ?? [])],
    reason: detail.reason,
    scheduleVersion: charge.scheduleVersion,
    ...(charge.reversal === undefined ? {} : { reversal: { actionId: charge.reversal.actionId, complaintId: charge.reversal.complaintId, creditNoteId: charge.reversal.creditNoteId, amount: charge.reversal.amount, compensatoryInterest: charge.reversal.compensatoryInterest, creditedAtSim: charge.reversal.creditedAtSim } }),
  };
}

export async function checkCharge(ctx: LedgerContext, chargeId: string): Promise<ChargeCheck> {
  const { bundle, charge } = await loadCharge(ctx, chargeId);
  return toChargeCheck(charge.value, evaluateCharge(chargeFacts(bundle, charge.value)));
}
