// Fails when any TypeScript source file in the repository exceeds the line budget fixed by
// CLAUDE.md ("maximo 400 lineas por archivo TS/TSX"). Generated files are skipped.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_LINES = 400;
const ROOTS = ["sst.config.ts", "vitest.config.ts", "infra", "scripts", "packages", "tests"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".sst", "coverage", "data"]);
const SKIP_FILES = new Set(["sst-env.d.ts"]);
const EXTENSIONS = [".ts", ".tsx"];

function walk(path: string, out: string[]): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (!SKIP_DIRS.has(entry)) walk(join(path, entry), out);
    }
    return;
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (SKIP_FILES.has(name) || name.endsWith(".d.ts")) return;
  if (EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(path);
}

function countLines(file: string): number {
  const content = readFileSync(file, "utf8");
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

const cwd = process.cwd();
const files: string[] = [];
for (const root of ROOTS) walk(join(cwd, root), files);

const offenders = files
  .map((file) => ({ file: relative(cwd, file), lines: countLines(file) }))
  .filter(({ lines }) => lines > MAX_LINES)
  .sort((a, b) => b.lines - a.lines);

if (offenders.length > 0) {
  console.error(`${offenders.length} file(s) exceed ${MAX_LINES} lines:`);
  for (const { file, lines } of offenders) console.error(`  ${lines}\t${file}`);
  process.exit(1);
}

console.log(`max-lines: ${files.length} file(s) checked, none above ${MAX_LINES} lines.`);
