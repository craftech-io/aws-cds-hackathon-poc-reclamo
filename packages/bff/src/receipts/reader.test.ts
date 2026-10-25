import { describe, expect, it } from "vitest";
import type { BedrockReading } from "./bedrock-reader";
import { isUnavailable, readReceiptImage } from "./reader";
import { SUR_FIELDS, clearReading, jpeg, png, receiptCode, receiptPng, scriptedBedrock, testLog } from "./testing";

const SIM_NOW = new Date("2026-10-07T10:10:00-03:00");
const LEGIBLE = receiptPng(SUR_FIELDS);
const FIELDS = { network: "SUR", operationCode: SUR_FIELDS.operationCode, amount: 11_864_000, paidAtLocal: SUR_FIELDS.paidAtLocal, payerReference: "cus-0004" };

function read(bytes: Uint8Array, ...answers: BedrockReading[]) {
  const bedrock = scriptedBedrock(...answers);
  const { log, lines } = testLog();
  return { bedrock, lines, run: (options: { worldId?: string; forceFallback?: boolean } = {}) => readReceiptImage({ worldId: options.worldId ?? "demo", bytes, contentType: "image/png", simNow: SIM_NOW, ...(options.forceFallback === undefined ? {} : { forceFallback: options.forceFallback }) }, { bedrock, log }) };
}

const ok = (raw = clearReading()): BedrockReading => ({ kind: "READ", raw });
const down: BedrockReading = { kind: "UNAVAILABLE", reason: "THROTTLED", attempts: 3 };

describe("result table of the reader [FL-019] [FL-027] [FL-028] [FL-020]", () => {
  it("[FL-027] Bedrock CLEAR with a valid digit and a chunk that agrees → READ BOTH_AGREE", async () => {
    expect(await read(LEGIBLE, ok()).run()).toEqual({ result: "READ", source: "BOTH_AGREE", fields: FIELDS, fallback: { present: true, agrees: true }, suspiciousText: false, bedrock: { legibility: "CLEAR", isReceipt: true } });
  });

  it("Bedrock CLEAR and no chunk (a real photo) → READ BEDROCK", async () => {
    expect(await read(jpeg(), ok()).run()).toMatchObject({ result: "READ", source: "BEDROCK", fields: FIELDS, fallback: { present: false } });
  });

  it("Bedrock PARTIAL with code, amount and date complete is treated as CLEAR", async () => {
    expect(await read(LEGIBLE, ok(clearReading({ legibility: "PARTIAL" }))).run()).toMatchObject({ result: "READ", source: "BOTH_AGREE" });
  });

  it("[FL-019] Bedrock ILLEGIBLE → UNREADABLE even when the image carries the chunk: the fallback never rescues it", async () => {
    const blurryWithChunk = read(LEGIBLE, ok({ isReceipt: true, legibility: "ILLEGIBLE", suspiciousText: false }));
    const outcome = await blurryWithChunk.run();
    expect(outcome).toEqual({ result: "UNREADABLE", source: "BEDROCK", suspiciousText: false, bedrock: { legibility: "ILLEGIBLE", isReceipt: true } });
    expect(blurryWithChunk.lines().some((line) => line.metric === "ReceiptReadFallbacks")).toBe(false);
  });

  it("[FL-019] Bedrock PARTIAL without the amount → UNREADABLE (INCOMPLETE), with or without a chunk", async () => {
    const partial = clearReading({ legibility: "PARTIAL" });
    delete (partial as { amount?: number }).amount;
    expect(await read(LEGIBLE, ok(partial)).run()).toMatchObject({ result: "UNREADABLE", source: "BEDROCK", problem: "INCOMPLETE" });
    expect(await read(png(), ok(partial)).run()).toMatchObject({ result: "UNREADABLE", source: "BEDROCK", problem: "INCOMPLETE" });
  });

  it("[FL-019] a CLEAR reading that misses the code is UNREADABLE, never completed by the chunk", async () => {
    const noCode = clearReading();
    delete (noCode as { operationCode?: string }).operationCode;
    expect(await read(LEGIBLE, ok(noCode)).run()).toMatchObject({ result: "UNREADABLE", problem: "INCOMPLETE" });
  });

  it("[FL-020] an invalid check digit → INVALID_RECEIPT (a person reviews it)", async () => {
    const fake = png({ texts: [["ReceiptCode", receiptCode({ ...SUR_FIELDS, operationCode: "SUR-20261002-004211-2" })]] });
    expect(await read(fake, ok(clearReading({ operationCode: "SUR-20261002-004211-2" }))).run()).toMatchObject({ result: "INVALID_RECEIPT", source: "BEDROCK", problem: "INVALID_CHECK_DIGIT" });
  });

  it("[FL-027] Bedrock CLEAR and the chunk differ in amount or code → DISAGREE with both readings, no fields", async () => {
    const tampered = png({ texts: [["ReceiptCode", receiptCode({ ...SUR_FIELDS, amount: "999999.00" })]] });
    const outcome = await read(tampered, ok()).run();
    expect(outcome).toMatchObject({
      result: "DISAGREE",
      source: "DISAGREE",
      fallback: { present: true, agrees: false },
      disagreement: { bedrock: { operationCode: SUR_FIELDS.operationCode, amount: 11_864_000 }, fallback: { operationCode: SUR_FIELDS.operationCode, amount: 99_999_900 } },
    });
    expect("fields" in outcome).toBe(false);
    const otherCode = png({ texts: [["ReceiptCode", receiptCode({ ...SUR_FIELDS, operationCode: "SUR-20261005-000123-1" })]] });
    expect(await read(otherCode, ok()).run()).toMatchObject({ result: "DISAGREE" });
  });

  it("[FL-027] a corrupted chunk next to a CLEAR reading is a disagreement, not a silent pass", async () => {
    const corrupted = png({ texts: [["ReceiptCode", receiptCode(SUR_FIELDS)]], badCrc: true });
    expect(await read(corrupted, ok()).run()).toMatchObject({ result: "DISAGREE", fallback: { present: true, agrees: false } });
  });

  it("isReceipt = false → NOT_A_RECEIPT", async () => {
    expect(await read(png(), ok({ isReceipt: false, legibility: "CLEAR", suspiciousText: false })).run()).toMatchObject({ result: "NOT_A_RECEIPT", source: "BEDROCK" });
  });

  it("[FL-028] suspiciousText is flagged and the reading goes on: its fields only reconcile", async () => {
    const injected = read(LEGIBLE, ok(clearReading({ suspiciousText: true })));
    expect(await injected.run()).toMatchObject({ result: "READ", suspiciousText: true, fields: FIELDS });
    expect(injected.lines().some((line) => line.message === "receipts.suspicious_text")).toBe(true);
    // Nothing read from the image reaches a log line.
    expect(JSON.stringify(injected.lines())).not.toContain(SUR_FIELDS.operationCode);
  });

  it("[FL-027] Bedrock NOT AVAILABLE and the chunk present → READ FALLBACK with the metric", async () => {
    const throttled = read(LEGIBLE, down);
    expect(await throttled.run()).toEqual({ result: "READ", source: "FALLBACK", fields: { network: "SUR", operationCode: SUR_FIELDS.operationCode, amount: 11_864_000, paidAtLocal: SUR_FIELDS.paidAtLocal }, suspiciousText: false, bedrock: { unavailable: "THROTTLED" }, fallback: { present: true } });
    expect(throttled.lines().some((line) => line.metric === "ReceiptReadFallbacks")).toBe(true);
  });

  it("[FL-027] the fallback validates like Bedrock: a fake digit in the chunk is INVALID_RECEIPT", async () => {
    const fake = png({ texts: [["ReceiptCode", receiptCode({ ...SUR_FIELDS, operationCode: "SUR-20261002-004211-2" })]] });
    expect(await read(fake, down).run()).toMatchObject({ result: "INVALID_RECEIPT", source: "FALLBACK", problem: "INVALID_CHECK_DIGIT" });
  });

  it("[FL-027] Bedrock NOT AVAILABLE and no chunk → no reading at all", async () => {
    const outcome = await read(png(), down).run();
    expect(isUnavailable(outcome)).toBe(true);
    expect(outcome).toEqual({ unavailable: true, reason: "THROTTLED" });
  });

  it("[FL-027] receipt.forceFallback skips Bedrock only in a QA world", async () => {
    const forced = read(LEGIBLE, ok());
    expect(await forced.run({ worldId: "qa-r1-sc03", forceFallback: true })).toMatchObject({ result: "READ", source: "FALLBACK", bedrock: { unavailable: "FORCED" } });
    expect(forced.bedrock.calls).toBe(0);
    const demo = read(LEGIBLE, ok());
    expect(await demo.run({ worldId: "demo", forceFallback: true })).toMatchObject({ source: "BOTH_AGREE" });
    expect(demo.bedrock.calls).toBe(1);
  });

  it("[FL-019] an answer outside the schema is UNREADABLE and the chunk is not read", async () => {
    expect(await read(LEGIBLE, { kind: "INVALID_OUTPUT" }).run()).toEqual({ result: "UNREADABLE", source: "BEDROCK", problem: "INVALID_OUTPUT", suspiciousText: false });
  });
});
