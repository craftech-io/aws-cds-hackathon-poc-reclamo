// KPIs of the metrics view (docs/design-brief.md §11, FL-098, FL-079): every KPI has its N, source and
// label; nothing seeded is ever measured; the batch has a raw and a weighted figure; the simulated load
// shows only mechanics. Synthetic data only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ComplaintType } from "@reclamo/shared";
import { SIM_NOW, TEST_NOW, auditEntry, complaint as complaintRow, tapeEntry, testConnector, worldSettings } from "../connector/testing";
import { Complaint } from "../domain/complaint";
import type { ComplaintKpi } from "../domain/metrics";
import { ASSUMED_TYPE_MIX, RATE_CARD_REFERENCE, type RateCard, complaintCost } from "./assumptions";
import { batchSummary, seededHistoryBox, simulatedLoadSummary, weightedByMix, worldSummary } from "./kpis";
import { exportRows, metricsSummary } from "./load";
import { type RunRecord, publishRun } from "./runs";
import type { Kpi, KpiSummary } from "./types";
import { factsOfRow } from "./facts";

const SEED = new URL("../../../../scripts/seed/data/", import.meta.url);
const CARD: RateCard = RateCard_();
function RateCard_(): RateCard {
  return { version: "rc-test", status: "supuesto · sin verificar", model: "test-model", usdPerMillionTokens: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, usdPerEmail: 0.0001, usdPerWhatsAppMessage: 0.01 };
}
const SETTINGS = { ...worldSettings("demo"), manualBaseline: { items: [{ action: "ANSWER", minutes: 12, label: "supuesto" as const }, { action: "APPROVE", minutes: 5, label: "supuesto" as const }] } };

let numbered = 0;
const live = (id: string, overrides: Partial<Complaint> = {}): Complaint =>
  Complaint.parse({ ...complaintRow("demo", { complaintId: id, complaintNumber: `R-2026-${String((numbered += 1)).padStart(6, "0")}` }), version: 1, ...overrides });
const answered = (sentAtSim: string, proof: "DELIVERED" | "SENT" = "DELIVERED") => ({ status: "ANSWERED" as const, answer: { messageId: "msg-a", mailId: "mail-a", sentAtSim, deliveryProof: proof }, statusHistory: [{ from: null, to: "REGISTERED" as const, atSim: SIM_NOW, cause: "FILED", actor: "SYSTEM" as const }, { from: "RESOLVED" as const, to: "ANSWERED" as const, atSim: sentAtSim, cause: "WRITTEN_ANSWER_SENT", actor: "AGENT" as const }] });
const row = (complaintId: string, overrides: Partial<ComplaintKpi> = {}): ComplaintKpi => ({ worldId: "demo", source: "WORLD", runId: "world", complaintId, agentMode: "REAL", origin: "LIVE", humanActions: [], tokens: { in: 10_000, out: 1_000, cached: 0 }, messages: { wa: 2, email: 1 }, ...overrides });
const byKey = (summary: KpiSummary, key: Kpi["key"]) => summary.kpis.find((item) => item.key === key);

function worldInput(complaints: Complaint[], rows: ComplaintKpi[] = []) {
  return { worldId: "demo", complaints, rows, violations: 0, decisions: [], settings: SETTINGS, rateCard: CARD, whatsappSimulated: true };
}

describe("metrics: this world, measured [FL-098]", () => {
  it("[FL-098] every KPI says its value, N, source and label; only LIVE complaints are measured", () => {
    const seeded = live("cmp-s1", { origin: "SEED", ...answered("2026-10-08T10:00:00-03:00") });
    const summary = worldSummary(worldInput([seeded, live("cmp-01", answered("2026-10-08T10:00:00-03:00")), live("cmp-02")], [row("cmp-01", { ackLatencyMs: 2_100 }), row("cmp-02", { ackLatencyMs: 3_900 })]));
    expect(summary).toMatchObject({ tab: "WORLD", label: "MEASURED", n: 2 });
    for (const item of summary.kpis) {
      expect(Object.keys(item)).toEqual(expect.arrayContaining(["key", "value", "n", "source", "label"]));
    }
    expect(byKey(summary, "timeToNumberP50Ms")).toMatchObject({ value: 2_100, n: 2, label: "MEASURED", source: { kind: "WORLD", ref: "demo" }, detail: { measuredUntil: "TRANSPORT_ACCEPTANCE_SIMULATED_WHATSAPP" } });
    expect(byKey(summary, "timeToNumberP95Ms")).toMatchObject({ value: 3_900 });
    expect(byKey(summary, "resolvedWithoutHumanPct")).toMatchObject({ value: 100, n: 1 });
    expect(summary.seededHistory).toEqual({ total: 1, byStatus: { ANSWERED: 1 }, byType: { PAYMENT_NOT_REFLECTED: 1 }, answered: 1, answeredOnTime: 1, withDeliveryProof: 1, measuredN: 2 });
  });

  it("[FL-098] a world whose turns ran with the scripted agent never shows a measured latency, cost or share: n/a — agente guionado", () => {
    const summary = worldSummary(worldInput([live("cmp-01", answered("2026-10-08T10:00:00-03:00"))], [row("cmp-01", { ackLatencyMs: 0, agentMode: "SCRIPTED" })]));
    expect(summary).toMatchObject({ tab: "WORLD", label: "SCRIPTED_AGENT", n: 1 });
    for (const key of ["timeToNumberP50Ms", "timeToNumberP95Ms", "costPerComplaintUsd", "humanMinutesPerComplaint", "resolvedWithoutHumanPct"] as const) {
      expect(byKey(summary, key)).toMatchObject({ value: null, label: "NOT_APPLICABLE_SCRIPTED", gap: "NOT_APPLICABLE" });
    }
    expect(summary.kpis.some((item) => item.label === "MEASURED")).toBe(false);
    expect(byKey(summary, "policyViolations")).toMatchObject({ value: 0, label: "SCRIPTED_AGENT" });
  });

  it("[FL-098] a fresh world measures nothing: N = 0, no number, the template only in its box (the qa-min template matches the seed manifest)", () => {
    const template = JSON.parse(readFileSync(new URL("worlds/qa-min.json", SEED), "utf8")) as { items: { entity: string; data: Record<string, unknown> }[] };
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", SEED), "utf8")) as { facts: { qaMinSeededHistory: unknown } };
    const complaints = template.items.filter((item) => item.entity === "Complaint").map((item) => Complaint.parse({ ...item.data, worldId: "qamin", epoch: 1, synthetic: true }));
    const summary = worldSummary({ ...worldInput(complaints), worldId: "qamin" });
    expect(summary.n).toBe(0);
    expect(summary.seededHistory).toEqual(manifest.facts.qaMinSeededHistory);
    expect(seededHistoryBox(complaints).measuredN).toBe(0);
    for (const key of ["timeToNumberP50Ms", "resolvedWithoutHumanPct", "answeredOnTimeWithProofPct", "costPerComplaintUsd", "humanMinutesPerComplaint"] as const) {
      expect(byKey(summary, key)).toMatchObject({ value: null, n: 0, gap: "NO_DATA" });
    }
  });

  it("[FL-079] an OVERDUE complaint counts against '% en plazo' only when it is LIVE; a late or unproven answer does too", () => {
    const summary = worldSummary(
      worldInput([
        live("cmp-01", answered("2026-10-20T10:00:00-03:00")),
        live("cmp-02", { slaState: "OVERDUE" }),
        live("cmp-03", answered("2026-10-23T10:00:00-03:00")),
        live("cmp-04", answered("2026-10-21T10:00:00-03:00", "SENT")),
        live("cmp-05"),
        live("cmp-s1", { origin: "SEED", slaState: "OVERDUE" }),
      ]),
    );
    expect(byKey(summary, "answeredOnTimeWithProofPct")).toMatchObject({ value: 25, n: 4, detail: { overdue: 1, answeredLate: 1, withoutProof: 1 } });
  });

  it("[FL-098] a person involved (review, approval, take-over, hand-off) is not 'resolved without a person'", () => {
    const viaHuman = { ...answered("2026-10-09T10:00:00-03:00") };
    const summary = worldSummary(
      worldInput([
        live("cmp-01", viaHuman),
        live("cmp-02", { ...viaHuman, statusHistory: [...viaHuman.statusHistory, { from: "INVESTIGATING", to: "HUMAN_REVIEW", atSim: SIM_NOW, cause: "HANDOFF", actor: "AGENT" }] }),
        live("cmp-03", { ...viaHuman, control: "OPERATOR" }),
        live("cmp-04", { ...viaHuman, handoff: { reason: "CUSTOMER_ASKED", atSim: SIM_NOW } }),
      ]),
    );
    expect(byKey(summary, "resolvedWithoutHumanPct")).toMatchObject({ value: 25, n: 4 });
  });

  it("[FL-098] violations, the gate's decisions by rule, human minutes and the cost are labelled by what they rest on", () => {
    const summary = worldSummary({
      ...worldInput([live("cmp-01")], [row("cmp-01", { humanActions: ["ANSWER", "APPROVE"] })]),
      violations: 0,
      decisions: [
        { decision: "ALLOWED", ruleId: "ALL_RULES_PASSED", senderClass: "AGENT", count: 7 },
        { decision: "BLOCKED", ruleId: "CH-WA-NO-COLLECTION", senderClass: "OPERATOR", count: 1 },
      ],
    });
    expect(byKey(summary, "policyViolations")).toMatchObject({ value: 0, source: { kind: "POLICY_AUDIT" }, label: "MEASURED" });
    expect(byKey(summary, "gateDecisions")).toMatchObject({ value: 1, n: 8, source: { kind: "TAPE" }, detail: { byRule: [{ ruleId: "CH-WA-NO-COLLECTION", senderClass: "OPERATOR", count: 1 }] } });
    expect(byKey(summary, "humanMinutesPerComplaint")).toMatchObject({ value: 17, label: "ASSUMPTION", source: { kind: "WORLD_SETTINGS" } });
    const cost = complaintCost(CARD, { tokens: { in: 10_000, out: 1_000, cached: 0 }, messages: { wa: 2, email: 1 } });
    expect(cost.total).toBeCloseTo(0.0501, 6);
    expect(byKey(summary, "costPerComplaintUsd")).toMatchObject({ value: 0.0501, label: "ASSUMPTION", detail: { rateCardVersion: "rc-test" } });
    expect(byKey(worldSummary({ ...worldInput([live("cmp-01")]), rateCard: undefined }), "costPerComplaintUsd")).toMatchObject({ value: null, gap: "NO_DATA" });
  });
});

function run(tab: RunRecord["tab"], overrides: Partial<RunRecord> = {}): RunRecord {
  return { tab, runId: "r1", worldIds: ["sim-r1"], agentMode: tab === "BATCH" ? "REAL" : "SCRIPTED", ranAtReal: TEST_NOW.toISOString(), inputs: 30, policyViolations: 0, decisions: [{ decision: "ALLOWED", ruleId: "ALL_RULES_PASSED", senderClass: "SYSTEM", count: 60 }], ...overrides };
}

describe("metrics: the real-agent batch, raw and weighted [FL-098]", () => {
  const types = ComplaintType.options.filter((type) => type !== "INFORMATION_REQUEST");
  const rows = types.flatMap((type, t) =>
    [0, 1, 2].map((i) => row(`cmp-${t}${i}`, { worldId: "sim-r1", source: "BATCH", runId: "sim-r1", complaintType: type, resolvedWithoutHuman: i < (type === "PAYMENT_NOT_REFLECTED" ? 3 : 1), answeredOnTime: true, deliveryProof: "DELIVERED" })),
  );

  it("[FL-098] N = 30, 3 per type; the raw figure and the one weighted by the assumed mix, labelled an assumption", () => {
    const summary = batchSummary({ run: run("BATCH"), rows, settings: SETTINGS, rateCard: CARD, whatsappSimulated: true });
    expect(summary).toMatchObject({ tab: "BATCH", n: 30, source: { kind: "BATCH", ref: "r1" } });
    expect(Object.values(summary.perType ?? {})).toEqual(Array(10).fill(3));
    expect(byKey(summary, "resolvedWithoutHumanPct")).toMatchObject({ value: 40, n: 30, label: "MEASURED" });
    const weighted = byKey(summary, "resolvedWithoutHumanPctWeighted");
    const mixOf10 = types.reduce((sum, type) => sum + ASSUMED_TYPE_MIX[type], 0);
    const expected = (ASSUMED_TYPE_MIX.PAYMENT_NOT_REFLECTED * 100 + (mixOf10 - ASSUMED_TYPE_MIX.PAYMENT_NOT_REFLECTED) * (100 / 3)) / mixOf10;
    expect(weighted).toMatchObject({ label: "ASSUMPTION", n: 30 });
    expect(weighted?.value).toBeCloseTo(expected, 1);
    expect(byKey(summary, "answeredOnTimeWithProofPctWeighted")).toMatchObject({ value: 100 });
    expect(byKey(summary, "costPerComplaintUsd")?.detail).toMatchObject({ weighted: expect.any(Number) });
  });

  it("weights only the types present, and gives no number without any", () => {
    const facts = rows.map(factsOfRow);
    expect(weightedByMix(facts.filter((fact) => fact.type === "DATA_CHANGE"), () => 50)).toBe(50);
    expect(weightedByMix([], () => 50)).toBeNull();
  });
});

describe("metrics: the simulated load, mechanics only [FL-098]", () => {
  it("[FL-098] latency, cost, tokens, human minutes and % without a person are n/a — scripted agent; the mechanics are shown", () => {
    const rows = [row("cmp-1", { source: "SIMULATED_LOAD", agentMode: "SCRIPTED", answeredOnTime: true }), row("cmp-2", { source: "SIMULATED_LOAD", agentMode: "SCRIPTED", answeredOnTime: false }), row("cmp-3", { source: "WORLD" })];
    const summary = simulatedLoadSummary({ run: run("SIMULATED_LOAD", { numbering: { first: "R-2026-000001", last: "R-2026-000300", registered: 300, gaps: 0 }, milestones: { scheduled: 900, cancelled: 900, fired: 0 } }), rows, settings: SETTINGS });
    expect(summary).toMatchObject({ tab: "SIMULATED_LOAD", label: "SCRIPTED_AGENT", n: 2 });
    for (const key of ["timeToNumberP50Ms", "timeToNumberP95Ms", "costPerComplaintUsd", "humanMinutesPerComplaint", "resolvedWithoutHumanPct"] as const) {
      expect(byKey(summary, key)).toMatchObject({ value: null, label: "NOT_APPLICABLE_SCRIPTED", gap: "NOT_APPLICABLE" });
    }
    expect(byKey(summary, "numberingWithoutGaps")).toMatchObject({ value: true, n: 300 });
    expect(byKey(summary, "milestonesCancelled")).toMatchObject({ value: 900, detail: { fired: 0 } });
    expect(byKey(summary, "answeredOnTimePct")).toMatchObject({ value: 50, n: 2, label: "SCRIPTED_AGENT" });
    expect(byKey(summary, "policyViolations")).toMatchObject({ value: 0, label: "SCRIPTED_AGENT" });
  });
});

describe("metrics: what the routers read [FL-098]", () => {
  async function stage() {
    const { connector, store } = testConnector();
    await connector.worlds.putSettings(SETTINGS);
    await store.write({ kind: "put", table: "Reference", item: { pk: `REF#${RATE_CARD_REFERENCE.type}#${RATE_CARD_REFERENCE.scope}`, sk: RATE_CARD_REFERENCE.key, ...CARD } });
    return { connector, store };
  }

  it("[FL-098] the world tab reads its complaints, rows, violations and decisions; the run tabs read the latest published run", async () => {
    const { connector, store } = await stage();
    await connector.write(connector.complaints.createOp(complaintRow("demo", { complaintId: "cmp-01" })));
    await connector.metrics.put({ ...row("cmp-01", { ackLatencyMs: 1_800 }) });
    const world = await metricsSummary(connector, { worldId: "demo", epoch: 0, tab: "WORLD" });
    expect(world).toMatchObject({ n: 1 });
    expect(byKey(world, "timeToNumberP50Ms")).toMatchObject({ value: 1_800 });
    expect(byKey(world, "costPerComplaintUsd")).toMatchObject({ label: "ASSUMPTION" });

    expect(await metricsSummary(connector, { worldId: "demo", epoch: 0, tab: "BATCH" })).toMatchObject({ n: 0, kpis: [], source: { ref: "none" } });
    await connector.metrics.put(row("cmp-b1", { worldId: "sim-r1", source: "BATCH", runId: "sim-r1", complaintType: "DATA_CHANGE", resolvedWithoutHuman: true, answeredOnTime: true, deliveryProof: "DELIVERED" }));
    await publishRun(store, run("BATCH"), TEST_NOW);
    const batch = await metricsSummary(connector, { worldId: "demo", epoch: 0, tab: "BATCH" });
    expect(batch).toMatchObject({ n: 1, source: { kind: "BATCH", ref: "r1" } });
    expect(exportRows(batch).find((item) => item.key === "resolvedWithoutHumanPct")).toEqual({ tab: "BATCH", key: "resolvedWithoutHumanPct", value: "100", n: 1, source: "BATCH:r1", label: "MEASURED", gap: "" });
    await expect(metricsSummary(connector, { worldId: "g01", epoch: 0, tab: "WORLD" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("[FL-098] this world counts only the current epoch: the tape and the audit log outlive a reset", async () => {
    const { connector } = await stage();
    const blocked = { decision: "BLOCKED" as const, ruleIds: ["CH-WA-NO-COLLECTION"], sender: "OPERATOR:stf-lucia" as const, kind: "COLLECTION_REMINDER" as const };
    await connector.chains.append({ chain: "TAPE", head: undefined, entry: tapeEntry("demo", 1, { epoch: 1, ...blocked }) });
    await connector.audit.append(auditEntry("demo", { epoch: 1, auditId: "aud-old", action: "VIOLATION", primaryRef: undefined }));
    const reset = await metricsSummary(connector, { worldId: "demo", epoch: 2, tab: "WORLD" });
    expect(reset.n).toBe(0);
    expect(byKey(reset, "policyViolations")).toMatchObject({ value: 0 });
    expect(byKey(reset, "gateDecisions")).toMatchObject({ n: 0 });

    await connector.chains.append({ chain: "TAPE", head: undefined, entry: tapeEntry("demo", 1, { epoch: 2, tapeId: "tape-e2", ...blocked }) });
    await connector.audit.append(auditEntry("demo", { epoch: 2, auditId: "aud-new", action: "VIOLATION", primaryRef: undefined }));
    const current = await metricsSummary(connector, { worldId: "demo", epoch: 2, tab: "WORLD" });
    expect(byKey(current, "policyViolations")).toMatchObject({ value: 1 });
    expect(byKey(current, "gateDecisions")).toMatchObject({ n: 1 });
  });
});
