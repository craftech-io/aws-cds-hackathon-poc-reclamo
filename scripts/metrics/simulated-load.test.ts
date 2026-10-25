// The simulated load through the local pipeline (docs/seed-spec.md §13, FL-098, FL-075): the seed's 300
// presentations get correlative numbers without gaps, their milestones are scheduled and cancelled by
// the written answer, every send goes through the gate, PolicyAudit finds nothing, and what the tab
// shows is only those mechanics (the agent's numbers are n/a — scripted agent).
import { describe, expect, it } from "vitest";
import { simulatedLoadSummary } from "../../packages/bff/src/metrics/kpis";
import { worldSettings } from "../../packages/bff/src/connector/testing";
import { numberingOf, parseArgs, runSimulatedLoad, seedHolidays, seedLoadInputs } from "./simulated-load";

const NOW = new Date("2026-10-09T15:00:00.000Z");

describe("metrics:simulated-load [FL-098]", () => {
  it("[FL-098] [FL-075] runs the 300 presentations: numbers without gaps, 900 milestones scheduled and cancelled, every send allowed by the gate, zero violations", async () => {
    const result = await runSimulatedLoad({ inputs: seedLoadInputs(), holidays: seedHolidays(), runId: "sl-test", now: NOW });
    expect(result.run).toMatchObject({
      tab: "SIMULATED_LOAD",
      runId: "sl-test",
      worldIds: ["sim-load"],
      agentMode: "SCRIPTED",
      inputs: 300,
      policyViolations: 0,
      numbering: { first: "R-2026-000001", last: "R-2026-000300", registered: 300, gaps: 0 },
      milestones: { scheduled: 900, cancelled: 900, fired: 0 },
    });
    expect(result.outcomes).toEqual({ ACK_ALLOWED: 300, ANSWER_ALLOWED: 300 });
    expect(result.classifiedByRule).toBe(300);
    expect(result.audit).toMatchObject({ messagesChecked: 600, failed: 0, violations: [], warnings: [] });
    expect(result.audit.chains.map((chain) => chain.result)).toEqual(["ok", "ok", "ok"]);
    expect(result.run.decisions.reduce((sum, entry) => sum + entry.count, 0)).toBe(600);

    expect(result.rows).toHaveLength(300);
    for (const row of result.rows) expect(row).toMatchObject({ worldId: "sim-load", source: "SIMULATED_LOAD", runId: "sl-test", agentMode: "SCRIPTED", origin: "LIVE", answeredOnTime: true, tokens: { in: 0, out: 0, cached: 0 } });
    expect(JSON.stringify(result.rows)).not.toMatch(/@|\+54/);

    const summary = simulatedLoadSummary({ run: result.run, rows: result.rows, settings: worldSettings("demo") });
    expect(summary).toMatchObject({ tab: "SIMULATED_LOAD", label: "SCRIPTED_AGENT", n: 300 });
    expect(summary.kpis.find((kpi) => kpi.key === "answeredOnTimePct")).toMatchObject({ value: 100, n: 300 });
    expect(summary.kpis.find((kpi) => kpi.key === "costPerComplaintUsd")).toMatchObject({ value: null, label: "NOT_APPLICABLE_SCRIPTED" });
    expect(summary.kpis.find((kpi) => kpi.key === "numberingWithoutGaps")).toMatchObject({ value: true, n: 300 });
  }, 60_000);

  it("is deterministic: two runs give the same rows and mechanics", async () => {
    const inputs = seedLoadInputs().slice(0, 20);
    const [first, second] = await Promise.all([1, 2].map(() => runSimulatedLoad({ inputs, holidays: seedHolidays(), runId: "sl-det", now: NOW })));
    expect(second?.rows).toEqual(first?.rows);
    expect(second?.run).toEqual(first?.run);
  });

  it("counts a gap in the numbering", () => {
    expect(numberingOf(["R-2026-000003", "R-2026-000001", "R-2026-000004"])).toEqual({ first: "R-2026-000001", last: "R-2026-000004", registered: 3, gaps: 1 });
    expect(numberingOf([])).toEqual({ first: "", last: "", registered: 0, gaps: 0 });
  });

  it("writes only a *.local.json file and refuses an unknown flag or a bad limit", () => {
    expect(parseArgs(["--limit", "10", "--out", "/tmp/load.local.json"])).toEqual({ load: false, limit: 10, out: "/tmp/load.local.json" });
    expect(() => parseArgs(["--out", "scripts/metrics/load.json"])).toThrow(/local\.json/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive/);
    expect(() => parseArgs(["--deploy"])).toThrow(/unknown argument/);
  });
});
