import { describe, expect, it } from "vitest";
import { assumptionOf, costPerComplaint, decimal, detailLines, perTypeText, sourceText, valueText } from "./metrics-model";

describe("metrics with N, source and label [FL-098]", () => {
  it("shows a not-applicable KPI as n/a and a missing one as no data, never as zero", () => {
    expect(valueText({ key: "costPerComplaintUsd", value: null, gap: "NOT_APPLICABLE", label: "NOT_APPLICABLE_SCRIPTED" })).toBe("n/a — agente guionado");
    expect(valueText({ key: "timeToNumberP95Ms", value: null, gap: "NO_DATA", label: "MEASURED" })).toBe("Sin datos todavía");
  });

  it("writes each figure in its unit with the es-AR decimal comma", () => {
    expect(valueText({ key: "timeToNumberP95Ms", value: 4321, label: "MEASURED" })).toBe("4,3 s");
    expect(valueText({ key: "resolvedWithoutHumanPct", value: 62.5, label: "MEASURED" })).toBe("62,5 %");
    expect(valueText({ key: "costPerComplaintUsd", value: 0.0912, label: "ASSUMPTION" })).toBe("US$ 0,0912");
    expect(valueText({ key: "humanMinutesPerComplaint", value: 3, label: "ASSUMPTION" })).toBe("3,0 min");
    expect(valueText({ key: "policyViolations", value: 0, label: "MEASURED" })).toBe("0");
    expect(valueText({ key: "numberingWithoutGaps", value: true, label: "SCRIPTED_AGENT" })).toBe("Sí");
    expect(decimal(1234567.891, 2)).toBe("1.234.567,89");
    expect(decimal(-0.5, 1)).toBe("-0,5");
  });

  it("names where a number comes from", () => {
    expect(sourceText({ kind: "WORLD", ref: "demo" })).toBe("mundo demo");
    expect(sourceText({ kind: "BATCH", ref: "sim-batch-1" })).toBe("lote sim-batch-1");
    expect(sourceText({ kind: "POLICY_AUDIT", ref: "demo" })).toBe("auditoría de política · demo");
  });

  it("says the time to number stops at the transport while WhatsApp is simulated, cold starts apart", () => {
    const lines = detailLines({ key: "timeToNumberP50Ms", detail: { measuredUntil: "TRANSPORT_ACCEPTANCE_SIMULATED_WHATSAPP", coldStarts: { n: 2, p50: 6000, p95: 7100 } } });
    expect(lines).toEqual(["Hasta aceptación del transporte (WhatsApp simulado)", "Arranques en frío aparte: 2 (p95 7,1 s)"]);
  });

  it("breaks the cost down and ignores a detail it does not recognise", () => {
    const lines = detailLines({ key: "costPerComplaintUsd", detail: { breakdown: { model: 0.08, email: 0.0001, whatsappValuedAsLive: 0.011 }, rateCardVersion: "rc-1", thresholdUsd: 0.25 } });
    expect(lines[0]).toBe("Desglose por reclamo: Modelos US$ 0,0800 · Emails US$ 0,0001 · WhatsApp valorizado como vivo US$ 0,0110");
    expect(lines).toContain("Umbral fijado: US$ 0,2500");
    expect(detailLines({ key: "costPerComplaintUsd", detail: { unexpected: true } })).toEqual([]);
    expect(detailLines({ key: "gateDecisions", detail: { byRule: [{ decision: "BLOCKED", ruleId: "CH-WA-NO-COLLECTION", senderClass: "OPERATOR", count: 1 }] } })).toEqual(["BLOCKED · CH-WA-NO-COLLECTION · OPERATOR: 1"]);
  });

  it("notes the batch as N per type and reads the cost to compare with the assumption", () => {
    expect(perTypeText({ PAYMENT_NOT_REFLECTED: 3, DUPLICATE_DEBIT: 3 })).toBe("3 por tipo");
    expect(perTypeText({ PAYMENT_NOT_REFLECTED: 3, DUPLICATE_DEBIT: 2 })).toBe("PAYMENT_NOT_REFLECTED: 3, DUPLICATE_DEBIT: 2");
    expect(perTypeText(undefined)).toBe("");
    expect(costPerComplaint({ kpis: [{ key: "costPerComplaintUsd", value: 0.09, n: 30, source: { kind: "BATCH", ref: "b" }, label: "MEASURED" }] })).toBe(0.09);
    expect(costPerComplaint({ kpis: [] })).toBeUndefined();
    expect(assumptionOf("1500")).toBe(1500);
    expect(assumptionOf("2,5")).toBe(2.5);
    expect(assumptionOf("")).toBeUndefined();
    expect(assumptionOf("-1")).toBeUndefined();
  });
});
