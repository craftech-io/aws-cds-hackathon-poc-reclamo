// The precondition of the full suite (docs/test-plan.md §1.5 and §5, WP-49): the "comprobantes SR" of
// EV-2 read × 5 (scripts/evals/sr-gate.ts) run BEFORE any scenario, and anything but an exact PASS aborts
// the run: no scenario starts, no turn is spent, and the report carries the gate's verdict. The gate is
// priced first (`srGatePlan`): a `--max-cost-usd` that does not cover its high estimate refuses the run,
// and what the gate may spend is taken out of the suite's own cost budget.
import { type EvalResult, blockedEval } from "../../evals/gates";
import type { RunReport } from "./report";

export const SR_GATE_TITLE = "Receipt reading · SR subset before the full suite";

export interface SrGateOutcome {
  readonly passed: boolean;
  readonly result: EvalResult;
}

export interface GatedFullRun {
  readonly runId: string;
  readonly maxTurns: number;
  /** High estimate of the gate (`srGatePlan(sets).usd.high`). */
  readonly gateUsdHigh: number;
  readonly maxCostUsd?: number;
  readonly gate: () => Promise<SrGateOutcome>;
  /** The suite itself, with the cost budget left after the gate. */
  readonly suite: (maxCostUsd: number | undefined) => Promise<RunReport>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** Why `--max-cost-usd` cannot pay for the gate, or undefined when it can (or no cap was given). */
export function gateNotCovered(gateUsdHigh: number, maxCostUsd: number | undefined): string | undefined {
  if (maxCostUsd === undefined || maxCostUsd >= gateUsdHigh) return undefined;
  return `--max-cost-usd ${maxCostUsd} does not cover the SR gate that precedes the full suite (up to US$ ${gateUsdHigh.toFixed(2)})`;
}

export function srGateSummary(result: EvalResult, usdHigh: number): NonNullable<RunReport["srGate"]> {
  const gate = result.gates[0];
  return { verdict: result.verdict, n: result.n, measured: gate?.measured ?? "—", notes: [...(gate?.notes ?? [])], usdHigh };
}

/** The gate, then (only on PASS) the suite. A gate that throws is BLOCKED, and blocks the suite too. */
export async function runGatedFullSuite(run: GatedFullRun): Promise<RunReport> {
  const refusal = gateNotCovered(run.gateUsdHigh, run.maxCostUsd);
  if (refusal !== undefined) throw new RangeError(refusal);
  const now = run.now ?? Date.now;
  const started = now();
  let outcome: SrGateOutcome;
  try {
    outcome = await run.gate();
  } catch (error) {
    outcome = { passed: false, result: blockedEval("EV-2", SR_GATE_TITLE, 0, error instanceof Error ? `${error.name}: ${error.message}` : "the gate failed") };
  }
  const srGate = srGateSummary(outcome.result, run.gateUsdHigh);
  run.log?.(`SR gate: ${srGate.verdict} · ${srGate.measured}`);
  if (!outcome.passed) {
    const finished = now();
    return {
      runId: run.runId,
      suite: "full",
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      verdict: srGate.verdict === "PASS" ? "FAIL" : srGate.verdict,
      scenarios: [],
      flows: {},
      budget: { maxTurns: run.maxTurns, turns: 0, ...(run.maxCostUsd === undefined ? {} : { maxCostUsd: run.maxCostUsd }), estimatedCostUsd: run.gateUsdHigh, aborted: `SR gate ${srGate.verdict}: no scenario was run` },
      srGate,
    };
  }
  const report = await run.suite(run.maxCostUsd === undefined ? undefined : cents(run.maxCostUsd - run.gateUsdHigh));
  return { ...report, srGate };
}
