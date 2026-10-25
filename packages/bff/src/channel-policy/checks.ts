// The builders of a rule's result, `missing` (the one place that decides what a rule does without a
// fact it needs) and the Argentine wall clock the time rules read. A send decided now fails closed
// (`BLOCK`); a past send re-checked skips what cannot be rebuilt (`SKIP`), because its `ALLOWED`
// tape entry already recorded what was checked when it went out. Argentina has no daylight saving
// time: local time is always UTC−03:00 (services/business-days.ts).
import { type CalendarDate, weekdayOf } from "@reclamo/shared";
import { AR_UTC_OFFSET, instantAr, localDateAr } from "../services/business-days";
import type { CollectionCategory } from "../copy/types";
import type { EvaluationMode, PolicyErrorCode, RuleCheck } from "./types";

/** Rule details travel to the tape and the console: short, never an address, a name or a free text. */
const MAX_DETAIL = 300;

function clip(detail: string): string {
  return detail.length <= MAX_DETAIL ? detail : `${detail.slice(0, MAX_DETAIL - 1)}…`;
}

export function pass(detail: string): RuleCheck {
  return { result: "PASS", detail: clip(detail) };
}

export function block(detail: string, errorCode?: PolicyErrorCode, categories?: readonly CollectionCategory[]): RuleCheck {
  return { result: "BLOCK", detail: clip(detail), ...(errorCode === undefined ? {} : { errorCode }), ...(categories === undefined ? {} : { categories }) };
}

export function skip(detail: string): RuleCheck {
  return { result: "SKIP", detail: clip(detail) };
}

export function defer(detail: string, next: Date): RuleCheck {
  return { result: "DEFER", detail: clip(detail), next };
}

/** A fact the rule needs is absent: fail closed when deciding a send, skip when checking the past. */
export function missing(mode: EvaluationMode, fact: string): RuleCheck {
  return mode === "SEND" ? block(`${fact} is missing: the policy fails closed`) : skip(`${fact} is not rebuilt for a past instant`);
}

const OFFSET_MS = -3 * 3_600_000;

/** `HH:MM` of an instant in Argentina. */
export function localTimeAr(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(11, 16);
}

/** `2026-10-13T08:00:00-03:00`: an instant as Argentina reads it. */
export function toArIso(instant: Date): string {
  return `${new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 19)}${AR_UTC_OFFSET}`;
}

/** "SAT 10/10 18:00": the Argentine wall clock of an instant, for a rule's detail. */
export function wallClockAr(instant: Date): string {
  const date = localDateAr(instant);
  return `${weekdayOf(date)} ${date.slice(8, 10)}/${date.slice(5, 7)} ${localTimeAr(instant)}`;
}

/** The instant of a local Argentine date at `HH:MM`. */
export function atLocalAr(date: CalendarDate, time: string): Date {
  return instantAr(date, `${time}:00`);
}

/**
 * Whether a dated step was in force at the decided instant. A step of an earlier simulated instant
 * always was; one of a later instant never. In a paused world many things share one simulated
 * instant, so a step dated exactly at it counts only when its real instant is not after the
 * decision's. A past send without that real instant gets the benefit of the doubt: the `ALLOWED`
 * entry of the tape proves the gate saw the current state when it decided.
 */
export function inForceAt(step: { readonly atSim: string; readonly atReal?: string | undefined }, simNow: Date, realNow: Date, mode: EvaluationMode): boolean {
  const sim = Date.parse(step.atSim) - simNow.getTime();
  if (sim !== 0) return sim < 0;
  if (step.atReal !== undefined) return Date.parse(step.atReal) <= realNow.getTime();
  return mode === "SEND";
}

/** The last step in force at the instant, among steps sorted by any order. */
export function lastInForce<T extends { readonly atSim: string; readonly atReal?: string | undefined }>(steps: readonly T[], simNow: Date, realNow: Date, mode: EvaluationMode): T | undefined {
  const order = (step: T) => [Date.parse(step.atSim), step.atReal === undefined ? 0 : Date.parse(step.atReal)] as const;
  return steps
    .filter((step) => inForceAt(step, simNow, realNow, mode))
    .sort((a, b) => {
      const [simA, realA] = order(a);
      const [simB, realB] = order(b);
      return simA === simB ? realA - realB : simA - simB;
    })
    .at(-1);
}
