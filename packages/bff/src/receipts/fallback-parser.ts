// The deterministic fallback of the receipt reader (docs/architecture-integrations.md §7, step 4;
// ADR-0007; FL-027). The readable synthetic receipts carry a PNG `tEXt` chunk with the key
// `ReceiptCode` = `RC1|<network>|<operationCode>|<amount>|<paidAtLocal>|<check>` (the same data
// printed on the image; `check` = the first 8 hex of the SHA-256 of everything before it). This
// module reads it WITHOUT OCR and without decompressing anything, with a bounded chunk walk.
//
// It is used ONLY when Bedrock is not available (timeout, throttling or an error after the retries,
// or `receipt.forceFallback` in a QA world) and as a CROSS-CHECK of a `CLEAR` reading. It never
// rescues an `ILLEGIBLE` or `PARTIAL` reading: that decision lives in reader.ts, which simply does not
// ask this module in those cases. A real photo has no such chunk.
import { sha256Hex } from "../lib/crypto";
import { type CandidateFields, pesosToCents } from "./validate";

export const RECEIPT_CODE_KEY = "ReceiptCode";

/** Bounds of the walk: chunks visited, and the largest text chunk considered. */
export const FALLBACK_LIMITS = { maxChunks: 4_096, maxTextBytes: 1_024 } as const;

export type FallbackRead =
  | { readonly present: false; readonly reason: "NOT_PNG" | "NO_CHUNK" | "TRUNCATED" | "TOO_MANY_CHUNKS" }
  | { readonly present: true; readonly valid: false; readonly reason: "BAD_CRC" | "MALFORMED" | "BAD_CHECK" }
  | { readonly present: true; readonly valid: true; readonly candidate: CandidateFields };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) >>> 0) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

type TextChunk = { readonly kind: "text"; readonly value: string } | { readonly kind: "bad-crc" };

/** The value of the `ReceiptCode` text chunk, walking chunk headers only (no decompression). */
function findReceiptCode(bytes: Uint8Array): TextChunk | Extract<FallbackRead, { present: false }> {
  if (bytes.length < 8 || !SIGNATURE.every((value, index) => bytes[index] === value)) return { present: false, reason: "NOT_PNG" };
  let offset = 8;
  for (let visited = 0; visited < FALLBACK_LIMITS.maxChunks; visited += 1) {
    if (offset + 12 > bytes.length) return { present: false, reason: "TRUNCATED" };
    const length = u32(bytes, offset);
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (length > bytes.length || end > bytes.length) return { present: false, reason: "TRUNCATED" };
    if (type === "IEND") return { present: false, reason: "NO_CHUNK" };
    if (type === "tEXt" && length <= FALLBACK_LIMITS.maxTextBytes) {
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const nul = data.indexOf(0);
      if (nul > 0 && latin1(data.subarray(0, nul)) === RECEIPT_CODE_KEY) {
        if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== u32(bytes, offset + 8 + length)) return { kind: "bad-crc" };
        return { kind: "text", value: latin1(data.subarray(nul + 1)) };
      }
    }
    offset = end;
  }
  return { present: false, reason: "TOO_MANY_CHUNKS" };
}

const CODE_PATTERN = /^RC1\|(NORTE|SUR|WALLET)\|([A-Z0-9-]{1,64})\|(\d{1,9}\.\d{2})\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\|([0-9a-f]{8})$/;

/** Parses the chunk text; the checksum proves the chunk was written whole, not that it tells the truth. */
export function parseReceiptCode(text: string): FallbackRead {
  const match = CODE_PATTERN.exec(text);
  if (!match) return { present: true, valid: false, reason: "MALFORMED" };
  const [, network = "", operationCode = "", amountText = "", paidAtLocal = "", check = ""] = match;
  const body = text.slice(0, text.lastIndexOf("|"));
  if (sha256Hex(body).slice(0, 8) !== check) return { present: true, valid: false, reason: "BAD_CHECK" };
  const amount = pesosToCents(amountText);
  if (amount === undefined) return { present: true, valid: false, reason: "MALFORMED" };
  return { present: true, valid: true, candidate: { network, operationCode, amount, paidAtLocal } };
}

/** The fallback reading of an image's bytes. */
export function readFallback(bytes: Uint8Array): FallbackRead {
  const found = findReceiptCode(bytes);
  if ("present" in found) return found;
  if (found.kind === "bad-crc") return { present: true, valid: false, reason: "BAD_CRC" };
  return parseReceiptCode(found.value);
}
