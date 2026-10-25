// The step before every full suite (docs/test-plan.md §1.5 and §5): the "comprobantes SR" read by
// `receipt.readProbe` × 5 in a QA world of their own (`qa-<runId>-ev2-sr`). The full suite runs only if
// every repetition is exact; anything else (a miss, an unread case, a blocked probe) aborts it.
//
// `npm run scenarios -- --suite full` calls `runSrGate` before any scenario (scripts/scenarios/run.ts
// through scenarios/lib/precondition.ts `runGatedFullSuite`) and writes no scenario if it does not pass;
// `npm run evals -- --sr-gate` runs it alone.
import type { ReceiptSet } from "./datasets";
import type { EvalDriver } from "./driver";
import { SR_REPETITIONS, readSr } from "./ev2-receipts";
import type { EvalResult } from "./gates";
import { scoreSr } from "./score-receipts";
import { createWorld, destroyWorld } from "./worlds";

export const SR_GATE_SCENARIO = "ev2-sr";

/** Reads the SR subset and judges it; `passed` is true only for a PASS of every repetition. */
export async function runSrGate(driver: EvalDriver, set: ReceiptSet, repetitions: number = SR_REPETITIONS): Promise<{ readonly passed: boolean; readonly result: EvalResult }> {
  const world = await createWorld(driver, SR_GATE_SCENARIO, []);
  let gate;
  try {
    gate = scoreSr(set, await readSr(driver, world, set, repetitions), repetitions);
  } finally {
    await destroyWorld(driver, world);
  }
  const result: EvalResult = {
    evalId: "EV-2",
    title: "Receipt reading · SR subset before the full suite",
    n: gate.n,
    verdict: gate.verdict,
    gates: [gate],
    info: { datasetVersion: set.version, repetitions },
  };
  return { passed: gate.verdict === "PASS", result };
}
