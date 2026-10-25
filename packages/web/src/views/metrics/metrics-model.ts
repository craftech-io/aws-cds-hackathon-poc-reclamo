// What the metrics view derives from `metrics.summary`, as pure functions: the value of a KPI in its
// unit (seconds, %, US$, minutes, a count or yes/no), "n/a — agente guionado" or "sin datos" instead
// of a zero, where the number comes from, and the lines of its detail. A KPI's `detail` crosses the
// network untyped, so each known shape is parsed with zod before it is read. No `Intl`: numbers are
// written with the es-AR decimal comma by hand, as the rest of the console does.
import { z } from "zod";
import type { KpiKey } from "@reclamo/bff/metrics/types";
import type { RouterOutputs } from "../../lib/trpc-router";
import { metricsCopy } from "./copy";

export type KpiSummary = RouterOutputs["metrics"]["summary"];
export type KpiTab = KpiSummary["tab"];
export type Kpi = KpiSummary["kpis"][number];

export const TABS: readonly KpiTab[] = ["WORLD", "BATCH", "SIMULATED_LOAD"];

/** `1234.5` → "1.234,5" with `decimals` digits (and the thousands dot the console uses for money). */
export function decimal(value: number, decimals: number): string {
  const [whole = "0", fraction] = Math.abs(value).toFixed(decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value < 0 ? "-" : ""}${grouped}${fraction === undefined ? "" : `,${fraction}`}`;
}

export function secondsText(ms: number): string {
  return `${decimal(ms / 1000, 1)} s`;
}

export function usdText(value: number, decimals = 4): string {
  return `US$ ${decimal(value, decimals)}`;
}

const UNIT: Readonly<Record<KpiKey, (value: number) => string>> = {
  timeToNumberP50Ms: secondsText,
  timeToNumberP95Ms: secondsText,
  resolvedWithoutHumanPct: (value) => `${decimal(value, 1)} %`,
  resolvedWithoutHumanPctWeighted: (value) => `${decimal(value, 1)} %`,
  answeredOnTimeWithProofPct: (value) => `${decimal(value, 1)} %`,
  answeredOnTimeWithProofPctWeighted: (value) => `${decimal(value, 1)} %`,
  answeredOnTimePct: (value) => `${decimal(value, 1)} %`,
  policyViolations: String,
  gateDecisions: String,
  humanMinutesPerComplaint: (value) => `${decimal(value, 1)} min`,
  costPerComplaintUsd: (value) => usdText(value),
  numberingWithoutGaps: String,
  milestonesScheduled: String,
  milestonesCancelled: String,
};

/** The figure of a KPI as the tile shows it; never a zero for something that was not measured. */
export function valueText(kpi: Pick<Kpi, "key" | "value" | "gap" | "label">): string {
  if (kpi.value === null) return kpi.gap === "NOT_APPLICABLE" || kpi.label === "NOT_APPLICABLE_SCRIPTED" ? metricsCopy.labels.NOT_APPLICABLE_SCRIPTED : metricsCopy.card.noData;
  if (typeof kpi.value === "boolean") return kpi.value ? metricsCopy.card.yes : metricsCopy.card.no;
  return UNIT[kpi.key](kpi.value);
}

export function sourceText(source: Kpi["source"]): string {
  return metricsCopy.sources[source.kind](source.ref);
}

const Latency = z.looseObject({
  measuredUntil: z.string(),
  coldStarts: z.looseObject({ n: z.number(), p95: z.number().nullable() }),
});
const OnTime = z.looseObject({ overdue: z.number(), answeredLate: z.number(), withoutProof: z.number() });
const Cost = z.looseObject({
  breakdown: z.looseObject({ model: z.number(), email: z.number(), whatsappValuedAsLive: z.number() }),
  rateCardVersion: z.string(),
  thresholdUsd: z.number().optional(),
  weighted: z.number().nullable().optional(),
  reportCostUsd: z.number().optional(),
});
const Minutes = z.looseObject({
  breakdown: z.record(z.string(), z.looseObject({ count: z.number(), minutes: z.number() })),
  minutesPerAction: z.record(z.string(), z.number()),
});
const Decisions = z.looseObject({ byRule: z.array(z.looseObject({ decision: z.string(), ruleId: z.string(), senderClass: z.string(), count: z.number() })) });
const Numbering = z.looseObject({ first: z.string(), last: z.string() });
const Mix = z.looseObject({ mix: z.record(z.string(), z.number()) });

/** Lines under a KPI's figure, from its detail; none when the detail is missing or unknown. */
export function detailLines(kpi: Pick<Kpi, "key" | "detail">): string[] {
  const d = metricsCopy.detail;
  const detail: unknown = kpi.detail;
  switch (kpi.key) {
    case "timeToNumberP50Ms":
    case "timeToNumberP95Ms": {
      const parsed = Latency.safeParse(detail);
      if (!parsed.success) return [];
      const { measuredUntil, coldStarts } = parsed.data;
      return [measuredUntil.includes("SIMULATED") ? d.untilSimulated : d.untilTransport, d.coldStarts(coldStarts.n, coldStarts.p95 === null ? "—" : secondsText(coldStarts.p95))];
    }
    case "answeredOnTimeWithProofPct": {
      const parsed = OnTime.safeParse(detail);
      return parsed.success ? [`${parsed.data.overdue} ${d.overdue} · ${parsed.data.answeredLate} ${d.late} · ${parsed.data.withoutProof} ${d.withoutProof}`] : [];
    }
    case "costPerComplaintUsd": {
      const parsed = Cost.safeParse(detail);
      if (!parsed.success) return [];
      const { breakdown, rateCardVersion, thresholdUsd, weighted, reportCostUsd } = parsed.data;
      return [
        `${d.breakdown}: ${d.model} ${usdText(breakdown.model)} · ${d.email} ${usdText(breakdown.email)} · ${d.whatsapp} ${usdText(breakdown.whatsappValuedAsLive)}`,
        ...(weighted !== undefined && weighted !== null ? [`${d.weighted}: ${usdText(weighted)}`] : []),
        ...(thresholdUsd !== undefined ? [`${d.threshold}: ${usdText(thresholdUsd)}`] : []),
        ...(reportCostUsd !== undefined ? [`${d.report}: ${usdText(reportCostUsd, 2)}`] : []),
        `${d.rateCard}: ${rateCardVersion}`,
      ];
    }
    case "humanMinutesPerComplaint": {
      const parsed = Minutes.safeParse(detail);
      if (!parsed.success) return [];
      return Object.entries(parsed.data.breakdown).map(([action, entry]) => d.perAction(action, entry.count, `${decimal(parsed.data.minutesPerAction[action] ?? 0, 1)} min`));
    }
    case "gateDecisions": {
      const parsed = Decisions.safeParse(detail);
      if (!parsed.success) return [];
      return parsed.data.byRule.map((row) => `${row.decision} · ${row.ruleId} · ${row.senderClass}: ${row.count}`);
    }
    case "numberingWithoutGaps": {
      const parsed = Numbering.safeParse(detail);
      return parsed.success ? [d.numbering(parsed.data.first, parsed.data.last)] : [];
    }
    case "resolvedWithoutHumanPctWeighted":
    case "answeredOnTimeWithProofPctWeighted":
      return Mix.safeParse(detail).success ? [d.mix] : [];
    default:
      return [];
  }
}

/** "3 por tipo" when every type of the batch has the same count, else "TYPE: n" for each. */
export function perTypeText(perType: KpiSummary["perType"]): string {
  const counts = Object.entries(perType ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  if (counts.length === 0) return "";
  const first = counts[0]?.[1];
  if (counts.every(([, count]) => count === first) && first !== undefined) return metricsCopy.batch.perType(first);
  return counts.map(([type, count]) => `${type}: ${count}`).join(", ");
}

/** The cost per complaint of a tab, when it has a number to compare with the manual assumption. */
export function costPerComplaint(summary: Pick<KpiSummary, "kpis">): number | undefined {
  const cost = summary.kpis.find((kpi) => kpi.key === "costPerComplaintUsd");
  return typeof cost?.value === "number" ? cost.value : undefined;
}

/** A typed amount, or `undefined` while it is empty or not a non-negative number. */
export function assumptionOf(typed: string): number | undefined {
  const value = Number(typed.trim().replace(",", "."));
  return typed.trim() === "" || !Number.isFinite(value) || value < 0 ? undefined : value;
}
