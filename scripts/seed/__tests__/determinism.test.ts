// docs/seed-spec.md §1 and invariant 1: two runs of the generator in separate processes write the
// same bytes (templates, CSVs, receipts compressed by the bundled pure-JS deflate at a fixed level,
// evals, load inputs, manifest), and those bytes are the committed seed. The generator uses no Intl
// and no toLocale* (the same scan as `npm run lint`), and the canonical JSON sorts keys.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findIntlUsages } from "../../lint/no-intl";
import { REPO_ROOT, SEED_ROOT } from "../lib/constants";
import { stableJsonLines, stableStringify } from "../lib/json";
import { DEFLATE_LEVEL, decodePixels, encodePng } from "../lib/png";
import { filesUnder } from "../validate/read";

const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const scratch: string[] = [];

function seedFiles(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const dir of ["data", "media"]) for (const path of filesUnder(join(root, dir))) out.set(`${dir}/${path}`, readFileSync(join(root, dir, path)));
  return out;
}

/** A fresh generation in its own Node process. */
function generateInProcess(): string {
  const root = mkdtempSync(join(tmpdir(), "reclamo-seed-"));
  scratch.push(root);
  execFileSync(TSX, [join(SEED_ROOT, "generate.ts"), "--out", root], { cwd: REPO_ROOT, stdio: "pipe", env: { ...process.env, FORBIDDEN_TERMS: "" } });
  return root;
}

function differences(a: ReadonlyMap<string, Buffer>, b: ReadonlyMap<string, Buffer>): string[] {
  const paths = new Set([...a.keys(), ...b.keys()]);
  return [...paths].filter((path) => a.get(path)?.equals(b.get(path) ?? Buffer.alloc(0)) !== true).sort();
}

afterAll(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

describe("seed determinism (invariant 1)", () => {
  it("writes the same bytes in two separate processes, and they are the committed seed", () => {
    const first = seedFiles(generateInProcess());
    const second = seedFiles(generateInProcess());
    expect(first.size).toBeGreaterThan(150);
    expect(differences(first, second)).toEqual([]);
    expect(differences(first, seedFiles(SEED_ROOT))).toEqual([]);
  }, 300_000);

  it("uses neither Intl nor toLocale* in the generator", () => {
    const generator = filesUnder(join(SEED_ROOT, "generate"));
    expect(generator.length).toBeGreaterThan(20);
    const usages = generator.flatMap((path) => findIntlUsages(path, readFileSync(join(SEED_ROOT, "generate", path), "utf8")));
    expect(usages).toEqual([]);
  });

  it("serializes JSON with sorted keys, whatever order an object was built in", () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(stableStringify({ a: { d: [2, { y: 2, z: 1 }] }, b: 1 }));
    expect(stableJsonLines([{ b: 1, a: 2 }])).toBe('{"a":2,"b":1}\n');
    expect(() => stableStringify({ a: Number.NaN })).toThrow(RangeError);
  });

  it("compresses PNGs with the bundled deflate at a fixed level: same pixels, same bytes, lossless", () => {
    const pixels = new Uint8Array(30 * 20 * 3).map((_, index) => (index * 37) % 251);
    const image = { width: 30, height: 20, pixels };
    const first = encodePng(image, [["ReceiptCode", "RC1|x"]]);
    expect(Buffer.from(encodePng(image, [["ReceiptCode", "RC1|x"]])).equals(Buffer.from(first))).toBe(true);
    expect(decodePixels(first).pixels).toEqual(pixels);
    expect(DEFLATE_LEVEL).toBe(9);
  });
});
