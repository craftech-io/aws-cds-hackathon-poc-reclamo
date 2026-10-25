// Business dates of the collection networks (docs/architecture-integrations.md §6.1), pure: a payment
// made on a business day before the network's cut-off belongs to that day; after the cut-off, or on
// a weekend or holiday, to the next business day. The batch of a business date is published
// `businessDays` business days later at the network's publication time. Everything is evaluated in
// Argentina time (UTC-3 all year since 2009) on the instants the caller sends, never on a clock.
import { addBusinessDays, isBusinessDay, nextBusinessDay } from "@reclamo/shared";
import type { SettlementDelay } from "./store/items";

/** Argentina has kept UTC-3 all year since 2009. */
export const ARGENTINA_OFFSET = "-03:00";
const OFFSET_MS = -3 * 3_600_000;

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, "0");
}

export interface LocalMoment {
  /** `YYYY-MM-DD` in Argentina time. */
  readonly date: string;
  /** `HH:MM` in Argentina time. */
  readonly time: string;
}

/** Calendar date and wall-clock time of an instant in Argentina. */
export function argentinaMoment(instant: string): LocalMoment {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError("invalid instant");
  const local = new Date(ms + OFFSET_MS);
  return {
    date: `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
  };
}

/** `2026-10-08T08:30:00-03:00` for a date and an Argentina wall-clock time. */
export function argentinaInstant(date: string, time: string): string {
  return `${date}T${time}:00${ARGENTINA_OFFSET}`;
}

/** Business date of a payment made at `paidAt`; a payment at the cut-off itself is already after it. */
export function businessDateOf(paidAt: string, delay: SettlementDelay, holidays: readonly string[]): string {
  const { date, time } = argentinaMoment(paidAt);
  if (!isBusinessDay(date, holidays)) return nextBusinessDay(date, holidays);
  return time >= delay.cutoff ? addBusinessDays(date, 1, holidays) : date;
}

/** Instant the batch of `businessDate` is published. */
export function publishAtOf(businessDate: string, delay: SettlementDelay, holidays: readonly string[]): string {
  return argentinaInstant(addBusinessDays(businessDate, delay.businessDays, holidays), delay.publishAt);
}

/** `instant` plus `minutes`, written back in Argentina time. */
export function addMinutes(instant: string, minutes: number): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError("invalid instant");
  const moment = argentinaMoment(new Date(ms + minutes * 60_000).toISOString());
  return argentinaInstant(moment.date, moment.time);
}

/** True when `a` is strictly before `b` (instants with any offset). */
export function isBefore(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}
