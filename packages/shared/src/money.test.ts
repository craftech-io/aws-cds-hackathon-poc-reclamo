import { describe, expect, it } from "vitest";
import { Money, formatPesos, pesosFromCents } from "./money";

describe("formatPesos", () => {
  it("writes pesos the way Argentina does, without Intl", () => {
    expect(formatPesos(11_864_000)).toBe("$ 118.640,00");
    expect(formatPesos(0)).toBe("$ 0,00");
    expect(formatPesos(5)).toBe("$ 0,05");
    expect(formatPesos(123_456_789)).toBe("$ 1.234.567,89");
    expect(formatPesos(-123_456)).toBe("-$ 1.234,56");
  });

  it("refuses anything that is not a whole number of centavos", () => {
    expect(() => formatPesos(10.5)).toThrow(RangeError);
    expect(() => formatPesos(Number.NaN)).toThrow(RangeError);
  });
});

describe("pesosFromCents", () => {
  it("returns the amount in pesos and its text, and validates", () => {
    const money = pesosFromCents(11_864_000);
    expect(money).toEqual({ amount: 118_640, text: "$ 118.640,00" });
    expect(Money.parse(pesosFromCents(1_999))).toEqual({ amount: 19.99, text: "$ 19,99" });
  });
});
