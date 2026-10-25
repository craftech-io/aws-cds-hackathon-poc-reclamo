// public/landing/manifest.json on disk (packages/web/src/views/landing/manifest.ts), for the scripts that
// make the landing's pictures: each one writes its files under public/landing/<id>/ and records its
// entry, keeping every other entry as it was, in the manifest's order.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LandingManifest } from "../../packages/web/src/views/landing/manifest";

export const PUBLIC_DIR = join(import.meta.dirname, "../../packages/web/public");
export const MANIFEST_PATH = join(PUBLIC_DIR, "landing/manifest.json");

export function readManifest(path: string = MANIFEST_PATH): LandingManifest {
  return LandingManifest.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Writes the manifest after parsing it again: a script can never write a manifest the page refuses. */
export function writeManifest(manifest: LandingManifest, path: string = MANIFEST_PATH): void {
  writeFileSync(path, `${JSON.stringify(LandingManifest.parse(manifest), null, 2)}\n`);
}

/** Where a manifest `src` (`/landing/…`) lives on disk. */
export function publicPath(src: string, publicDir: string = PUBLIC_DIR): string {
  return join(publicDir, src);
}
