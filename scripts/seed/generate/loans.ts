// Loan schedules of the seed (docs/seed-spec.md §6, product terms T-1.x): French system with a fixed
// instalment that includes the interest and its VAT (21 %). A loan is defined by principal, number of
// instalments (3 to 18) and instalment amount; the nominal annual rate (TNA) is derived by bisection
// to 8 decimals and the breakdown is computed to the centavo, the last instalment absorbing the
// rounding so the principal parts add up to the principal exactly.
import { addMonths } from "./calendar";

export const VAT_RATE = 0.21;

export interface ScheduleRow {
  readonly number: number;
  readonly dueDate: string;
  readonly principal: number;
  readonly interest: number;
  readonly vat: number;
  readonly amount: number;
}

/** Fixed instalment of `principal` at monthly rate `j` (interest + VAT) over `count` months. */
function annuity(principal: number, j: number, count: number): number {
  return (principal * j) / (1 - (1 + j) ** -count);
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** TNA (interest only, without VAT) that makes the fixed instalment equal `instalment` (all in centavos). */
export function solveAnnualRate(principal: number, count: number, instalment: number): number {
  if (count < 3 || count > 18) throw new RangeError(`a loan has 3 to 18 instalments, got ${count}`);
  if (instalment * count <= principal) throw new RangeError("instalments must exceed the principal");
  let low = 1e-9;
  let high = 1;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    if (annuity(principal, mid, count) > instalment) high = mid;
    else low = mid;
  }
  const monthlyWithVat = (low + high) / 2;
  return round8((monthlyWithVat / (1 + VAT_RATE)) * 12);
}

/** Instalment (centavos, rounded to whole pesos) of a loan at `annualRate`. */
export function instalmentForRate(principal: number, count: number, annualRate: number): number {
  const j = (annualRate / 12) * (1 + VAT_RATE);
  return Math.ceil(annuity(principal, j, count) / 100) * 100;
}

/** The schedule of a loan whose instalment `k` is due `k` months after `disbursedDate`. */
export function schedule(principal: number, count: number, instalment: number, annualRate: number, firstDue: string): ScheduleRow[] {
  const monthly = annualRate / 12;
  const dueDay = Number(firstDue.slice(8, 10));
  const rows: ScheduleRow[] = [];
  let balance = principal;
  for (let number = 1; number <= count; number += 1) {
    const interest = Math.round(balance * monthly);
    const vat = Math.round(interest * VAT_RATE);
    const principalPart = number === count ? balance : instalment - interest - vat;
    if (principalPart <= 0) throw new RangeError("instalment does not cover the interest");
    balance -= principalPart;
    rows.push({ number, dueDate: addMonths(firstDue, number - 1, dueDay), principal: principalPart, interest, vat, amount: principalPart + interest + vat });
  }
  if (balance !== 0) throw new Error("schedule does not amortize the principal");
  return rows;
}

/** Late-payment interest (T-3.2): 50 % of the compensatory rate, daily, on the overdue amount. */
export function lateInterest(overdueAmount: number, annualRate: number, days: number): number {
  return days <= 0 ? 0 : Math.round(((overdueAmount * annualRate * 0.5) / 365) * days);
}

/** Origination fee (FEE-ORIG, T-1.6): 3 % of the principal plus VAT, each rounded to the centavo. */
export function originationFee(principal: number): number {
  const fee = Math.round(principal * 0.03);
  return fee + Math.round(fee * VAT_RATE);
}

/** Tolerance of T-3.4: no late interest when paid within 2 calendar days of the due date. */
export const LATE_TOLERANCE_DAYS = 2;
