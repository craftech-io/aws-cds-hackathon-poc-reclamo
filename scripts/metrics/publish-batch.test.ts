// Publishing a real-agent batch (docs/seed-spec.md §13, FL-098): the record counts the batch's rows, its
// gate decisions and its violations; the "Lote · agente real" tab then reads it from any world.
import { describe, expect, it } from "vitest";
import { TEST_NOW, testConnector, worldMeta, worldSettings } from "../../packages/bff/src/connector/testing";
import { metricsSummary } from "../../packages/bff/src/metrics/load";
import { collectBatchRun, publishRun } from "../../packages/bff/src/metrics/runs";
import { RUN_WORLD_PREFIX } from "../../packages/bff/src/metrics/types";
import { parsePublishArgs } from "./publish-batch";

describe("metrics:publish-batch [FL-098]", () => {
  it("[FL-098] collects the batch world's rows, decisions and violations and publishes them for the batch tab", async () => {
    const { connector, store } = testConnector();
    await connector.worlds.register(worldMeta("sim-b1", { status: "READY" }));
    await connector.worlds.putSettings(worldSettings("demo"));
    for (const [index, type] of (["DATA_CHANGE", "ACCOUNT_BLOCKED"] as const).entries()) {
      await connector.metrics.put({ worldId: "sim-b1", source: "BATCH", runId: "sim-b1", complaintId: `cmp-${index}`, complaintType: type, agentMode: "REAL", origin: "LIVE", resolvedWithoutHuman: index === 0, answeredOnTime: true, deliveryProof: "DELIVERED", humanActions: [], tokens: { in: 1, out: 1, cached: 0 }, messages: { wa: 1, email: 1 } });
    }
    const run = await collectBatchRun(connector, { runId: "b1", worldIds: ["sim-b1"], now: TEST_NOW, reportCostUsd: 1.25 });
    expect(run).toMatchObject({ tab: "BATCH", runId: "b1", agentMode: "REAL", inputs: 2, policyViolations: 0, decisions: [], reportCostUsd: 1.25 });
    await publishRun(store, run, TEST_NOW);
    const summary = await metricsSummary(connector, { worldId: "demo", epoch: 0, tab: "BATCH" });
    expect(summary).toMatchObject({ tab: "BATCH", n: 2, source: { kind: "BATCH", ref: "b1" } });
    expect(summary.kpis.find((kpi) => kpi.key === "resolvedWithoutHumanPct")).toMatchObject({ value: 50, n: 2 });
    await expect(collectBatchRun(connector, { runId: "b2", worldIds: ["sim-missing"], now: TEST_NOW })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("takes only sim-* worlds and needs a run id", () => {
    expect(parsePublishArgs(["--run", "b1", "--world", "sim-b1", "--report-cost", "2.5"])).toEqual({ runId: "b1", worldIds: ["sim-b1"], reportCostUsd: 2.5 });
    expect(() => parsePublishArgs(["--run", "b1", "--world", "demo"])).toThrow(/sim-/);
    // The Bff's read-only KPI grant (infra/iam-leading-keys.ts `W#sim-*#METRICS`) follows this prefix.
    expect(parsePublishArgs(["--run", "b1", "--world", `${RUN_WORLD_PREFIX}b1`]).worldIds).toEqual(["sim-b1"]);
    expect(() => parsePublishArgs(["--world", "sim-b1"])).toThrow(/--run/);
    expect(() => parsePublishArgs(["--run", "b1", "--world", "sim-b1", "--report-cost", "-1"])).toThrow(/non-negative/);
  });
});
