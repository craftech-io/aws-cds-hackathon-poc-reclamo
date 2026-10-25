// KPIs of the metrics view (docs/design-brief.md §11, docs/architecture.md §12, FL-098, FL-079): pure
// functions over what metrics/load.ts reads. One tab, one source: "Este mundo" counts only `origin LIVE`
// complaints and shows the seeded ones in a separate box without rates; the batch shows its raw figure
// and the one weighted by the assumed type mix (labelled an assumption); the simulated load shows only
// the mechanics that are real with a scripted agent and says "n/a — agente guionado" for the rest.
import { ComplaintType } from "@reclamo/shared";
import { senderClassOf } from "../channel-policy/kinds";
import type { Complaint } from "../domain/complaint";
import type { TapeEntry } from "../domain/ledger";
import type { ComplaintKpi } from "../domain/metrics";
import type { WorldSettings } from "../domain/world";
import { ASSUMED_TYPE_MIX, type RateCard, complaintCost, isVerified } from "./assumptions";
import { type ComplaintFacts, factsOfComplaint, factsOfRow, pct, percentile, round } from "./facts";
import type { DecisionCount, RunRecord } from "./runs";
import type { Kpi, KpiLabel, KpiSource, KpiSummary, SeededHistoryBox } from "./types";

/** The scripted agent's numbers that would say something about a real agent: never shown. */
const NOT_APPLICABLE_SCRIPTED = ["timeToNumberP50Ms", "timeToNumberP95Ms", "costPerComplaintUsd", "humanMinutesPerComplaint", "resolvedWithoutHumanPct"] as const;

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/** The "historia sembrada (no medida)" box: what the template brought (invariant 17 of docs/seed-spec.md). */
export function seededHistoryBox(complaints: readonly Complaint[]): SeededHistoryBox {
  const seeded = complaints.filter((complaint) => complaint.origin === "SEED");
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let answered = 0;
  let answeredOnTime = 0;
  let withDeliveryProof = 0;
  for (const complaint of seeded) {
    bump(byStatus, complaint.status);
    bump(byType, complaint.type);
    const sentAt = complaint.answer?.sentAtSim;
    if (sentAt === undefined) continue;
    answered += 1;
    if (Date.parse(sentAt) <= Date.parse(complaint.deadlineSim)) answeredOnTime += 1;
    if (complaint.answer?.deliveryProof === "DELIVERED") withDeliveryProof += 1;
  }
  return { total: seeded.length, byStatus, byType, answered, answeredOnTime, withDeliveryProof, measuredN: complaints.length - seeded.length };
}

/** The gate's decisions that were not a plain `ALLOWED`, by decision, rule and sender class. */
export function decisionCounts(entries: readonly TapeEntry[]): DecisionCount[] {
  const counts = new Map<string, DecisionCount>();
  for (const entry of entries) {
    if (entry.decision === "DISPATCH") continue;
    const ruleId = entry.decision === "ALLOWED" ? "ALL_RULES_PASSED" : (entry.ruleIds[0] ?? "NONE");
    const senderClass = senderClassOf(entry.sender);
    const key = `${entry.decision}#${ruleId}#${senderClass}`;
    const found = counts.get(key);
    counts.set(key, { decision: entry.decision, ruleId, senderClass, count: (found?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
}

function kpi(source: KpiSource, label: KpiLabel, key: Kpi["key"], value: Kpi["value"], n: number, detail?: Kpi["detail"]): Kpi {
  return { key, value, n, source, label, ...(value === null ? { gap: "NO_DATA" as const } : {}), ...(detail === undefined ? {} : { detail }) };
}

function notApplicable(source: KpiSource, key: Kpi["key"]): Kpi {
  return { key, value: null, n: 0, source, label: "NOT_APPLICABLE_SCRIPTED", gap: "NOT_APPLICABLE" };
}

function latencyKpis(source: KpiSource, facts: readonly ComplaintFacts[], whatsappSimulated: boolean): Kpi[] {
  const warm = facts.filter((fact) => fact.ackLatencyMs !== undefined && fact.coldStart !== true).map((fact) => fact.ackLatencyMs as number);
  const cold = facts.filter((fact) => fact.ackLatencyMs !== undefined && fact.coldStart === true).map((fact) => fact.ackLatencyMs as number);
  const detail = {
    measuredUntil: whatsappSimulated ? "TRANSPORT_ACCEPTANCE_SIMULATED_WHATSAPP" : "TRANSPORT_ACCEPTANCE",
    coldStarts: { n: cold.length, p50: cold.length === 0 ? null : percentile(cold, 50), p95: cold.length === 0 ? null : percentile(cold, 95) },
  };
  return [
    kpi(source, "MEASURED", "timeToNumberP50Ms", warm.length === 0 ? null : percentile(warm, 50), warm.length, detail),
    kpi(source, "MEASURED", "timeToNumberP95Ms", warm.length === 0 ? null : percentile(warm, 95), warm.length, detail),
  ];
}

function rateKpis(source: KpiSource, facts: readonly ComplaintFacts[]): Kpi[] {
  const answered = facts.filter((fact) => fact.resolvedWithoutHuman !== undefined);
  const decided = facts.filter((fact) => fact.decided);
  return [
    kpi(source, "MEASURED", "resolvedWithoutHumanPct", pct(answered.filter((fact) => fact.resolvedWithoutHuman === true).length, answered.length), answered.length),
    kpi(source, "MEASURED", "answeredOnTimeWithProofPct", pct(decided.filter((fact) => fact.onTime && fact.withProof).length, decided.length), decided.length, {
      overdue: decided.filter((fact) => !fact.answered).length,
      answeredLate: decided.filter((fact) => fact.answered && !fact.onTime).length,
      withoutProof: decided.filter((fact) => fact.onTime && !fact.withProof).length,
    }),
  ];
}

/** Σ human actions × minutes per action of the world's settings, per complaint (always an assumption). */
function humanMinutesKpi(facts: readonly ComplaintFacts[], settings: Pick<WorldSettings, "worldId" | "manualBaseline">): Kpi {
  const minutes = new Map(settings.manualBaseline.items.map((item) => [item.action, item.minutes]));
  const breakdown: Record<string, { count: number; minutes: number }> = {};
  let total = 0;
  for (const action of facts.flatMap((fact) => fact.humanActions)) {
    const each = minutes.get(action) ?? 0;
    const entry = breakdown[action] ?? { count: 0, minutes: 0 };
    breakdown[action] = { count: entry.count + 1, minutes: entry.minutes + each };
    total += each;
  }
  const value = facts.length === 0 ? null : round(total / facts.length);
  return kpi({ kind: "WORLD_SETTINGS", ref: settings.worldId }, "ASSUMPTION", "humanMinutesPerComplaint", value, facts.length, { breakdown, minutesPerAction: Object.fromEntries(minutes) });
}

function costOf(card: RateCard, fact: ComplaintFacts): number {
  return fact.costUsd ?? complaintCost(card, fact).total;
}

/** Mean of a per-type mean, weighted by the assumed mix over the types present. */
export function weightedByMix(facts: readonly ComplaintFacts[], value: (group: readonly ComplaintFacts[]) => number | null): number | null {
  let sum = 0;
  let weights = 0;
  for (const type of ComplaintType.options) {
    const group = facts.filter((fact) => fact.type === type);
    const mean = group.length === 0 ? null : value(group);
    if (mean === null) continue;
    sum += ASSUMED_TYPE_MIX[type] * mean;
    weights += ASSUMED_TYPE_MIX[type];
  }
  return weights === 0 ? null : round(sum / weights, 4);
}

function costKpi(source: KpiSource, facts: readonly ComplaintFacts[], card: RateCard | undefined, extra: Record<string, unknown> = {}): Kpi {
  if (card === undefined || facts.length === 0) return kpi(source, "ASSUMPTION", "costPerComplaintUsd", null, facts.length);
  const parts = facts.map((fact) => complaintCost(card, fact));
  const mean = (pick: (part: (typeof parts)[number]) => number) => round(parts.reduce((sum, part) => sum + pick(part), 0) / parts.length, 4);
  const value = round(facts.reduce((sum, fact) => sum + costOf(card, fact), 0) / facts.length, 4);
  const detail = { breakdown: { model: mean((part) => part.model), email: mean((part) => part.email), whatsappValuedAsLive: mean((part) => part.whatsapp) }, rateCardVersion: card.version, ...extra };
  return kpi(source, isVerified(card) ? "MEASURED" : "ASSUMPTION", "costPerComplaintUsd", value, facts.length, detail);
}

function decisionsKpi(source: KpiSource, label: KpiLabel, decisions: readonly DecisionCount[]): Kpi {
  const refused = decisions.filter((entry) => entry.decision !== "ALLOWED");
  return kpi(source, label, "gateDecisions", refused.reduce((sum, entry) => sum + entry.count, 0), decisions.reduce((sum, entry) => sum + entry.count, 0), { byRule: refused });
}

function perTypeOf(facts: readonly ComplaintFacts[]): Partial<Record<ComplaintType, number>> {
  const counts: Partial<Record<ComplaintType, number>> = {};
  for (const fact of facts) if (fact.type !== undefined) counts[fact.type] = (counts[fact.type] ?? 0) + 1;
  return counts;
}

export interface WorldTabInput {
  readonly worldId: string;
  readonly complaints: readonly Complaint[];
  /** `Metrics` rows of the world, `source WORLD`. */
  readonly rows: readonly ComplaintKpi[];
  /** `AuditLog VIOLATION` entries of the world. */
  readonly violations: number;
  /** The world's own tape decisions (seeded entries excluded by the loader). */
  readonly decisions: readonly DecisionCount[];
  readonly settings: Pick<WorldSettings, "worldId" | "manualBaseline" | "costPerComplaintThresholdUsd">;
  readonly rateCard?: RateCard;
  readonly whatsappSimulated: boolean;
}

/** "Este mundo (medido)": only `origin LIVE` complaints; the seeded ones only in their box. */
export function worldSummary(input: WorldTabInput): KpiSummary {
  const source: KpiSource = { kind: "WORLD", ref: input.worldId };
  const rows = new Map(input.rows.filter((row) => row.source === "WORLD" && row.origin === "LIVE").map((row) => [row.complaintId, row]));
  const live = input.complaints.filter((complaint) => complaint.origin === "LIVE");
  const facts = live.map((complaint) => factsOfComplaint(complaint, rows.get(complaint.complaintId)));
  const threshold = input.settings.costPerComplaintThresholdUsd;
  const kpis = [
    ...latencyKpis(source, facts, input.whatsappSimulated),
    ...rateKpis(source, facts),
    kpi({ kind: "POLICY_AUDIT", ref: input.worldId }, "MEASURED", "policyViolations", input.violations, input.violations),
    decisionsKpi({ kind: "TAPE", ref: input.worldId }, "MEASURED", input.decisions),
    humanMinutesKpi(facts, input.settings),
    costKpi(source, facts, input.rateCard, threshold === undefined ? {} : { thresholdUsd: threshold }),
  ];
  // A world whose turns ran with the scripted agent (the local flows, the capture world) measured no
  // agent: its latency, cost, human minutes and share without a person are "n/a — agente guionado",
  // and what it did measure is the mechanics, labelled as such (docs/design-brief.md §11).
  const scripted = [...rows.values()].some((row) => row.agentMode === "SCRIPTED");
  if (!scripted) return { tab: "WORLD", label: "MEASURED", source, n: facts.length, seededHistory: seededHistoryBox(input.complaints), kpis };
  const notMeasured: ReadonlySet<string> = new Set(NOT_APPLICABLE_SCRIPTED);
  return {
    tab: "WORLD",
    label: "SCRIPTED_AGENT",
    source,
    n: facts.length,
    seededHistory: seededHistoryBox(input.complaints),
    kpis: kpis.map((one) => (notMeasured.has(one.key) ? notApplicable(one.source, one.key) : one.label === "MEASURED" ? { ...one, label: "SCRIPTED_AGENT" as const } : one)),
  };
}

export interface RunTabInput {
  readonly run: RunRecord;
  /** The run's KPI rows (`source BATCH` or `SIMULATED_LOAD`). */
  readonly rows: readonly ComplaintKpi[];
  readonly settings: Pick<WorldSettings, "worldId" | "manualBaseline">;
  readonly rateCard?: RateCard;
  readonly whatsappSimulated: boolean;
}

/** "Lote · agente real": raw figures and the ones weighted by the assumed type mix (an assumption). */
export function batchSummary(input: RunTabInput): KpiSummary {
  const source: KpiSource = { kind: "BATCH", ref: input.run.runId };
  const facts = input.rows.filter((row) => row.source === "BATCH" && row.agentMode === "REAL").map(factsOfRow);
  const share = (group: readonly ComplaintFacts[], test: (fact: ComplaintFacts) => boolean, among: (fact: ComplaintFacts) => boolean) => {
    const base = group.filter(among);
    return base.length === 0 ? null : (base.filter(test).length / base.length) * 100;
  };
  const weightedResolved = weightedByMix(facts, (group) => share(group, (fact) => fact.resolvedWithoutHuman === true, (fact) => fact.resolvedWithoutHuman !== undefined));
  const weightedOnTime = weightedByMix(facts, (group) => share(group, (fact) => fact.onTime && fact.withProof, (fact) => fact.decided));
  const weightedCost = input.rateCard === undefined ? null : weightedByMix(facts, (group) => group.reduce((sum, fact) => sum + costOf(input.rateCard as RateCard, fact), 0) / group.length);
  const mix = { mix: ASSUMED_TYPE_MIX };
  return {
    tab: "BATCH",
    label: "MEASURED",
    source,
    n: facts.length,
    perType: perTypeOf(facts),
    kpis: [
      ...latencyKpis(source, facts, input.whatsappSimulated),
      ...rateKpis(source, facts),
      kpi(source, "ASSUMPTION", "resolvedWithoutHumanPctWeighted", weightedResolved === null ? null : round(weightedResolved), facts.length, mix),
      kpi(source, "ASSUMPTION", "answeredOnTimeWithProofPctWeighted", weightedOnTime === null ? null : round(weightedOnTime), facts.length, mix),
      kpi({ kind: "POLICY_AUDIT", ref: input.run.runId }, "MEASURED", "policyViolations", input.run.policyViolations, input.run.policyViolations),
      decisionsKpi(source, "MEASURED", input.run.decisions),
      humanMinutesKpi(facts, input.settings),
      costKpi(source, facts, input.rateCard, { weighted: weightedCost, ...(input.run.reportCostUsd === undefined ? {} : { reportCostUsd: input.run.reportCostUsd }) }),
    ],
  };
}

/** "Carga simulada (agente guionado)": only the mechanics; everything about the agent is n/a. */
export function simulatedLoadSummary(input: Omit<RunTabInput, "rateCard" | "whatsappSimulated">): KpiSummary {
  const source: KpiSource = { kind: "SIMULATED_LOAD", ref: input.run.runId };
  const facts = input.rows.filter((row) => row.source === "SIMULATED_LOAD" && row.agentMode === "SCRIPTED").map(factsOfRow);
  const decided = facts.filter((fact) => fact.decided);
  const { numbering, milestones } = input.run;
  return {
    tab: "SIMULATED_LOAD",
    label: "SCRIPTED_AGENT",
    source,
    n: facts.length,
    perType: perTypeOf(facts),
    kpis: [
      ...NOT_APPLICABLE_SCRIPTED.map((key) => notApplicable(source, key)),
      kpi(source, "SCRIPTED_AGENT", "numberingWithoutGaps", numbering === undefined ? null : numbering.gaps === 0, numbering?.registered ?? 0, numbering === undefined ? undefined : { first: numbering.first, last: numbering.last }),
      kpi(source, "SCRIPTED_AGENT", "milestonesScheduled", milestones?.scheduled ?? null, facts.length),
      kpi(source, "SCRIPTED_AGENT", "milestonesCancelled", milestones?.cancelled ?? null, facts.length, milestones === undefined ? undefined : { fired: milestones.fired }),
      decisionsKpi(source, "SCRIPTED_AGENT", input.run.decisions),
      kpi({ kind: "POLICY_AUDIT", ref: input.run.runId }, "SCRIPTED_AGENT", "policyViolations", input.run.policyViolations, input.run.policyViolations),
      kpi(source, "SCRIPTED_AGENT", "answeredOnTimePct", pct(decided.filter((fact) => fact.onTime).length, decided.length), decided.length),
    ],
  };
}
