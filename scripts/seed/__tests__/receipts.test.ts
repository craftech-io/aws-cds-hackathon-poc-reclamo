// docs/seed-spec.md §9 and docs/architecture-integrations.md §7: the synthetic receipts. 900 × 1400,
// at most 1 MB, the `ReceiptCode` chunk exactly on the readable variants and equal to what is printed
// (except the tampered ones), never on `blurry` or `not-receipt`; the blurry ones really are blurred;
// rendering is deterministic; each persona's receipt is the scenario's payment.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { pngText } from "../../lint/forbidden-terms";
import { renderBlurry, renderReadable, type ReceiptFields } from "../generate/receipts";
import { rngFor } from "../generate/rng";
import { hasValidCheckDigit } from "../lib/codes";
import { sha256Hex } from "../lib/json";
import { decodePixels, readPng } from "../lib/png";
import { RECEIPT_COUNTS } from "../validate/personas";
import { type Json, type SeedOnDisk, networkLines, publishedLines, readSeed } from "../validate/read";

let seed: SeedOnDisk;
let truth: Json[];

beforeAll(() => {
  seed = readSeed();
  truth = [...((seed.evals.receipts.images ?? []) as Json[]), ...((seed.evals.receipts.personas ?? []) as Json[])];
});

const READABLE = new Set(["legible", "fake-check", "fake-unknown", "injection", "other-payer", "tampered-chunk"]);

function receipts(): Array<[string, Buffer]> {
  return [...seed.files].filter(([path]) => path.startsWith("media/receipts/"));
}

function entry(id: string): Json {
  const found = truth.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no truth for ${id}`);
  return found;
}

function fields(id: string): Json {
  return (entry(id).expected as Json).fields as Json;
}

function chunkOf(path: string): string | undefined {
  const bytes = seed.files.get(path);
  return bytes ? readPng(new Uint8Array(bytes)).texts.find(([key]) => key === "ReceiptCode")?.[1] : undefined;
}

/** Ink contrast (1st to 99th percentile of luminance) of the band with date, amount, code and references. */
function contrast(bytes: Buffer): number {
  const { width, pixels } = decodePixels(new Uint8Array(bytes));
  const values: number[] = [];
  for (let y = 300; y < 900; y += 1) for (let x = 0; x < width; x += 1) values.push(pixels[(y * width + x) * 3] ?? 0);
  values.sort((a, b) => a - b);
  return (values[Math.floor(values.length * 0.99)] ?? 0) - (values[Math.floor(values.length * 0.01)] ?? 0);
}

describe("every receipt file", () => {
  it("is a valid 900 × 1400 PNG of at most 1 MB, fingerprinted in the manifest and the eval", () => {
    const hashes = seed.manifest.seedReceiptHashes as Record<string, string>;
    for (const [path, bytes] of receipts()) {
      const info = readPng(new Uint8Array(bytes));
      expect([info.width, info.height, info.crcOk], path).toEqual([900, 1400, true]);
      expect(bytes.length, path).toBeLessThanOrEqual(1_048_576);
      const sha = createHash("sha256").update(bytes).digest("hex");
      expect(hashes[path.slice("media/".length)], path).toBe(sha);
      expect(truth.some((candidate) => candidate.file === path.slice("media/".length) && candidate.sha256 === sha), path).toBe(true);
    }
  });

  it("is counted per variant, with 64 images in the eval and the SR subset marked", () => {
    const counts: Record<string, number> = {};
    for (const [path] of receipts()) counts[path.split("/")[2] ?? ""] = (counts[path.split("/")[2] ?? ""] ?? 0) + 1;
    expect(counts).toEqual(RECEIPT_COUNTS);
    expect((seed.evals.receipts.images as Json[]).length).toBe(64);
    expect(((seed.evals.receipts.srSubset as Json[]).map((receipt) => receipt.persona) as string[]).sort()).toEqual(["C01", "C04", "C11", "C12", "C13", "C14", "C15", "C16", "C16", "C17", "C19", "C41"]);
  });

  it("carries the ReceiptCode chunk only when readable, and no other text metadata", () => {
    for (const [path, bytes] of receipts()) {
      const keys = readPng(new Uint8Array(bytes)).texts.map(([key]) => key);
      expect(keys, path).toEqual(READABLE.has(path.split("/")[2] ?? "") ? ["ReceiptCode"] : []);
      if (keys.length === 0) expect(pngText(bytes), path).toBe("");
    }
  });

  it("has a chunk equal to what is printed, with its check, except the tampered ones", () => {
    for (const candidate of truth.filter((receipt) => READABLE.has(String(receipt.variant)))) {
      const chunk = chunkOf(`media/${String(candidate.file)}`) ?? "";
      const [prefix, network, code, amount, paidAt, check] = chunk.split("|");
      expect(prefix).toBe("RC1");
      expect(check).toBe(sha256Hex(chunk.slice(0, chunk.lastIndexOf("|"))).slice(0, 8));
      const printed = (candidate.expected as Json).fields as Json;
      expect([network, code, paidAt]).toEqual([printed.network, printed.operationCode, printed.paidAtLocal]);
      const sameAmount = Math.round(Number(amount) * 100) === printed.amount;
      expect(sameAmount, String(candidate.id)).toBe(candidate.variant !== "tampered-chunk");
    }
  });
});

describe("the variants", () => {
  it("[FL-019] blurs the blurry ones until the ink is gone", () => {
    const sharp = contrast(seed.files.get("media/receipts/legible/c01-1.png") ?? Buffer.alloc(0));
    expect(sharp).toBeGreaterThan(200);
    for (const [path, bytes] of receipts().filter(([path]) => path.includes("/blurry/"))) expect(contrast(bytes), path).toBeLessThan(sharp * 0.45);
    expect(chunkOf("media/receipts/blurry/c16-1.png")).toBeUndefined();
    expect(chunkOf("media/receipts/blurry/c16-2.png")).toBeUndefined();
  });

  it("[FL-020] gives the fake-check receipts an invalid check digit and the readable ones a valid one", () => {
    for (const candidate of truth.filter((receipt) => READABLE.has(String(receipt.variant)))) {
      expect(hasValidCheckDigit(String(fields(String(candidate.id)).operationCode)), String(candidate.id)).toBe(candidate.variant !== "fake-check");
    }
  });

  it("[FL-018] never puts a fake-unknown code in a settlement", () => {
    const codes = new Set([...publishedLines(seed, "guest").map((line) => line.operationCode), ...networkLines(seed.templates.guest).map((line) => String(line.operationCode))]);
    for (const candidate of truth.filter((receipt) => receipt.variant === "fake-unknown")) expect(codes.has(String(fields(String(candidate.id)).operationCode))).toBe(false);
  });

  it("[FL-028] prints the injection text on the paper and keeps it out of the chunk", () => {
    for (const candidate of truth.filter((receipt) => receipt.variant === "injection")) {
      expect((candidate.expected as Json).suspiciousText).toBe(true);
      expect(chunkOf(`media/${String(candidate.file)}`) ?? "").not.toMatch(/IGNOR|ACREDIT/i);
    }
  });

  it("[FL-029] draws the not-receipt images without fields or chunk", () => {
    for (const candidate of truth.filter((receipt) => receipt.variant === "not-receipt")) {
      expect(candidate.expected).toEqual({ result: "NOT_A_RECEIPT" });
      expect(chunkOf(`media/${String(candidate.file)}`)).toBeUndefined();
    }
  });
});

describe("the persona receipts are the scenario's payments", () => {
  it("[FL-010] [FL-017] C01's receipt is the pending NORTE line of instalment 4", () => {
    const c01 = fields("c01-1");
    const line = networkLines(seed.templates.guest).find((candidate) => candidate.operationCode === c01.operationCode);
    expect(line).toMatchObject({ network: "NORTE", businessDate: "2026-10-07", customerRef: "cus-0001", loanRef: "L-0001", instalment: 4, amount: c01.amount, status: "PENDING" });
    expect(c01).toMatchObject({ paidAtLocal: "2026-10-06T18:40", amount: 11_864_000 });
    expect(String(c01.operationCode)).toMatch(/^NTE-20261006-004817-\d$/);
  });

  it("[FL-111] C41's receipt is a published line of another payer", () => {
    const c41 = fields("c41-1");
    const line = publishedLines(seed, "guest").find((candidate) => candidate.operationCode === c41.operationCode);
    expect(line).toMatchObject({ customerRef: "cus-1017", loanRef: "L-1017", businessDate: "2026-10-02" });
    expect((entry("c41-1").expected as Json).reconciliation).toBe("PAYER_MISMATCH");
  });

  it("[FL-016] [FL-022] C04's line is published and unapplied, C11's is already applied", () => {
    expect(publishedLines(seed, "guest").some((line) => line.operationCode === fields("c04-1").operationCode && line.customerRef === "cus-0004")).toBe(true);
    expect((entry("c11-1").expected as Json).reconciliation).toBe("ALREADY_APPLIED");
  });
});

describe("rendering", () => {
  const sample: ReceiptFields = { network: "SUR", operationCode: "SUR-20261002-010007-3", amount: 4_500_000, paidAtLocal: "2026-10-02T10:30", customerRef: "cus-0011", loanRef: "L-0011", instalment: 4, terminal: "T-1234" };

  it("is deterministic for the same fields and stream", () => {
    expect(Buffer.from(renderReadable(sample, sha256Hex).bytes).equals(Buffer.from(renderReadable(sample, sha256Hex).bytes))).toBe(true);
    expect(Buffer.from(renderBlurry(sample, rngFor("t")).bytes).equals(Buffer.from(renderBlurry(sample, rngFor("t")).bytes))).toBe(true);
  });
});
