// Calendar dates and instants, independent of any time zone. Instants are ISO 8601 strings with
// zone; calendar dates are `YYYY-MM-DD`. The regulatory deadline (10 business days with the
// Argentine holidays of `Reference`) builds on these in packages/bff/src/services/business-days.ts.
import { z } from "zod";
import { Weekday } from "./enums";

export const CalendarDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "expected YYYY-MM-DD");
export type CalendarDate = z.infer<typeof CalendarDate>;

export const IsoInstant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "expected an ISO 8601 instant");
export type IsoInstant = z.infer<typeof IsoInstant>;

const WEEKDAYS: readonly Weekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, "0");
}

// Public date format: dd/mm/yyyy.
export function formatDate(date: CalendarDate): string {
  const [year, month, day] = CalendarDate.parse(date).split("-");
  return `${day}/${month}/${year}`;
}

export function weekdayOf(date: CalendarDate): Weekday {
  const [year, month, day] = CalendarDate.parse(date).split("-").map(Number);
  const index = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return WEEKDAYS[index] ?? "SUN";
}

export function isWeekend(date: CalendarDate): boolean {
  const weekday = weekdayOf(date);
  return weekday === "SAT" || weekday === "SUN";
}

export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const [year, month, day] = CalendarDate.parse(date).split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Monday to Friday that is not a holiday of the given calendar.
export function isBusinessDay(date: CalendarDate, holidays: Iterable<string>): boolean {
  if (isWeekend(date)) return false;
  for (const holiday of holidays) if (holiday === date) return false;
  return true;
}

// Counts `days` business days strictly after `date` (the start day never counts). With 0 it
// returns `date` itself, whatever it is; use `nextBusinessDay` to land on a business day.
export function addBusinessDays(date: CalendarDate, days: number, holidays: Iterable<string>): CalendarDate {
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`days must be a non-negative integer, got ${days}`);
  const holidaySet = new Set(holidays);
  let current = CalendarDate.parse(date);
  let remaining = days;
  while (remaining > 0) {
    current = addCalendarDays(current, 1);
    if (isBusinessDay(current, holidaySet)) remaining -= 1;
  }
  return current;
}

// The same date when it is a business day, otherwise the first business day after it (moves a
// deadline that falls on a weekend or holiday).
export function nextBusinessDay(date: CalendarDate, holidays: Iterable<string>): CalendarDate {
  const holidaySet = new Set(holidays);
  let current = CalendarDate.parse(date);
  while (!isBusinessDay(current, holidaySet)) current = addCalendarDays(current, 1);
  return current;
}

// Business days in (from, to], i.e. how many business days elapsed since `from`.
export function businessDaysBetween(from: CalendarDate, to: CalendarDate, holidays: Iterable<string>): number {
  if (compareDates(from, to) > 0) return -businessDaysBetween(to, from, holidays);
  const holidaySet = new Set(holidays);
  let count = 0;
  let current = CalendarDate.parse(from);
  const end = CalendarDate.parse(to);
  while (compareDates(current, end) < 0) {
    current = addCalendarDays(current, 1);
    if (isBusinessDay(current, holidaySet)) count += 1;
  }
  return count;
}

// ISO week key (Monday to Sunday); returns the Monday.
export function weekStart(date: CalendarDate): CalendarDate {
  const offset = (WEEKDAYS.indexOf(weekdayOf(date)) + 6) % 7;
  return addCalendarDays(date, -offset);
}

// Argentina has kept UTC-3 all year since 2009: the simulated clock is shown in that fixed offset.
const ARGENTINA_OFFSET_MINUTES = -180;
const SHORT_WEEKDAYS_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/** An instant as the console's simulated-time bar shows it: "mié 07/10 10:15" (Argentina time). */
export function formatSimInstant(instant: IsoInstant): string {
  const ms = Date.parse(IsoInstant.parse(instant)) + ARGENTINA_OFFSET_MINUTES * 60_000;
  const local = new Date(ms);
  const weekday = SHORT_WEEKDAYS_ES[local.getUTCDay()] ?? "dom";
  return `${weekday} ${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}
