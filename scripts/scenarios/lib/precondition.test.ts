import { describe, expect, it, vi } from "vitest";
import { loadEvalSets } from "../../evals/datasets";
import type { EvalResult } from "../../evals/gates";
import { srGatePlan } from "../../evals/plan";
import { gateNotCovered, runGatedFullSuite } from "./precondition";
import { renderMarkdown, type RunReport } from "./report";

const gateResult = (verdict: EvalResult["verdict"]): EvalResult => ({
  evalId: "EV-2",
  title: "SR",
  n: 60,
  verdict,
  gates: [{ id: "sr", label: "SR × 5", threshold: "100 %", measured: verdict === "PASS" ? "60/60 (100.0 %)" : "55/60 (91.7 %)", n: 60, verdict, notes: verdict === "PASS" ? [] : ["C16 rep 3: invented fields"] }],
  info: {},
});

const suiteReport: RunReport = { runId: "812-1", suite: "full", startedAt: "", finishedAt: "", durationMs: 1, verdict: "PASS", scenarios: [], flows: {}, budget: { maxTurns: 450, turns: 0, estimatedCostUsd: 0 } };

describe("SR gate before the full suite (docs/test-plan.md §1.5, §5; WP-49)", () => {
  it("a failed SR gate leaves the suite uncalled, and the report says why", async () => {
    const suite = vi.fn(async () => suiteReport);
    const report = await runGatedFullSuite({ runId: "812-1", maxTurns: 450, gateUsdHigh: 0.4, maxCostUsd: 30, gate: async () => ({ passed: false, result: gateResult("FAIL") }), suite, now: () => 0 });
    expect(suite).not.toHaveBeenCalled();
    expect(report).toMatchObject({ verdict: "FAIL", scenarios: [], budget: { turns: 0, aborted: "SR gate FAIL: no scenario was run" }, srGate: { verdict: "FAIL", n: 60 } });
    expect(renderMarkdown(report)).toContain("SR gate (EV-2 SR subset × 5, before the suite): **FAIL**");
  });

  it("a gate that throws is BLOCKED and blocks the suite as well", async () => {
    const suite = vi.fn(async () => suiteReport);
    const report = await runGatedFullSuite({ runId: "812-1", maxTurns: 450, gateUsdHigh: 0.4, gate: async () => Promise.reject(new Error("world.create: NOT_WIRED")), suite, now: () => 0 });
    expect(suite).not.toHaveBeenCalled();
    expect(report.verdict).toBe("BLOCKED");
  });

  it("runs the suite after a PASS, with the cost budget the gate left", async () => {
    const suite = vi.fn(async (maxCostUsd: number | undefined) => ({ ...suiteReport, budget: { ...suiteReport.budget, ...(maxCostUsd === undefined ? {} : { maxCostUsd }) } }));
    const report = await runGatedFullSuite({ runId: "812-1", maxTurns: 450, gateUsdHigh: 0.4, maxCostUsd: 30, gate: async () => ({ passed: true, result: gateResult("PASS") }), suite });
    expect(suite).toHaveBeenCalledWith(29.6);
    expect(report).toMatchObject({ verdict: "PASS", srGate: { verdict: "PASS" } });
  });

  it("refuses to start when --max-cost-usd does not cover the gate's high estimate", async () => {
    const high = srGatePlan(loadEvalSets()).usd.high;
    expect(high).toBeGreaterThan(0);
    expect(gateNotCovered(high, undefined)).toBeUndefined();
    expect(gateNotCovered(high, high)).toBeUndefined();
    expect(gateNotCovered(high, high / 2)).toContain("does not cover the SR gate");
    const gate = vi.fn();
    await expect(runGatedFullSuite({ runId: "812-1", maxTurns: 450, gateUsdHigh: high, maxCostUsd: high / 2, gate, suite: vi.fn() })).rejects.toThrow(RangeError);
    expect(gate).not.toHaveBeenCalled();
  });
});
