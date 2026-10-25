import { describe, expect, it } from "vitest";
import { PAYER_NUMBER_MASK, candidateOf, checkOperationCode, luhnDigit, paidAtInstant, pesosToCents, safePayerReference, validateFields } from "./validate";
import { clearReading } from "./testing";

const SIM_NOW = new Date("2026-10-07T10:10:00-03:00");
const VALID = { network: "SUR", operationCode: "SUR-20261002-004211-7", amount: 11_864_000, paidAtLocal: "2026-10-02T11:20", payerReference: "cus-0004" };

describe("operation code and check digit [FL-020]", () => {
  it("[FL-020] computes the Luhn digit over the 14 digits as the networks do", () => {
    expect(luhnDigit("20261007912345")).toBe(3);
    expect(luhnDigit("20261002004211")).toBe(7);
    expect(() => luhnDigit("2026-10")).toThrow(RangeError);
  });

  it("[FL-020] accepts a code with its network prefix, an existing date and a valid digit", () => {
    expect(checkOperationCode("SUR-20261002-004211-7")).toEqual({ ok: true, prefix: "SUR", date: "2026-10-02" });
    expect(checkOperationCode("NTE-20261007-912345-3")).toMatchObject({ ok: true, prefix: "NTE" });
    expect(checkOperationCode("BIL-20261005-000123-1")).toMatchObject({ ok: true, prefix: "BIL" });
  });

  it("[FL-020] refuses an invalid check digit and an impossible format", () => {
    expect(checkOperationCode("SUR-20261002-004211-2")).toEqual({ ok: false, problem: "INVALID_CHECK_DIGIT" });
    expect(checkOperationCode("XYZ-20261002-004211-7")).toEqual({ ok: false, problem: "INVALID_FORMAT" });
    expect(checkOperationCode("SUR-20261302-004211-7")).toEqual({ ok: false, problem: "INVALID_FORMAT" });
    expect(checkOperationCode("SUR-2026100-004211-7")).toEqual({ ok: false, problem: "INVALID_FORMAT" });
    expect(checkOperationCode("sur-20261002-004211-7")).toEqual({ ok: false, problem: "INVALID_FORMAT" });
  });
});

describe("fields of a reading [FL-020]", () => {
  it("[FL-020] a valid reading becomes fields in centavos with the printed local time", () => {
    expect(validateFields(VALID, SIM_NOW)).toEqual({ ok: true, fields: VALID });
  });

  it("[FL-020] a fake receipt with an invalid digit is INVALID_CHECK_DIGIT, never a reading", () => {
    expect(validateFields({ ...VALID, operationCode: "SUR-20261002-004211-2" }, SIM_NOW)).toEqual({ ok: false, problem: "INVALID_CHECK_DIGIT" });
  });

  it("[FL-020] the network must agree with the prefix, and a transfer has no code of ours", () => {
    expect(validateFields({ ...VALID, network: "NORTE" }, SIM_NOW)).toEqual({ ok: false, problem: "NETWORK_MISMATCH" });
    expect(validateFields({ ...VALID, network: "TRANSFER" }, SIM_NOW)).toEqual({ ok: false, problem: "NETWORK_MISMATCH" });
    expect(validateFields({ ...VALID, network: "BANCO" }, SIM_NOW)).toEqual({ ok: false, problem: "NETWORK_MISMATCH" });
    // An unknown network on the paper is taken from the prefix.
    expect(validateFields({ ...VALID, network: "UNKNOWN" }, SIM_NOW)).toMatchObject({ ok: true, fields: { network: "SUR" } });
  });

  it("[FL-020] a payment after the world's simulated now cannot be, whatever the machine clock says", () => {
    expect(validateFields({ ...VALID, paidAtLocal: "2026-10-07T10:11" }, SIM_NOW)).toEqual({ ok: false, problem: "FUTURE_DATE" });
    expect(validateFields({ ...VALID, paidAtLocal: "2026-10-07T10:10" }, SIM_NOW)).toMatchObject({ ok: true });
  });

  it("[FL-020] the amount is positive and at most $ 5.000.000", () => {
    expect(validateFields({ ...VALID, amount: 0 }, SIM_NOW)).toEqual({ ok: false, problem: "AMOUNT_OUT_OF_RANGE" });
    expect(validateFields({ ...VALID, amount: 500_000_001 }, SIM_NOW)).toEqual({ ok: false, problem: "AMOUNT_OUT_OF_RANGE" });
    expect(validateFields({ ...VALID, amount: 500_000_000 }, SIM_NOW)).toMatchObject({ ok: true });
  });

  it("[FL-020] a missing code, amount or date is INCOMPLETE, never guessed", () => {
    const { operationCode: _code, ...noCode } = VALID;
    const { amount: _amount, ...noAmount } = VALID;
    expect(validateFields(noCode, SIM_NOW)).toEqual({ ok: false, problem: "INCOMPLETE" });
    expect(validateFields(noAmount, SIM_NOW)).toEqual({ ok: false, problem: "INCOMPLETE" });
    expect(validateFields({ ...VALID, paidAtLocal: "" }, SIM_NOW)).toEqual({ ok: false, problem: "INCOMPLETE" });
  });

  it("[FL-020] an impossible printed time is a format problem", () => {
    expect(paidAtInstant("2026-02-30T10:00")).toBeUndefined();
    expect(paidAtInstant("2026-10-02T24:00")).toBeUndefined();
    expect(paidAtInstant("2026-10-02T11:20")?.toISOString()).toBe("2026-10-02T14:20:00.000Z");
    expect(validateFields({ ...VALID, paidAtLocal: "2026-02-30T10:00" }, SIM_NOW)).toEqual({ ok: false, problem: "INVALID_FORMAT" });
  });

  it("converts pesos to exact centavos and refuses anything that is not pesos with cents", () => {
    expect(pesosToCents(118_640)).toBe(11_864_000);
    expect(pesosToCents(118_640.5)).toBe(11_864_050);
    expect(pesosToCents("118640.00")).toBe(11_864_000);
    expect(pesosToCents(10.123)).toBeUndefined();
    expect(pesosToCents(-1)).toBeUndefined();
    expect(pesosToCents("118.640,00")).toBeUndefined();
  });
});

describe("the payer reference read from a hostile image", () => {
  it.each([
    ["a DNI", "Pagador: DNI 30.123.456", "30.123.456"],
    ["a CUIT", "CUIT 20-30123456-7", "20-30123456-7"],
    ["a CBU", "CBU 0110599940000041234567", "0110599940000041234567"],
    ["a card", "Tarjeta 4111 1111 1111 1111", "4111 1111 1111 1111"],
    ["an email", "titular success+qa-payer@simulator.amazonses.com", "success+qa-payer@simulator.amazonses.com"],
    ["a number cut at 64 characters", `${"x".repeat(52)} 0110599940`, "0110599940"],
  ])("masks %s before it becomes a field", (_label, printed, secret) => {
    const checked = validateFields({ ...VALID, payerReference: printed }, SIM_NOW);
    expect(checked.ok).toBe(true);
    const kept = checked.ok ? (checked.fields.payerReference ?? "") : "";
    expect(kept).not.toContain(secret);
    expect(kept.length).toBeLessThanOrEqual(64);
    expect(candidateOf(clearReading({ payerReference: printed })).payerReference ?? "").not.toContain(secret);
  });

  it("keeps a customer or loan reference as printed and drops an empty one", () => {
    expect(safePayerReference("cus-0004")).toBe("cus-0004");
    expect(safePayerReference("Préstamo L-0010")).toBe("Préstamo L-0010");
    expect(safePayerReference("   ")).toBeUndefined();
    expect(safePayerReference("ref 1234567890")).toBe(`ref ${PAYER_NUMBER_MASK}`);
  });
});
