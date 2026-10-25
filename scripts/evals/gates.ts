// The verdict vocabulary of the evaluations: a gate is one threshold of docs/seed-spec.md §12 measured
// over N observations. Pure.
//
//   PASS     measured and within the threshold
//   FAIL     measured and outside it (or outside it whatever the unmeasured ones turn out to be)
//   BLOCKED  not measurable here (the driver lacks what the gate reads, the budget stopped the run, a
//            precondition did not hold): never a pass, and it says what is missing
//
// "Passed 2 of 3" is "not proven" (docs/test-plan.md §1): a ratio gate with unmeasured cases can only
// FAIL or be BLOCKED, never PASS.

export type Verdict = "PASS" | "FAIL" | "BLOCKED";

export interface Gate {
  readonly id: string;
  /** What is measured, in a few words. */
  readonly label: string;
  /** The threshold as written in the spec (`≥ 95 %`, `= 0`, `< 3000 ms`). */
  readonly threshold: string;
  /** The measured value as text (`38/40 (95.0 %)`), or `—` when nothing was measured. */
  readonly measured: string;
  readonly n: number;
  readonly verdict: Verdict;
  /** Ids of the failing cases and why a gate is blocked (bounded, never a body or an address). */
  readonly notes: readonly string[];
}

export const MAX_NOTES = 12;

export function bounded(notes: readonly string[]): string[] {
  return notes.length <= MAX_NOTES ? [...notes] : [...notes.slice(0, MAX_NOTES), `… ${notes.length - MAX_NOTES} more`];
}

export function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${part}/${whole} (${((100 * part) / whole).toFixed(1)} %)`;
}

export interface RatioInput {
  readonly id: string;
  readonly label: string;
  /** Minimum share of passing cases, 0..1. */
  readonly minRatio: number;
  readonly passedIds: readonly string[];
  readonly failedIds: readonly string[];
  /** Cases that could not be measured, each with its reason. */
  readonly blocked: readonly string[];
}

/** A share of cases that must pass: FAIL as soon as even the unmeasured ones could not save it. */
export function ratioGate(input: RatioInput): Gate {
  const passed = input.passedIds.length;
  const n = passed + input.failedIds.length + input.blocked.length;
  const best = n === 0 ? 0 : (passed + input.blocked.length) / n;
  const verdict: Verdict = n === 0 ? "BLOCKED" : best < input.minRatio ? "FAIL" : input.blocked.length > 0 ? "BLOCKED" : passed / n >= input.minRatio ? "PASS" : "FAIL";
  const notes = [...input.failedIds.map((id) => `fail ${id}`), ...input.blocked.map((reason) => `blocked ${reason}`)];
  return { id: input.id, label: input.label, threshold: `≥ ${(input.minRatio * 100).toFixed(0)} %`, measured: percent(passed, n), n, verdict, notes: bounded(n === 0 ? ["nothing was measured"] : notes) };
}

/** A count of offending cases that must not exceed `max` (usually 0). */
export function countGate(input: { readonly id: string; readonly label: string; readonly max: number; readonly offenders: readonly string[]; readonly n: number; readonly blocked: readonly string[] }): Gate {
  const count = input.offenders.length;
  const verdict: Verdict = count > input.max ? "FAIL" : input.n === 0 || input.blocked.length > 0 ? "BLOCKED" : "PASS";
  const notes = [...input.offenders.map((id) => `fail ${id}`), ...input.blocked.map((reason) => `blocked ${reason}`)];
  return { id: input.id, label: input.label, threshold: `≤ ${input.max}`, measured: input.n === 0 ? "—" : `${count} of ${input.n}`, n: input.n, verdict, notes: bounded(input.n === 0 ? ["nothing was measured"] : notes) };
}

/** Nearest-rank percentile of `values` (0 < p ≤ 100); undefined for an empty list. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** FAIL beats BLOCKED beats PASS; an eval without gates proves nothing. */
export function overall(gates: readonly { readonly verdict: Verdict }[]): Verdict {
  if (gates.length === 0) return "BLOCKED";
  if (gates.some((gate) => gate.verdict === "FAIL")) return "FAIL";
  return gates.some((gate) => gate.verdict === "BLOCKED") ? "BLOCKED" : "PASS";
}

export type EvalId = "EV-1" | "EV-2" | "EV-3";

/** The grounding scores EV-1 saw and the threshold they suggest (ADR-0008 records the decision). */
export interface Calibration {
  readonly currentThreshold: number;
  readonly scores: { readonly n: number; readonly min?: number; readonly p05?: number; readonly p50?: number; readonly max?: number };
  /** Lowest score of a sent reply of a well-grounded question (expected clauses, nothing forbidden). */
  readonly goodSentMin?: number;
  /** Replies G2 refused for grounding, and how many of them belonged to well-grounded questions. */
  readonly refusedForGrounding: number;
  readonly refusedInGoodQuestions: number;
  /** Replies of well-grounded questions G2 judged on grounding (sent, or refused for grounding). */
  readonly goodJudged: number;
  /** How many of those the current threshold refuses. */
  readonly goodBelowCurrent: number;
  /**
   * Proposal for ADR-0008: the p05 of the good questions' judged scores (sent AND refused for grounding),
   * floored to 0.05, within 0.50-0.90; it can be lower than the current threshold.
   */
  readonly proposedThreshold?: number;
  /** How many good replies the proposal would refuse. */
  readonly goodBelowProposed?: number;
}

export interface EvalResult {
  readonly evalId: EvalId;
  readonly title: string;
  readonly n: number;
  readonly verdict: Verdict;
  readonly gates: readonly Gate[];
  /** Figures without a threshold of their own (per-variant accuracy, sources, fallbacks). */
  readonly info: Readonly<Record<string, string | number>>;
  readonly calibration?: Calibration;
}

/** An eval that could not run at all (its world was not created, the driver refused it): BLOCKED with why. */
export function blockedEval(evalId: EvalId, title: string, n: number, reason: string): EvalResult {
  const gate: Gate = { id: "run", label: "the evaluation ran", threshold: "ran", measured: "—", n: 0, verdict: "BLOCKED", notes: [reason] };
  return { evalId, title, n, verdict: "BLOCKED", gates: [gate], info: {} };
}
