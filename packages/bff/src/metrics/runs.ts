// The record of a metrics run (docs/seed-spec.md §13): which `sim-*` worlds hold the KPI rows of the
// latest real-agent batch or simulated load, and the run-level mechanics no complaint row can carry
// (numbering without gaps, milestones scheduled and cancelled, the gate's decisions by rule, the
// violations PolicyAudit found). Kept in `Reference/REF#METRICS_RUN#<tab>` / `LATEST`, written by the
// operator's scripts (scripts/metrics/), read by the metrics view of every world.
import { z } from "zod";
import { ToolError, WorldId } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import type { TableStore } from "../connector/store";
import { keys } from "../connector/keys";
import type { TapeEntry } from "../domain/ledger";
import { VIOLATION_ACTION } from "../policy-audit/types";
import { decisionCounts } from "./kpis";

export const RunTab = z.enum(["BATCH", "SIMULATED_LOAD"]);
export type RunTab = z.infer<typeof RunTab>;

export const DecisionCount = z.object({
  decision: z.enum(["ALLOWED", "BLOCKED", "REROUTED", "DEFERRED"]),
  ruleId: z.string().min(1).max(60),
  senderClass: z.enum(["AGENT", "OPERATOR", "SYSTEM"]),
  count: z.number().int().nonnegative(),
});
export type DecisionCount = z.infer<typeof DecisionCount>;

export const RunRecord = z.object({
  tab: RunTab,
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  worldIds: z.array(WorldId).min(1).max(40),
  agentMode: z.enum(["REAL", "SCRIPTED"]),
  ranAtReal: z.iso.datetime({ offset: true }),
  /** Presentations the run fed in. */
  inputs: z.number().int().nonnegative(),
  policyViolations: z.number().int().nonnegative(),
  decisions: z.array(DecisionCount).max(200),
  numbering: z.object({ first: z.string().max(20), last: z.string().max(20), registered: z.number().int().nonnegative(), gaps: z.number().int().nonnegative() }).optional(),
  milestones: z.object({ scheduled: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(), fired: z.number().int().nonnegative() }).optional(),
  /** What the run cost (the batch's report, USD), when it was measured. */
  reportCostUsd: z.number().nonnegative().optional(),
});
export type RunRecord = z.infer<typeof RunRecord>;

const REFERENCE_TYPE = "METRICS_RUN";
const LATEST = "LATEST";

/** The latest run of a tab, or `undefined` when none was published. */
export async function loadRun(connector: Pick<Connector, "reference">, tab: RunTab): Promise<RunRecord | undefined> {
  return connector.reference.get(RunRecord, REFERENCE_TYPE, tab, LATEST);
}

/** Publishes a run as the latest of its tab (the operator's scripts, with the stage's credentials). */
export async function publishRun(store: TableStore, record: RunRecord, now: Date): Promise<void> {
  const value = RunRecord.parse(record);
  await store.write({ kind: "put", table: "Reference", item: { ...keys.reference(REFERENCE_TYPE, value.tab, LATEST), entity: "MetricsRun", ...value, updatedAt: now.toISOString() } });
}

/** Tape entries read per world to count a run's decisions (a 30-complaint batch writes a few hundred). */
const TAPE_PAGE = 5_000;

/**
 * The record of a real-agent batch from what its worlds hold: the KPI rows' count, the gate's decisions
 * of their tape and the `VIOLATION` entries PolicyAudit left (`policyAudit.run` runs before publishing).
 */
export async function collectBatchRun(connector: Connector, request: { readonly runId: string; readonly worldIds: readonly string[]; readonly now: Date; readonly reportCostUsd?: number }): Promise<RunRecord> {
  let inputs = 0;
  let violations = 0;
  const tape: TapeEntry[] = [];
  for (const worldId of request.worldIds) {
    const meta = await connector.worlds.getMeta(worldId);
    if (meta === undefined) throw new ToolError("NOT_FOUND", "a batch world does not exist");
    inputs += (await connector.metrics.list(worldId, { source: "BATCH" })).length;
    violations += (await connector.audit.listByAction(worldId, VIOLATION_ACTION, 1_000)).length;
    tape.push(...(await connector.chains.listTapeBySeq(worldId, meta.epoch, { limit: TAPE_PAGE })).entries);
  }
  return RunRecord.parse({
    tab: "BATCH",
    runId: request.runId,
    worldIds: request.worldIds,
    agentMode: "REAL",
    ranAtReal: request.now.toISOString(),
    inputs,
    policyViolations: violations,
    decisions: decisionCounts(tape),
    ...(request.reportCostUsd === undefined ? {} : { reportCostUsd: request.reportCostUsd }),
  });
}
