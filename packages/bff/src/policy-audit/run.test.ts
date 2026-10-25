// The PolicyAudit Lambda's input: one world on demand, the operator's worlds daily (scheduler or
// `{kind: "DAILY"}`), anything else refused without auditing; a world that fails never stops the others.
import { describe, expect, it } from "vitest";
import { MemoryAnchorLog } from "../complaints/testing";
import { TEST_NOW, worldMeta, worldSettings } from "../connector/testing";
import { complaintsKit } from "../complaints/testing";
import { DAILY_WORLDS, runRequestedAudit } from "./run";
import type { PolicyAuditDeps } from "./types";

async function worlds(ids: readonly string[], withSettings: readonly string[] = ids) {
  const kit = complaintsKit();
  for (const worldId of ids) await kit.connector.worlds.register(worldMeta(worldId, { status: "READY" }));
  for (const worldId of withSettings) await kit.connector.worlds.putSettings(worldSettings(worldId));
  const deps: PolicyAuditDeps = { connector: kit.connector, chainKey: kit.deps.chainKey, anchors: new MemoryAnchorLog(), log: kit.log, now: () => TEST_NOW };
  return { kit, deps };
}

describe("PolicyAudit invocation [FL-075]", () => {
  it("[FL-075] audits one world on demand", async () => {
    const { deps } = await worlds(["demo", "g01"]);
    const run = await runRequestedAudit(deps, { worldId: "g01" });
    expect(run.reports.map((report) => report.worldId)).toEqual(["g01"]);
    expect(run).toMatchObject({ failures: [], violations: 0 });
  });

  it("[FL-075] the daily run covers the operator's worlds that exist, from the scheduler or on request", async () => {
    const { deps } = await worlds(["demo", "qamin", "g03", "gtest"]);
    for (const event of [{ kind: "DAILY" }, { source: "aws.scheduler", "detail-type": "Scheduled Event" }]) {
      const run = await runRequestedAudit(deps, event);
      expect(run.reports.map((report) => report.worldId)).toEqual(["demo", "qamin", "gtest", "g03"]);
    }
    expect(DAILY_WORLDS).toHaveLength(102);
    expect(DAILY_WORLDS.some((worldId) => worldId.startsWith("qa-") || worldId.startsWith("gs-"))).toBe(false);
  });

  it("a world that fails is reported and the others still run", async () => {
    const { deps } = await worlds(["demo", "g02"], ["g02"]);
    const run = await runRequestedAudit(deps, { kind: "DAILY" });
    expect(run.reports.map((report) => report.worldId)).toEqual(["g02"]);
    expect(run.failures).toEqual([{ worldId: "demo", error: "ToolError" }]);
  });

  it("refuses anything else without auditing: an unknown world id, extra fields, a forged scheduler event naming a world", async () => {
    const { deps, kit } = await worlds(["demo"]);
    for (const event of [{ worldId: "../demo" }, { worldId: "demo", extra: 1 }, "demo", null]) {
      expect(await runRequestedAudit(deps, event)).toMatchObject({ reports: [], failures: [{ error: "INVALID_REQUEST" }] });
    }
    const forged = await runRequestedAudit(deps, { source: "aws.events", worldId: "not-a-world" });
    expect(forged.reports.map((report) => report.worldId)).toEqual(["demo"]);
    expect(kit.lines.filter((line) => line.message === "policy_audit.invalid_request")).toHaveLength(4);
  });
});
