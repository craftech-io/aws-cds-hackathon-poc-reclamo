// File walking shared by the guards of scripts/lint: every TypeScript and YAML source under the
// given roots, skipping generated and vendored directories. Paths come back relative to `cwd`.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".sst", "coverage", ".git"]);

export function sourceFiles(cwd: string, roots: readonly string[], extensions: RegExp = /\.(ts|tsx|ya?ml)$/): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path)) if (!SKIP_DIRS.has(entry)) walk(join(path, entry));
      return;
    }
    if (extensions.test(path) && !path.endsWith(".d.ts")) out.push(relative(cwd, path));
  };
  for (const root of roots) walk(join(cwd, root));
  return out.sort();
}

/** Test files may name what they assert against; the guards read only shipped code. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path);
}
