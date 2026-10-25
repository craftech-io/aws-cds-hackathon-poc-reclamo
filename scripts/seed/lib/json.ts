// Canonical JSON of the seed (docs/seed-spec.md §1): keys sorted at every level, no `undefined`
// members, no NaN. Two generations write the same bytes whatever order an object was built in. The
// compact form is also the input of the hash chains (`canonicalJson`).
import { createHash, createHmac } from "node:crypto";

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = sortDeep(member);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError("the seed never writes NaN or Infinity");
  return value;
}

/** Pretty canonical JSON with a final newline (the files of `data/`). */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

/** Compact canonical JSON (hash inputs). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** One canonical JSON object per line (`load/*.jsonl`). */
export function stableJsonLines(values: readonly unknown[]): string {
  return `${values.map((value) => canonicalJson(value)).join("\n")}\n`;
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hmacHex(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}
