// Plan of the historical register (docs/seed-spec.md §10, §13): how many presentations of each type,
// who filed them and when, how each one ended. `demo`/`guest` hold 122 presentations of 2026 (the
// first new one is R-2026-000123): 115 closed, 4 answered whose automatic closing comes after the
// guided tour's first event, and 3 still with a person (filed 06/10 15:20, 07/10 08:40 and 07/10
// 09:30). `qa-min` holds 20, all closed.
import type { ComplaintOutcome, ComplaintType, HandoffReason } from "@reclamo/shared";
import { HISTORY_FROM } from "../lib/constants";
import { addMinutes, businessDaysAfter, isBusiness, localInstant } from "./calendar";
import type { Rng } from "./rng";

/** Distribution of presentations by type (an assumption, docs/seed-spec.md §13). */
export const TYPE_DISTRIBUTION: ReadonlyArray<readonly [ComplaintType, number]> = [
  ["PAYMENT_NOT_REFLECTED", 0.32],
  ["UNRECOGNIZED_CHARGE", 0.14],
  ["TRANSFER_NOT_CREDITED", 0.12],
  ["PAYOFF_CERTIFICATE", 0.1],
  ["DUPLICATE_DEBIT", 0.07],
  ["DISBURSEMENT_NOT_RECEIVED", 0.06],
  ["UNKNOWN_OPERATION", 0.05],
  ["ACCOUNT_BLOCKED", 0.04],
  ["CLOSURE_OR_EARLY_PAYOFF", 0.04],
  ["DATA_CHANGE", 0.04],
  ["INFORMATION_REQUEST", 0.02],
];

/** Largest-remainder apportionment of `total` by TYPE_DISTRIBUTION (ties by list order). */
export function apportion(total: number): Map<ComplaintType, number> {
  const raw = TYPE_DISTRIBUTION.map(([type, share], index) => ({ type, index, exact: total * share, count: Math.floor(total * share) }));
  let left = total - raw.reduce((sum, row) => sum + row.count, 0);
  const byRemainder = [...raw].sort((a, b) => b.exact - b.count - (a.exact - a.count) || a.index - b.index);
  for (const row of byRemainder) {
    if (left === 0) break;
    row.count += 1;
    left -= 1;
  }
  return new Map(raw.map((row) => [row.type, row.count]));
}

export type PlanState = "CLOSED" | "ANSWERED" | "HUMAN_REVIEW";

export interface PlannedComplaint {
  readonly customerId: string;
  readonly type: ComplaintType;
  readonly filedAt: string;
  readonly state: PlanState;
  readonly outcome?: ComplaintOutcome;
  /** Business days from filing to the resolution (closed and answered). */
  readonly resolveAfter: number;
  readonly resolveTime: string;
  /** Goes through a person before the resolution (or stays with one, when open). */
  readonly handoff?: HandoffReason;
}

export interface OpenComplaint {
  readonly customerId: string;
  readonly type: ComplaintType;
  readonly filedAt: string;
  readonly handoff: HandoffReason;
}

const OUTCOMES: Readonly<Record<ComplaintType, readonly ComplaintOutcome[]>> = {
  PAYMENT_NOT_REFLECTED: ["IN_FAVOUR", "IN_FAVOUR", "IN_FAVOUR", "NOT_IN_FAVOUR"],
  PAYOFF_CERTIFICATE: ["INFORMATIONAL"],
  UNRECOGNIZED_CHARGE: ["IN_FAVOUR", "IN_FAVOUR", "NOT_IN_FAVOUR"],
  DUPLICATE_DEBIT: ["IN_FAVOUR", "NOT_IN_FAVOUR"],
  TRANSFER_NOT_CREDITED: ["INFORMATIONAL", "INFORMATIONAL", "IN_FAVOUR"],
  DISBURSEMENT_NOT_RECEIVED: ["INFORMATIONAL"],
  UNKNOWN_OPERATION: ["PARTIALLY_IN_FAVOUR", "NOT_IN_FAVOUR"],
  ACCOUNT_BLOCKED: ["INFORMATIONAL"],
  CLOSURE_OR_EARLY_PAYOFF: ["INFORMATIONAL"],
  DATA_CHANGE: ["IN_FAVOUR"],
  INFORMATION_REQUEST: ["INFORMATIONAL"],
};

const ALWAYS_HUMAN: Partial<Record<ComplaintType, HandoffReason>> = { UNKNOWN_OPERATION: "FRAUD", ACCOUNT_BLOCKED: "IDENTITY_VERIFICATION" };

function businessDaysBetweenDates(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    if (isBusiness(cursor)) out.push(cursor);
    cursor = businessDaysAfter(cursor, 1);
  }
  return out;
}

function time(rng: Rng, fromHour: number, toHour: number): string {
  const minutes = rng.int(fromHour * 60, toHour * 60 - 1);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export interface PlanInput {
  readonly total: number;
  readonly open: readonly OpenComplaint[];
  readonly answered: number;
  readonly customers: readonly string[];
  readonly rng: Rng;
}

/**
 * The presentations of a template, oldest first (numbers are given in this order). Closed ones are
 * filed until 18/09 so their automatic closing (5 business days after the answer) is before the
 * start; answered ones are filed from 29/09 and answered from 01/10 at 09:00 or later, so their
 * `AUTO_CLOSE` lands after the first event of the tour (08/10 08:30).
 */
export function planHistory(input: PlanInput): PlannedComplaint[] {
  const { rng } = input;
  const counts = apportion(input.total);
  for (const open of input.open) counts.set(open.type, (counts.get(open.type) ?? 0) - 1);
  const types = rng.shuffle([...counts].flatMap(([type, count]) => Array.from({ length: Math.max(count, 0) }, () => type)));
  const closedDays = businessDaysBetweenDates(HISTORY_FROM, "2026-09-18");
  const answeredDays = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
  const planned = types.map((type, index): PlannedComplaint => {
    const answered = index < input.answered;
    const date = answered ? (answeredDays[index % answeredDays.length] ?? "2026-09-29") : rng.pick(closedDays);
    const handoff = ALWAYS_HUMAN[type] ?? (rng.next() < 0.1 ? "LOW_CONFIDENCE" : undefined);
    return {
      customerId: rng.pick(input.customers),
      type,
      filedAt: localInstant(date, time(rng, 9, 19)),
      state: answered ? "ANSWERED" : "CLOSED",
      outcome: rng.pick(OUTCOMES[type]),
      resolveAfter: answered ? 2 : rng.int(1, 6),
      resolveTime: time(rng, 10, 17),
      ...(handoff ? { handoff } : {}),
    };
  });
  const open = input.open.map((complaint): PlannedComplaint => ({ ...complaint, state: "HUMAN_REVIEW", resolveAfter: 0, resolveTime: "00:00" }));
  return [...planned, ...open].sort((a, b) => Date.parse(a.filedAt) - Date.parse(b.filedAt) || (a.customerId < b.customerId ? -1 : 1));
}

/** Resolution instant of a planned complaint (always after its filing). */
export function resolutionInstant(plan: PlannedComplaint): string {
  const date = businessDaysAfter(plan.filedAt.slice(0, 10), plan.resolveAfter);
  const candidate = localInstant(date, plan.resolveTime);
  return Date.parse(candidate) > Date.parse(addMinutes(plan.filedAt, 60)) ? candidate : addMinutes(plan.filedAt, 90);
}
