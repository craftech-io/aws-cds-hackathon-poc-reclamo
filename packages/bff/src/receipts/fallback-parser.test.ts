import { describe, expect, it } from "vitest";
import { FALLBACK_LIMITS, parseReceiptCode, readFallback } from "./fallback-parser";
import { SUR_FIELDS, jpeg, png, receiptCode, receiptPng } from "./testing";

describe("deterministic fallback of the synthetic receipts [FL-027]", () => {
  it("[FL-027] reads the ReceiptCode chunk without decoding the image", () => {
    expect(readFallback(receiptPng(SUR_FIELDS))).toEqual({
      present: true,
      valid: true,
      candidate: { network: "SUR", operationCode: SUR_FIELDS.operationCode, amount: 11_864_000, paidAtLocal: SUR_FIELDS.paidAtLocal },
    });
  });

  it("[FL-027] a photo without the chunk (blurry and not-receipt variants, any real photo) has no fallback", () => {
    expect(readFallback(png())).toEqual({ present: false, reason: "NO_CHUNK" });
    expect(readFallback(jpeg())).toEqual({ present: false, reason: "NOT_PNG" });
    expect(readFallback(png({ texts: [["Comment", "COMPROBANTE"]] }))).toEqual({ present: false, reason: "NO_CHUNK" });
  });

  it("[FL-027] a chunk whose check does not match its text is not a reading", () => {
    expect(readFallback(png({ texts: [["ReceiptCode", receiptCode(SUR_FIELDS, "00000000")]] }))).toEqual({ present: true, valid: false, reason: "BAD_CHECK" });
    expect(parseReceiptCode("RC1|SUR|SUR-20261002-004211-7|118640|2026-10-02T11:20|abcdef12")).toEqual({ present: true, valid: false, reason: "MALFORMED" });
    expect(parseReceiptCode("RC2|SUR|x|1.00|2026-10-02T11:20|abcdef12")).toEqual({ present: true, valid: false, reason: "MALFORMED" });
  });

  it("[FL-027] a corrupted chunk (bad CRC) is detected, never read", () => {
    expect(readFallback(png({ texts: [["ReceiptCode", receiptCode(SUR_FIELDS)]], badCrc: true }))).toEqual({ present: true, valid: false, reason: "BAD_CRC" });
  });

  it("[FL-027] a tampered chunk reads what the chunk says: the cross-check with Bedrock catches it", () => {
    const tampered = png({ texts: [["ReceiptCode", receiptCode({ ...SUR_FIELDS, amount: "999999.00" })]] });
    expect(readFallback(tampered)).toMatchObject({ present: true, valid: true, candidate: { amount: 99_999_900 } });
  });

  it("[FL-027] the walk is bounded: a truncated file or too many chunks stop it", () => {
    const whole = receiptPng(SUR_FIELDS);
    expect(readFallback(whole.subarray(0, 40))).toEqual({ present: false, reason: "TRUNCATED" });
    const lying = Uint8Array.from(whole);
    // IHDR length rewritten to 2 GB: the walk never reads past the buffer.
    lying.set([0x7f, 0xff, 0xff, 0xff], 8);
    expect(readFallback(lying)).toEqual({ present: false, reason: "TRUNCATED" });
    const many = png({ texts: Array.from({ length: FALLBACK_LIMITS.maxChunks + 1 }, () => ["Comment", "x"] as const) });
    expect(readFallback(many)).toEqual({ present: false, reason: "TOO_MANY_CHUNKS" });
  });
});
