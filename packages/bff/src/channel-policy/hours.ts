// `CH-CONTACT-HOURS` (docs/design-brief.md §7, an assumption the console labels as such): a proactive
// contact goes out Monday to Friday 08:00-20:00 and Saturday 09:00-13:00 in Buenos Aires, never on a
// Sunday or a national holiday of `Reference/HOLIDAY#AR`; the formal debt notice only Monday to
// Friday 09:00-18:00. The ranges are the world's `SETTINGS.contactHours`; a range includes its start
// and excludes its end (20:00 is already out). A reply to the customer's own message and the emails
// the regulation demands are exempt (kinds.ts). Out of hours is a deferral, not a block: the send
// waits for `nextAllowedAt`, the next opening. Always on the world's simulated clock.
import { type CalendarDate, addCalendarDays, isBusinessDay, weekdayOf } from "@reclamo/shared";
import { localDateAr } from "../services/business-days";
import type { TimeRange } from "../domain/world";
import { atLocalAr, defer, localTimeAr, missing, pass, skip, wallClockAr } from "./checks";
import type { PolicyContext } from "./context";
import { EXEMPT_EMAIL_KINDS, FORMAL_NOTICE } from "./kinds";
import type { RuleCheck } from "./types";

/** The opening range of a local date, or `null` when nothing goes out that day. */
export type DaySchedule = (date: CalendarDate) => TimeRange | null;

/** A week of contact hours: weekdays, Saturdays (or none), never Sundays nor holidays. */
export function contactSchedule(hours: PolicyContext["settings"]["contactHours"], holidays: readonly CalendarDate[]): DaySchedule {
  return (date) => {
    if (holidays.includes(date)) return null;
    const weekday = weekdayOf(date);
    if (weekday === "SUN") return null;
    if (weekday === "SAT") return hours.saturday;
    return hours.weekday;
  };
}

/** The formal debt notice: business days only (Monday to Friday, no holidays). */
export function formalNoticeSchedule(hours: PolicyContext["settings"]["contactHours"], holidays: readonly CalendarDate[]): DaySchedule {
  return (date) => (isBusinessDay(date, holidays) ? hours.formalNotice : null);
}

/** A year of weekends and holidays; past it the inputs are broken, not busy. */
const MAX_DAYS = 370;

/** `at` itself when it is inside the schedule, otherwise the next opening after it. */
export function nextOpening(at: Date, schedule: DaySchedule): Date {
  const today = localDateAr(at);
  const time = localTimeAr(at);
  for (let offset = 0; offset < MAX_DAYS; offset += 1) {
    const date = addCalendarDays(today, offset);
    const range = schedule(date);
    if (range === null || range.from >= range.to) continue;
    if (offset > 0 || time < range.from) return atLocalAr(date, range.from);
    if (time < range.to) return at;
  }
  throw new RangeError(`no opening within ${MAX_DAYS} days`);
}

/** Whether the send is a proactive contact; `undefined` when it cannot be told without the history. */
export function proactiveOf(ctx: PolicyContext): boolean | undefined {
  if (!ctx.byWhatsApp) return !EXEMPT_EMAIL_KINDS.has(ctx.request.kind);
  return ctx.reply === undefined ? undefined : !ctx.reply;
}

/** `CH-CONTACT-HOURS` at `at`. */
export function checkContactHours(ctx: PolicyContext, at: Date): RuleCheck {
  const proactive = proactiveOf(ctx);
  if (proactive === undefined) return missing(ctx.mode, "the customer's message history");
  if (!proactive) return skip(ctx.byWhatsApp ? "a reply to the customer's own message is exempt from the contact hours" : `${ctx.request.kind} is not a proactive contact`);
  const formal = ctx.request.kind === FORMAL_NOTICE;
  const { contactHours, holidays } = ctx.settings;
  const schedule = formal ? formalNoticeSchedule(contactHours, holidays) : contactSchedule(contactHours, holidays);
  const next = nextOpening(at, schedule);
  const which = formal ? "the formal debt notice hours (Mon-Fri)" : "the contact hours";
  if (next.getTime() === at.getTime()) return pass(`${wallClockAr(at)} is inside ${which}`);
  return defer(`${wallClockAr(at)} is outside ${which}: deferred to ${wallClockAr(next)}`, next);
}
