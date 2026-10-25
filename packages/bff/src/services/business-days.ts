// Business days of Argentina for the regulatory clock (docs/architecture.md §8.4): the written
// answer is due by 23:59:59 of the 10th business day after the complaint is filed; the filing day
// never counts. Holidays come from `Reference` (docs/seed-spec.md), passed in by the caller, so
// every function is pure and never reads the machine clock. Argentina has no DST: local time is
// always UTC−03:00.
import { type CalendarDate, addBusinessDays } from "@reclamo/shared";

export const AR_UTC_OFFSET = "-03:00";
const OFFSET_MS = -3 * 60 * 60 * 1000;

/** Business days the lender has to answer in writing. */
export const ANSWER_BUSINESS_DAYS = 10;

/** Calendar date in Argentina of an instant. */
export function localDateAr(instant: Date): CalendarDate {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant of a local Argentine date and time (`HH:MM:SS`). */
export function instantAr(date: CalendarDate, time: string): Date {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(time)) throw new RangeError(`time must be HH:MM:SS, got ${time}`);
  return new Date(`${date}T${time}${AR_UTC_OFFSET}`);
}

/** The n-th business day after the local date of `from`, at local `time`. */
export function nthBusinessDay(from: Date, n: number, time: string, holidays: Iterable<string>): Date {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
  return instantAr(addBusinessDays(localDateAr(from), n, holidays), time);
}

/** 23:59:59 of the 10th business day after filing. */
export function deadline(filedAtSim: Date, holidays: Iterable<string>): Date {
  return nthBusinessDay(filedAtSim, ANSWER_BUSINESS_DAYS, "23:59:59", holidays);
}

/** Business day and local time of each SLA milestone (docs/architecture.md §8.4). */
export const MILESTONE_SCHEDULE = {
  OPERATOR_REMINDER: { businessDay: 5, time: "10:00:00" },
  SUPERVISOR_ESCALATION: { businessDay: 8, time: "10:00:00" },
  DEADLINE: { businessDay: ANSWER_BUSINESS_DAYS, time: "23:59:59" },
} as const;

export type Milestone = keyof typeof MILESTONE_SCHEDULE;

export function milestones(filedAtSim: Date, holidays: Iterable<string>): Record<Milestone, Date> {
  const at = (milestone: Milestone): Date => {
    const { businessDay, time } = MILESTONE_SCHEDULE[milestone];
    return nthBusinessDay(filedAtSim, businessDay, time, holidays);
  };
  return { OPERATOR_REMINDER: at("OPERATOR_REMINDER"), SUPERVISOR_ESCALATION: at("SUPERVISOR_ESCALATION"), DEADLINE: at("DEADLINE") };
}
