// The demo clock's rules as the console shows them, without React (docs/architecture.md §10, ADR-0011):
// the compression of a live clock (1 to 2,880 simulated seconds per real second; the BFF refuses the
// rest with `INVALID`), its presets, how long a live window has left, why the world is busy and from
// when "Avanzar igual" is accepted, and what each upcoming timer is.
import { MAX_CONSOLE_RATE } from "@reclamo/bff/lib/clock";
import { clockCopy } from "./copy";
import type { ClockAnswer, UpcomingTimer } from "./clock-api";

export const MIN_RATE = 1;
export const MAX_RATE = MAX_CONSOLE_RATE;
/** "Reloj en vivo": one simulated day per real minute (the BFF's default). */
export const LIVE_RATE = 1_440;
/** "Reloj en vivo lento": one simulated day every five real minutes. */
export const SLOW_LIVE_RATE = 288;

const DAY_SECONDS = 86_400;

/** The rate typed in the form, or `undefined` when it is not a whole number in range. */
export function parseRate(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text.trim())) return undefined;
  const rate = Number(text.trim());
  return rate >= MIN_RATE && rate <= MAX_RATE ? rate : undefined;
}

/** "1 día simulado cada 60 s reales": how much real time a simulated day takes at `rate`. */
export function describeRate(rate: number): string {
  const seconds = DAY_SECONDS / rate;
  if (seconds <= 60) return `1 día simulado cada ${Math.round(seconds)} s reales`;
  if (seconds < 3_600) {
    const minutes = Math.round((seconds / 60) * 10) / 10;
    return `1 día simulado cada ${String(minutes).replace(".", ",")} min reales`;
  }
  const hours = Math.round((seconds / 3_600) * 10) / 10;
  return `1 día simulado cada ${String(hours).replace(".", ",")} h reales`;
}

/** Whole real minutes left in a live window (rounded up); 0 when it ends within the minute. */
export function liveMinutesLeft(runningUntilReal: string | undefined, nowMs: number): number | undefined {
  if (runningUntilReal === undefined) return undefined;
  const left = Date.parse(runningUntilReal) - nowMs;
  return left <= 60_000 ? 0 : Math.ceil(left / 60_000);
}

/** "un turno del agente o un evento en cola": what a busy world waits for, never a raw code. */
export function busyText(reason: string, lang: "es" | "en" = "es"): string {
  const { busy } = clockCopy;
  if (lang === "en") return busy.reasonsEn[reason] ?? busy.unknownReasonEn;
  return busy.reasons[reason] ?? busy.unknownReason;
}

/** True once the BFF accepts `force` (the oldest pending item waited 5 real minutes). */
export function forceAllowed(busy: ClockAnswer["busy"], nowMs: number): boolean {
  return busy !== null && Date.parse(busy.forceAllowedAtReal) <= nowMs;
}

const ARGENTINA_OFFSET_MS = -3 * 60 * 60_000;
const pad = (value: number) => String(value).padStart(2, "0");

/** "10:15" (Argentina time) of a real instant, for "podés avanzar igual desde las …". */
export function realClockText(instant: string): string {
  const local = new Date(Date.parse(instant) + ARGENTINA_OFFSET_MS);
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

const MILESTONES = ["OPERATOR_REMINDER", "SUPERVISOR_ESCALATION", "DEADLINE"] as const;

/** What an upcoming timer is, in words: "Hito del plazo: recordatorio al operador (día hábil 5)". */
export function timerLabel(timer: Pick<UpcomingTimer, "kind" | "timerId" | "ownerKey">): string {
  const { kinds, milestones, networks } = clockCopy.upcoming;
  const kind = kinds[timer.kind] ?? timer.kind;
  if (timer.kind === "SLA") {
    const milestone = MILESTONES.find((name) => timer.timerId.endsWith(name));
    return milestone === undefined ? kind : `${kind}: ${milestones[milestone] ?? milestone}`;
  }
  if (timer.kind === "SETTLEMENT_PUBLISH" || timer.kind === "SETTLEMENT_RECHECK") {
    const network = /^BATCH#([A-Z]+)#/.exec(timer.ownerKey ?? "")?.[1];
    const name = network === undefined ? undefined : networks[network];
    return name === undefined ? kind : `${kind} (${name})`;
  }
  return kind;
}
