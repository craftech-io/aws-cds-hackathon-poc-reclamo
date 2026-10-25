// The KPI contract of the metrics view (docs/design-brief.md §11, docs/architecture.md §12, FL-098):
// every KPI is `{value, n, source, label}`, one tab per source and never two sources in one number.
//
//   WORLD           "Este mundo": only complaints `origin LIVE` of the world (created after
//                   `create_world`), plus the "historia sembrada (no medida)" box of the seeded ones
//   BATCH           "Lote · agente real": the 30 real-agent complaints (`source BATCH`, `agentMode REAL`),
//                   raw and weighted by the assumed type mix (the weighting is an assumption, labelled)
//   SIMULATED_LOAD  "Carga simulada": the 300 complaints of the local pipeline with the scripted agent;
//                   only the mechanics that are real with a scripted agent, the rest "n/a — agente guionado"
//
// `label` is a code the console renders from copy/ ("medido", "agente guionado", "supuesto",
// "n/a — agente guionado"); a KPI that does not apply has `value: null` and a `gap`, never a zero.
import { z } from "zod";
import type { ComplaintType } from "@reclamo/shared";

/** Prefix of every run world whose KPI rows the "Lote · agente real" tab reads (scripts/metrics/publish-batch.ts). */
export const RUN_WORLD_PREFIX = "sim-";

/** The world of the simulated load (scripts/metrics/simulated-load.ts): its KPI rows live in `W#sim-load#METRICS`. */
export const SIMULATED_LOAD_WORLD = `${RUN_WORLD_PREFIX}load`;

export const KpiTab = z.enum(["WORLD", "BATCH", "SIMULATED_LOAD"]);
export type KpiTab = z.infer<typeof KpiTab>;

export const KpiLabel = z.enum(["MEASURED", "SCRIPTED_AGENT", "ASSUMPTION", "NOT_APPLICABLE_SCRIPTED"]);
export type KpiLabel = z.infer<typeof KpiLabel>;

export type KpiKey =
  | "timeToNumberP50Ms"
  | "timeToNumberP95Ms"
  | "resolvedWithoutHumanPct"
  | "resolvedWithoutHumanPctWeighted"
  | "answeredOnTimeWithProofPct"
  | "answeredOnTimeWithProofPctWeighted"
  | "answeredOnTimePct"
  | "policyViolations"
  | "gateDecisions"
  | "humanMinutesPerComplaint"
  | "costPerComplaintUsd"
  | "numberingWithoutGaps"
  | "milestonesScheduled"
  | "milestonesCancelled";

/** Why a KPI has no number: it does not apply to the tab, or there is nothing measured yet. */
export type KpiGap = "NOT_APPLICABLE" | "NO_DATA";

/** Where a number comes from: the world, the batch run, the simulated-load run, the settings or the audit. */
export interface KpiSource {
  readonly kind: "WORLD" | "BATCH" | "SIMULATED_LOAD" | "WORLD_SETTINGS" | "POLICY_AUDIT" | "TAPE";
  /** The world id, or the run id of a batch or a simulated load. */
  readonly ref: string;
}

export interface Kpi {
  readonly key: KpiKey;
  readonly value: number | boolean | null;
  /** Complaints (or decisions, violations) the number is computed over. */
  readonly n: number;
  readonly source: KpiSource;
  readonly label: KpiLabel;
  readonly gap?: KpiGap;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const Count = z.number().int().nonnegative();

/**
 * The "historia sembrada (no medida)" box: counts of the seeded complaints, never a performance rate;
 * `measuredN` is how many complaints of the world are measured (`origin LIVE`), 0 in a fresh world.
 * Invariant 17 of docs/seed-spec.md compares it with the seed manifest's box of `qa-min`.
 */
export const SeededHistoryBox = z.object({
  total: Count,
  byStatus: z.record(z.string(), Count),
  byType: z.record(z.string(), Count),
  answered: Count,
  answeredOnTime: Count,
  withDeliveryProof: Count,
  measuredN: Count,
});
export type SeededHistoryBox = z.infer<typeof SeededHistoryBox>;

export interface KpiSummary {
  readonly tab: KpiTab;
  /** Label of the tab as a whole. */
  readonly label: KpiLabel;
  readonly source: KpiSource;
  /** Complaints of the tab. */
  readonly n: number;
  readonly kpis: readonly Kpi[];
  /** Only on the `WORLD` tab. */
  readonly seededHistory?: SeededHistoryBox;
  /** The batch's note ("N = 30, 3 por tipo"): complaints per type of the tab. */
  readonly perType?: Readonly<Partial<Record<ComplaintType, number>>>;
}
