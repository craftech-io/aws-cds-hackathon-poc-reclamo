// Simulated time of the seed: local Argentine instants (UTC−03:00 all year), month arithmetic for due
// dates, and the collection networks' calendar (docs/seed-spec.md §7): cut-off, business date of a
// payment and publication instant of a batch. Pure functions over the holiday table; no clock.
import { addBusinessDays, addCalendarDays, isBusinessDay, nextBusinessDay } from "@reclamo/shared";
import { HOLIDAY_DATES } from "./holidays";

export type CollectionNetwork = "NORTE" | "SUR";

/** `2026-10-06T18:40:00-03:00`. */
export function localInstant(date: string, time: string): string {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new RangeError(`time must be HH:MM, got ${time}`);
  return `${date}T${time}:00-03:00`;
}

/** Local date and time of a seed instant written by `localInstant`. */
export function splitLocal(instant: string): { date: string; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}-03:00$/.exec(instant);
  if (!match?.[1] || !match[2]) throw new RangeError(`not a local seed instant: ${instant}`);
  return { date: match[1], time: match[2] };
}

/** Minutes after `instant` (local), crossing midnight correctly. */
export function addMinutes(instant: string, minutes: number): string {
  const utc = Date.parse(instant) + minutes * 60_000 - 3 * 3_600_000;
  const shifted = new Date(utc);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  return localInstant(date, `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`);
}

export function compareInstants(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/** Same day of the month `months` later, clamped to the month's last day. */
export function addMonths(date: string, months: number, day?: number): string {
  const [year = 0, month = 1, dayOfMonth = 1] = date.split("-").map(Number);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  const last = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const wanted = Math.min(day ?? dayOfMonth, last);
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(wanted).padStart(2, "0")}`;
}

export function isBusiness(date: string): boolean {
  return isBusinessDay(date, HOLIDAY_DATES);
}

export function businessDaysAfter(date: string, days: number): string {
  return addBusinessDays(date, days, HOLIDAY_DATES);
}

export function firstBusinessDayFrom(date: string): string {
  return nextBusinessDay(date, HOLIDAY_DATES);
}

/** The `count` business days before `date` (excluded), oldest first. */
export function businessDaysBefore(date: string, count: number): string[] {
  const out: string[] = [];
  let cursor = addCalendarDays(date, -1);
  while (out.length < count) {
    if (isBusiness(cursor)) out.unshift(cursor);
    cursor = addCalendarDays(cursor, -1);
  }
  return out;
}

export const NETWORK_CALENDAR: Readonly<Record<CollectionNetwork, { cutoff: string; settleAfter: number; publishAt: string }>> = {
  NORTE: { cutoff: "18:00", settleAfter: 1, publishAt: "08:30" },
  SUR: { cutoff: "16:00", settleAfter: 2, publishAt: "11:00" },
};

/** Business date of a payment: its day if it is a business day before the cut-off, else the next business day. */
export function businessDateOf(network: CollectionNetwork, paidAt: string): string {
  const { date, time } = splitLocal(paidAt);
  if (isBusiness(date) && time < NETWORK_CALENDAR[network].cutoff) return date;
  return firstBusinessDayFrom(addCalendarDays(date, 1));
}

/** When the batch of a business date is published (D+1 at 08:30 or D+2 at 11:00). */
export function publishInstant(network: CollectionNetwork, businessDate: string): string {
  const calendar = NETWORK_CALENDAR[network];
  return localInstant(businessDaysAfter(businessDate, calendar.settleAfter), calendar.publishAt);
}

/** A `Date` as a seed local instant (`…-03:00`, seconds kept). */
export function localOf(instant: Date): string {
  const shifted = new Date(instant.getTime() - 3 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}-03:00`;
}

/** UTC ISO of a seed instant (the "real" stamps of the history). */
export function utcOf(instant: string): string {
  return new Date(Date.parse(instant)).toISOString();
}
