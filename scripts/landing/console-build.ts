// The console as the captures load it (WP-44): its production build, made by Vite into a directory
// outside the repository with the placeholder pool of the local console (packages/web/e2e/support/env.ts
// `FAKE_COGNITO`), so the planted session is all it needs and no request ever reaches Cognito. A build,
// not the dev server: no HMR client, no source transforms on the fly, the same files every run.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { FAKE_COGNITO } from "../../packages/web/e2e/support/env";

export const WEB_DIR = join(import.meta.dirname, "../../packages/web");

export interface ConsoleBuild {
  readonly dir: string;
  remove(): void;
}

export async function buildConsole(): Promise<ConsoleBuild> {
  const dir = mkdtempSync(join(tmpdir(), "reclamo-capture-"));
  Object.assign(process.env, FAKE_COGNITO);
  await build({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), logLevel: "error", build: { outDir: dir, emptyOutDir: true } });
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
