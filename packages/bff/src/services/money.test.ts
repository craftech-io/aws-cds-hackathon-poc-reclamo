import { describe, expect, it } from "vitest";
import { amountsIn, formatPesos, numberTokens, parsePesos, pesosFromCents, sumCents } from "./money";

describe("money (es-AR, no Intl)", () => {
  it("formats centavos with dots for thousands and a comma for decimals", () => {
    expect(formatPesos(11_864_000)).toBe("$ 118.640,00");
    expect(formatPesos(250_000)).toBe("$ 2.500,00");
    expect(formatPesos(5)).toBe("$ 0,05");
    expect(formatPesos(-123_456)).toBe("-$ 1.234,56");
    expect(pesosFromCents(14_630_000)).toEqual({ amount: 146_300, text: "$ 146.300,00" });
  });

  it("parses what it formats, and nothing else", () => {
    for (const cents of [0, 5, 250_000, 11_864_000, 96_000_000]) expect(parsePesos(formatPesos(cents))).toBe(cents);
    expect(parsePesos("$118.640")).toBe(11_864_000);
    expect(parsePesos("118.640,00")).toBe(11_864_000);
    expect(parsePesos("118,640.00")).toBeUndefined();
    expect(parsePesos("1.23")).toBeUndefined();
    expect(parsePesos("")).toBeUndefined();
  });

  it("finds the amounts of a text but not years, instalments or times", () => {
    const text = "Tu cuota 4 de $ 118.640,00 vencía el 05/10/2026; el cargo de $2.500 se revierte y quedan 960.000,00 a las 10:10.";
    expect(amountsIn(text)).toEqual([11_864_000, 250_000, 96_000_000]);
    expect(amountsIn("Reclamo R-2026-000001 del año 2026, cuota 12")).toEqual([]);
  });

  it("reads a plain number next to a currency sign or word as an amount", () => {
    expect(amountsIn("Te reintegramos 3500 pesos hoy")).toEqual([350_000]);
    expect(amountsIn("Te reintegramos ARS 3500 hoy")).toEqual([350_000]);
    expect(amountsIn("Te reintegramos 3,5 mil pesos")).toEqual([350_000]);
    expect(amountsIn("Son 250 mil")).toEqual([25_000_000]);
    expect(amountsIn("unos 1,5 millones de pesos")).toEqual([150_000_000]);
    expect(amountsIn("$3500 y $ 3.500")).toEqual([350_000, 350_000]);
    expect(amountsIn("3500$, un peso 1 y pesos 20")).toEqual([350_000, 100, 2_000]);
    expect(amountsIn("total:3500 pesos, antes,3500 ARS")).toEqual([350_000, 350_000]);
    expect(amountsIn("US style $3,500.00")).toEqual([350_000]);
    expect(amountsIn("Pasaron 3 milagros y 10 minutos")).toEqual([]);
  });

  it("keeps the digits of every number for the bare-number check", () => {
    expect(numberTokens("R-2026-000001, 05/10/2026, $ 3.500,00 y 10:10")).toEqual([
      { raw: "2026", digits: "2026" },
      { raw: "000001", digits: "000001" },
      { raw: "05", digits: "05" },
      { raw: "10", digits: "10" },
      { raw: "2026", digits: "2026" },
      { raw: "3.500,00", digits: "350000", cents: 350_000 },
      { raw: "10", digits: "10" },
      { raw: "10", digits: "10" },
    ]);
  });

  it("reads figures as the reader sees them and marks other currencies unverifiable", () => {
    expect(amountsIn("Te reintegramos 3 500 pesos y ３００ pesos")).toEqual([350_000, 30_000]);
    expect(amountsIn("999 en pesos, 2 lucas y 1,5k")).toEqual([99_900, 200_000, 150_000]);
    expect(amountsIn("cuota 4 de $ 500")).toEqual([50_000]);
    expect(numberTokens("USD 999 y 5 euros")).toEqual([
      { raw: "999", digits: "999", unverifiable: true },
      { raw: "5", digits: "5", unverifiable: true },
    ]);
  });

  it("sums exactly and refuses fractions of a centavo", () => {
    expect(sumCents([11_864_000, 250_000, 1])).toBe(12_114_001);
    expect(() => sumCents([0.5])).toThrow(RangeError);
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});
