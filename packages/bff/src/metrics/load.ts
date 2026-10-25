// What `metrics.summary` and `metrics.export` read (the routers of WP-36 call these): one tab at a time,
// from `Complaints`, `Metrics`, `ComplianceTape`, `AuditLog`, the world's `SETTINGS` and `Reference`
// (rate card, latest runs). Seeded tape entries (`synthetic`) never count as the world's decisions.
import { ToolError } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import { ofEpoch, type TapeEntry } from "../domain/ledger";
import type { ComplaintKpi } from "../domain/metrics";
import { worldComplaints } from "../policy-audit/facts";
import { VIOLATION_ACTION } from "../policy-audit/types";
import { loadRateCard } from "./assumptions";
import { batchSummary, decisionCounts, simulatedLoadSummary, worldSummary } from "./kpis";
import { loadRun } from "./runs";
import type { KpiSummary, KpiTab } from "./types";

/** Decisions and violations read per world (a world past these is summarized on what was read). */
const READ_LIMIT = 1_000;

async function worldDecisions(connector: Connector, worldId: string, epoch: number): Promise<TapeEntry[]> {
  const kinds = ["ALLOWED", "BLOCKED", "REROUTED", "DEFERRED"] as const;
  const pages = await Promise.all(kinds.map((decision) => connector.chains.listTapeByDecision(worldId, decision, READ_LIMIT)));
  return ofEpoch(pages.flat(), epoch).filter((entry) => entry.synthetic !== true);
}

async function runRows(connector: Connector, worldIds: readonly string[], source: "BATCH" | "SIMULATED_LOAD"): Promise<ComplaintKpi[]> {
  const pages = await Promise.all(worldIds.map((worldId) => connector.metrics.list(worldId, { source })));
  return pages.flat();
}

function noRun(tab: Exclude<KpiTab, "WORLD">): KpiSummary {
  return { tab, label: tab === "BATCH" ? "MEASURED" : "SCRIPTED_AGENT", source: { kind: tab, ref: "none" }, n: 0, kpis: [] };
}

/**
 * The summary of one tab, as seen from `worldId` (its settings; the runs are the stage's). "Este
 * mundo" counts only the tape and audit entries of `epoch` (both logs outlive a reset).
 */
export async function metricsSummary(connector: Connector, request: { readonly worldId: string; readonly epoch: number; readonly tab: KpiTab }): Promise<KpiSummary> {
  const settings = await connector.worlds.getSettings(request.worldId);
  if (settings === undefined) throw new ToolError("NOT_FOUND", "the world has no settings");
  const rateCard = await loadRateCard(connector);
  const whatsappSimulated = settings.channelModes.whatsapp === "simulated";
  if (request.tab === "WORLD") {
    const [complaints, rows, violations, decisions] = await Promise.all([
      worldComplaints(connector, request.worldId),
      connector.metrics.list(request.worldId, { source: "WORLD" }),
      connector.audit.listByAction(request.worldId, VIOLATION_ACTION, READ_LIMIT),
      worldDecisions(connector, request.worldId, request.epoch),
    ]);
    return worldSummary({ worldId: request.worldId, complaints, rows, violations: ofEpoch(violations, request.epoch).length, decisions: decisionCounts(decisions), settings, whatsappSimulated, ...(rateCard === undefined ? {} : { rateCard }) });
  }
  const run = await loadRun(connector, request.tab);
  if (run === undefined) return noRun(request.tab);
  const rows = await runRows(connector, run.worldIds, request.tab);
  if (request.tab === "BATCH") return batchSummary({ run, rows, settings, whatsappSimulated, ...(rateCard === undefined ? {} : { rateCard }) });
  return simulatedLoadSummary({ run, rows, settings });
}

export interface KpiExportRow {
  readonly tab: string;
  readonly key: string;
  readonly value: string;
  readonly n: number;
  readonly source: string;
  readonly label: string;
  readonly gap: string;
}

/** Flat rows of a summary for `metrics.export` (the router escapes every cell of the CSV). */
export function exportRows(summary: KpiSummary): KpiExportRow[] {
  return summary.kpis.map((item) => ({
    tab: summary.tab,
    key: item.key,
    value: item.value === null ? "" : String(item.value),
    n: item.n,
    source: `${item.source.kind}:${item.source.ref}`,
    label: item.label,
    gap: item.gap ?? "",
  }));
}
