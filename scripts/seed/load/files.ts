// The generated seed on disk (scripts/seed/{data,media}, docs/seed-spec.md §1) as `seed:load` ships it:
// which files go to the `Seed` bucket and under which key (docs/architecture.md §6), and the
// fingerprint that makes the load idempotent. The manifest written by `seed:generate` lists every file
// with its SHA-256, so the fingerprint changes exactly when the seed (or the loader, or the demo
// phones of `SeedOverrides`) changes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Bumped when the loader writes something differently: every world is rebuilt once. */
export const LOADER_VERSION = "1";

const Manifest = z.looseObject({
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  seedReceiptHashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type Manifest = z.infer<typeof Manifest>;

export interface SeedFile {
  /** Key under the `Seed` bucket. */
  readonly key: string;
  /** Path under the seed root. */
  readonly path: string;
  readonly contentType: string;
}

export function readManifest(root: string): Manifest {
  return Manifest.parse(JSON.parse(readFileSync(join(root, "data", "manifest.json"), "utf8")));
}

const CONTENT_TYPES: Readonly<Record<string, string>> = { json: "application/json", jsonl: "application/x-ndjson", csv: "text/csv", png: "image/png" };

/** `data/worlds/x.json` → `worlds/x.json`, `media/receipts/…` → `receipts/…`, `data/settlements/…`, `data/load/…`. */
export function seedKeyOf(path: string): string | undefined {
  for (const [prefix, target] of [
    ["data/worlds/", "worlds/"],
    ["media/receipts/", "receipts/"],
    ["data/settlements/", "settlements/"],
    ["data/load/", "load/"],
  ] as const) {
    if (path.startsWith(prefix)) return `${target}${path.slice(prefix.length)}`;
  }
  return undefined;
}

/** Every file of the manifest that the stage reads from `Seed/`, in a stable order. */
export function seedFiles(manifest: Manifest): SeedFile[] {
  return Object.keys(manifest.files)
    .sort()
    .flatMap((path) => {
      const key = seedKeyOf(path);
      const extension = path.split(".").pop() ?? "";
      return key ? [{ key, path, contentType: CONTENT_TYPES[extension] ?? "application/octet-stream" }] : [];
    });
}

/** SHA-256 of the loader version, the manifest's files and the demo phones (never the phones themselves). */
export function fingerprintOf(manifest: Manifest, personaPhones: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256").update(`loader:${LOADER_VERSION}\n`);
  for (const path of Object.keys(manifest.files).sort()) hash.update(`${path}:${manifest.files[path]}\n`);
  for (const persona of Object.keys(personaPhones).sort()) hash.update(`phone:${persona}:${createHash("sha256").update(personaPhones[persona] ?? "").digest("hex")}\n`);
  return hash.digest("hex");
}
