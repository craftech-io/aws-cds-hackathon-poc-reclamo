import { describe, expect, it } from "vitest";
import { brokenSeqOf, complaintNumberOf, latestPageStart, pageWindow, registerDetail, seqList, shortHash, verificationHeadline } from "./register-model";

const base = { brokenAt: null, unanchored: [] as number[], anchorConflicts: [] as number[] };

describe("chain verification headline [FL-096]", () => {
  it("says Verificada only for a chain whose every entry has its anchor", () => {
    expect(verificationHeadline({ ...base, result: "ok" })).toEqual({ text: "Verificada", gloss: "Verified", tone: "success" });
  });

  it("says Parcial with how many entries have no anchor, never Verificada", () => {
    expect(verificationHeadline({ ...base, result: "partial", unanchored: [41, 42, 43] })).toMatchObject({ text: "Parcial: 3 entradas sin ancla", tone: "warning" });
    expect(verificationHeadline({ ...base, result: "partial", unanchored: [9] }).text).toBe("Parcial: 1 entrada sin ancla");
  });

  it("says Rota en seq N at the break, or at the first anchor conflict", () => {
    expect(verificationHeadline({ ...base, result: "broken", brokenAt: 7 })).toMatchObject({ text: "Rota en seq 7", gloss: "Broken at seq 7", tone: "danger" });
    expect(verificationHeadline({ ...base, result: "broken", anchorConflicts: [12, 30] }).text).toBe("Rota en seq 12");
    expect(brokenSeqOf({ ...base, result: "broken" })).toBeUndefined();
    expect(verificationHeadline({ ...base, result: "broken" }).text).toBe("Rota");
  });
});

describe("register paging", () => {
  it("opens on the newest page and moves by pages without leaving the chain", () => {
    expect(latestPageStart(861)).toBe(762);
    expect(latestPageStart(40)).toBe(1);
    expect(pageWindow(762, 861)).toEqual({ from: 762, to: 861, earlier: 662, later: undefined });
    expect(pageWindow(1, 861)).toEqual({ from: 1, to: 100, earlier: undefined, later: 101 });
    expect(pageWindow(50, 120)).toEqual({ from: 50, to: 120, earlier: 1, later: undefined });
    expect(pageWindow(1, 0)).toEqual({ from: 1, to: 0, earlier: undefined, later: undefined });
  });

  it("accepts only a complaint number of the R-AAAA-NNNNNN form", () => {
    expect(complaintNumberOf(" r-2026-000123 ")).toBe("R-2026-000123");
    expect(complaintNumberOf("2026-000123")).toBeUndefined();
    expect(complaintNumberOf("R-2026-123")).toBeUndefined();
  });
});

describe("register rows", () => {
  it("shortens hashes and long seq lists for the eye, keeping the full value elsewhere", () => {
    expect(shortHash("e93d841488b4c2d52ae740ac93675ee5")).toBe("e93d841488b4…");
    expect(shortHash(null)).toBe("—");
    expect(seqList([])).toBe("—");
    expect(seqList(Array.from({ length: 14 }, (_, index) => index + 1))).toBe("1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 (+2)");
  });

  it("describes a filing with its kind, type, reason and the masked presenter, never repeating the type as the reason", () => {
    const filing = {
      worldId: "demo",
      epoch: 1,
      seq: 1,
      prevHash: "0",
      hash: "h",
      atSim: "2026-01-06T15:12:00-03:00",
      atReal: "2026-01-06T18:12:00.000Z",
      createdAt: "2026-10-09T19:27:09.793Z",
      updatedAt: "2026-10-09T19:27:09.793Z",
      eventType: "FILED",
      complaintId: "cmp-h000001",
      complaintNumber: "R-2026-000001",
      kind: "RECLAMO",
      type: "DATA_CHANGE",
      channel: "WHATSAPP",
      origin: "SEED",
      reason: "corrección de datos",
      presenter: { docType: "DNI", docNumberMasked: "••••1069" },
    } as const;
    expect(registerDetail(filing)).toBe("Reclamo · Corrección de datos · Presentó: DNI ••••1069");
    expect(registerDetail({ ...filing, reason: "Corrección de datos." })).toBe("Reclamo · Corrección de datos · Presentó: DNI ••••1069");
    expect(registerDetail({ ...filing, reason: "cambió de domicilio y pide actualizarlo" })).toBe("Reclamo · Corrección de datos · cambió de domicilio y pide actualizarlo · Presentó: DNI ••••1069");
  });
});
