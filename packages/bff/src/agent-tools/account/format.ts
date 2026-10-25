// How the identity, account and investigation tools hand amounts and dates to the model
// (docs/tool-catalog.md "Montos y fechas"): every amount as `{amount, text}` in pesos and every date as
// its es-AR text in the world's time zone ("jueves 22/10", "jueves 22/10 08:30"). The model copies
// these; it never formats a number or a date itself, so the deterministic verifier finds them verbatim
// in the turn's results.
import type { AppliedChargeReversal } from "@reclamo/core-contract";
import { type CalendarDate, type Money, pesosFromCents } from "@reclamo/shared";
import { deadlineText } from "../../complaints/sla";
import { localDateAr } from "../../services/business-days";

const AR_OFFSET_MS = -3 * 60 * 60 * 1000;

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Integer centavos as the tools return them. */
export function money(cents: number): Money {
  return pesosFromCents(cents);
}

/** "jueves 22/10" (the day of an instant in Argentina). */
export function dayText(instant: string): string {
  return deadlineText(instant);
}

/** "jueves 22/10 08:30" (day and local time of an instant in Argentina). */
export function dayTimeText(instant: string): string {
  const local = new Date(Date.parse(instant) + AR_OFFSET_MS);
  return `${deadlineText(instant)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** "lunes 05/10" for a calendar date (a due date). */
export function dateText(date: CalendarDate): string {
  return deadlineText(`${date}T12:00:00-03:00`);
}

/** The Argentine calendar date of an instant (`2026-10-07`). */
export function localDate(instant: string): CalendarDate {
  return localDateAr(new Date(instant));
}

/** `date` moved by `days` calendar days. */
export function shiftDate(date: CalendarDate, days: number): CalendarDate {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** A charge the core already reversed: what went back to the customer and when (nothing to reverse again). */
export function alreadyReversedView(reversal: AppliedChargeReversal) {
  return {
    creditNoteId: reversal.creditNoteId,
    reversed: money(reversal.amount),
    compensatoryInterest: money(reversal.compensatoryInterest),
    reversedAtText: dayTimeText(reversal.creditedAtSim),
  };
}
