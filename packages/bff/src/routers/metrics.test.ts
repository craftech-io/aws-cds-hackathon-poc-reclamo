// `metrics.*` (FL-098; docs/design-brief.md §11): one tab at a time of the principal's world, every KPI
// with its N, source and label, nothing seeded counted as measured, and the CSV export with guarded cells.
import { beforeEach, describe, expect, it } from "vitest";
import { complaint } from "../connector/testing";
import { parseCsv } from "./csv";
import { METRICS_CSV_COLUMNS } from "./metrics";
import { COMPLIANCE, type ConsoleRig, GUEST, consoleRig } from "./testing";

let rig: ConsoleRig;

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("g03");
  await rig.seedWorld("demo");
  await rig.connector.transact([
    rig.connector.complaints.createOp(complaint("g03", { complaintId: "cmp-seed-1", complaintNumber: "R-2026-000100", origin: "SEED", status: "CLOSED" })),
    rig.connector.complaints.createOp(complaint("g03", { complaintId: "cmp-0123", complaintNumber: "R-2026-000123", origin: "LIVE" })),
  ]);
});

describe("metrics.summary [FL-098]", () => {
  it("[FL-098] measures only the world's LIVE complaints and keeps the seeded history in its own box", async () => {
    const { caller } = await rig.as(GUEST);
    const summary = await caller.metrics.summary();
    expect(summary).toMatchObject({ tab: "WORLD", label: "MEASURED", source: { kind: "WORLD", ref: "g03" }, n: 1 });
    expect(summary.seededHistory).toMatchObject({ total: 1, measuredN: 1 });
    expect(summary.kpis.length).toBeGreaterThan(0);
    for (const kpi of summary.kpis) {
      expect(kpi).toHaveProperty("value");
      expect(typeof kpi.n).toBe("number");
      expect(kpi.source.ref.length).toBeGreaterThan(0);
      expect(["MEASURED", "SCRIPTED_AGENT", "ASSUMPTION", "NOT_APPLICABLE_SCRIPTED"]).toContain(kpi.label);
    }
  });

  it("[FL-098] reads the principal's world only, whatever world the tab would be about", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const summary = await caller.metrics.summary({ tab: "WORLD" });
    expect(summary).toMatchObject({ source: { ref: "demo" }, n: 0 });
    await expect(caller.metrics.summary({ tab: "WORLD", worldId: "g03" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("[FL-098] answers an empty tab while no batch or simulated load has run", async () => {
    const { caller } = await rig.as(GUEST);
    expect(await caller.metrics.summary({ tab: "BATCH" })).toMatchObject({ tab: "BATCH", n: 0, kpis: [] });
    expect(await caller.metrics.summary({ tab: "SIMULATED_LOAD" })).toMatchObject({ tab: "SIMULATED_LOAD", label: "SCRIPTED_AGENT", n: 0 });
  });
});

describe("metrics.export [FL-098]", () => {
  it("[FL-098] exports the tab as CSV with N, source and label per KPI and no cell that runs as a formula", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const exported = await caller.metrics.export({ tab: "WORLD" });
    expect(exported.filename).toMatch(/^metrics-world-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(exported.contentType).toBe("text/csv; charset=utf-8");
    const [header, ...rows] = parseCsv(exported.csv);
    expect(header).toEqual([...METRICS_CSV_COLUMNS]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row[0] === "WORLD" && (row[4] ?? "").endsWith(":demo"))).toBe(true);
    expect(rows.flat().some((cell) => /^[=+\-@\t\r]/.test(cell))).toBe(false);
  });
});
