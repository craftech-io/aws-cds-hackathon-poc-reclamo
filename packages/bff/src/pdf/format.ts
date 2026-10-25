// Values as the documents print them, without `Intl` (the bytes must not depend on the runtime's
// ICU data): instants in Argentina time (UTC−03:00 all year), calendar dates as dd/mm/aaaa, pesos
// with formatPesos and rates as an es-AR percentage. Every instant is simulated time of the world:
// the caller passes it in, nothing here reads a clock.
import { type CalendarDate, IsoInstant, formatDate } from "@reclamo/shared";
import { localDateAr } from "../services/business-days";

const AR_OFFSET_MS = -3 * 60 * 60 * 1000;

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** "07/10/2026" (Argentina date of an instant). */
export function dateAr(instant: IsoInstant): string {
  return formatDate(localDateAr(new Date(IsoInstant.parse(instant))));
}

/** "07/10/2026 10:15" (Argentina date and time of an instant). Always 16 characters. */
export function dateTimeAr(instant: IsoInstant): string {
  const local = new Date(Date.parse(IsoInstant.parse(instant)) + AR_OFFSET_MS);
  return `${dateAr(instant)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** "25/09/2026" for a calendar date. */
export function calendarDate(date: CalendarDate): string {
  return formatDate(date);
}

/** "95,00 %" for an annual rate of 0.95; two decimals, rounded half up on basis points. */
export function percent(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) throw new RangeError(`rate must be a non-negative number, got ${rate}`);
  const basisPoints = Math.round(rate * 10_000);
  const whole = Math.floor(basisPoints / 100);
  return `${whole},${pad(basisPoints % 100)} %`;
}
