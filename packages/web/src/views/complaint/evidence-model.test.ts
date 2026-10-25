import { describe, expect, it } from "vitest";
import { type EvidenceView, bytesOfBase64, evidenceGroups, inlineBlob, readingOf } from "./evidence-model";
import { evidenceRows } from "./evidence-rows";

describe("receipt evidence [FL-017]", () => {
  it("[FL-017] an inline seed receipt becomes a PNG blob of its exact bytes", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const blob = inlineBlob({ kind: "INLINE", evidenceId: "evd-1", contentType: "image/png", sha256: "f".repeat(64), dataBase64: Buffer.from(png).toString("base64") });
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
    expect(bytesOfBase64("AAE=")).toEqual(Uint8Array.from([0, 1]));
  });

  it("[FL-017] refuses an inline file that is not an image", () => {
    expect(() => inlineBlob({ kind: "INLINE", evidenceId: "evd-1", contentType: "text/html" as "image/png", sha256: "f".repeat(64), dataBase64: "AAE=" })).toThrow();
  });

  it("[FL-017] parses a reading with the reader's own schema: fields, source and fallback", () => {
    const reading = readingOf({
      kind: "RECEIPT_READING",
      details: {
        result: "READ",
        source: "BOTH_AGREE",
        fields: { network: "NORTE", operationCode: "NTE-20261006-184012-7", amount: 11864000, paidAtLocal: "2026-10-06T18:40" },
        bedrock: { legibility: "CLEAR", isReceipt: true },
        fallback: { present: true, agrees: true },
      },
    });
    expect(reading?.source).toBe("BOTH_AGREE");
    expect(reading?.fields?.amount).toBe(11864000);
    expect(readingOf({ kind: "RECEIPT_READING", details: { result: "nonsense" } })).toBeUndefined();
    expect(readingOf({ kind: "SETTLEMENT_MATCH", details: {} })).toBeUndefined();
  });

  it("[FL-017] puts each reading right after its receipt image; a reading of an image not in the case stands alone", () => {
    const at = "2026-10-07T10:10:00-03:00";
    const image = { evidenceId: "evd-img", kind: "RECEIPT_IMAGE", atSim: at, details: {} };
    const settlement = { evidenceId: "evd-rcn", kind: "SETTLEMENT_MATCH", atSim: at, details: { result: "MATCHED" } };
    const reading = { evidenceId: "evd-rdg", kind: "RECEIPT_READING", atSim: at, details: { result: "READ", source: "BEDROCK", imageEvidenceId: "evd-img" } };
    const orphan = { evidenceId: "evd-rdg-2", kind: "RECEIPT_READING", atSim: at, details: { result: "READ", source: "BEDROCK", imageEvidenceId: "evd-gone" } };
    const groups = evidenceGroups([image, settlement, reading, orphan] as unknown as EvidenceView[]);
    expect(groups.map((group) => [group.evidence.evidenceId, group.readings.map((one) => one.evidenceId)])).toEqual([
      ["evd-img", ["evd-rdg"]],
      ["evd-rcn", []],
      ["evd-rdg-2", []],
    ]);
  });
});

describe("evidence rows in words [FL-017]", () => {
  it("[FL-017] a matched settlement line: result, network, settlement date, amount, customer, loan and instalment, operation code; no reading id, no files reviewed", () => {
    const rows = evidenceRows("SETTLEMENT_MATCH", {
      result: "MATCHED",
      source: "SETTLEMENT",
      readingId: "rdg-01M4ABC",
      network: "NORTE",
      operationCode: "NTE-20261006-184012-7",
      reviewed: [{ network: "NORTE", businessDate: "2026-10-06", status: "PUBLISHED", sha256: "a".repeat(64) }],
      line: { network: "NORTE", businessDate: "2026-10-06", operationCode: "NTE-20261006-184012-7", paidAt: "2026-10-06T18:40:00-03:00", amount: 11864000, customerRef: "cus-0001", loanRef: "L-0001", instalment: 4, batchSha256: "b".repeat(64) },
    });
    expect(rows).toEqual([
      { label: "Resultado", value: "Coincide" },
      { label: "Fuente", value: "Archivo de rendición de la red" },
      { label: "Red", value: "Red de cobro Norte" },
      { label: "Fecha de rendición", value: "mar 06/10" },
      { label: "Pagado", value: "mar 06/10 18:40" },
      { label: "Monto", value: "$ 118.640,00" },
      { label: "Cliente", value: "cus-0001", code: true },
      { label: "Préstamo y cuota", value: "L-0001 · cuota 4", code: true },
      { label: "Código de operación", value: "NTE-20261006-184012-7", code: true },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/rdg-|PUBLISHED|MATCHED|readingId|reviewed/);
  });

  it("[FL-017] a pending batch says when the network settles", () => {
    const rows = evidenceRows("SETTLEMENT_MATCH", { result: "PENDING_BATCH", source: "SETTLEMENT", network: "NORTE", pending: { network: "NORTE", businessDate: "2026-10-07", publishAtSim: "2026-10-08T08:30:00-03:00" } });
    expect(rows[0]).toEqual({ label: "Resultado", value: "Lote pendiente: la red rinde el jue 08/10 08:30" });
  });

  it("[FL-032] any other evidence goes through Spanish labels, amounts in pesos and values in words; unknown keys stay out", () => {
    expect(evidenceRows("CHARGE_CHECK", { chargeId: "CHG-1", verdict: "CORRECT", charged: 250000, internalFlag: "x", chargedAtSim: "2026-09-20T09:00:00-03:00" })).toEqual([
      { label: "Cargo", value: "CHG-1", code: true },
      { label: "Resultado del control", value: "Correcto" },
      { label: "Cobrado", value: "$ 2.500,00" },
      { label: "Cobrado el", value: "dom 20/09 09:00" },
    ]);
  });
});
