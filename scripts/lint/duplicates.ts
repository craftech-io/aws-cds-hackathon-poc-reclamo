// Reports code copied between files (CLAUDE.md, "Reutilización"): every window of 8 normalised
// lines that two non-test source files share. Imports, comments, blank lines and lone brackets are
// dropped first, and short windows (under 200 characters) are ignored, so boilerplate does not count.
// Exits 1 when a duplicate outside ALLOWED remains; the fix is to fold it into one module, or to
// justify it in the PR and add the pair here.
//
//   npm run lint:duplicates
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WINDOW = 8;
const MIN_CHARS = 200;
const ROOTS = ["infra", "scripts", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".sst", "coverage", "data", "e2e", "__tests__", "testing", "fixtures"]);
const SKIP_FILE = /(\.test\.|\.d\.ts$|test-kit|test-harness|\/testing\.ts$)/;
const TRIVIAL = new Set(["}", "{", "});", ");", "]", "},", ")", "</div>", "<>", "</>"]);
/** Pairs that share lines by design, each with its reason. Empty: add a pair only with its justification. */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [];

function walk(path: string, out: string[]): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) if (!SKIP_DIRS.has(entry)) walk(join(path, entry), out);
    return;
  }
  if (/\.tsx?$/.test(path) && !SKIP_FILE.test(path)) out.push(path);
}

function normalised(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*") && !line.startsWith("import ") && !TRIVIAL.has(line));
}

const owners = new Map<string, Set<string>>();
const files: string[] = [];
for (const root of ROOTS) walk(root, files);
for (const file of files) {
  const lines = normalised(file);
  for (let start = 0; start + WINDOW <= lines.length; start += 1) {
    const chunk = lines.slice(start, start + WINDOW).join("\n");
    if (chunk.length < MIN_CHARS) continue;
    const key = createHash("sha1").update(chunk).digest("hex");
    const set = owners.get(key) ?? new Set<string>();
    set.add(file);
    owners.set(key, set);
  }
}

const allowed = (group: readonly string[]) => ALLOWED.some(([a, b]) => group.length === 2 && group.includes(a) && group.includes(b));
const groups = new Map<string, number>();
for (const set of owners.values()) {
  if (set.size < 2) continue;
  const group = [...set].sort();
  if (allowed(group)) continue;
  const id = group.join("  |  ");
  groups.set(id, (groups.get(id) ?? 0) + 1);
}

if (groups.size === 0) {
  console.log(`duplicates: ${files.length} file(s) checked, no code copied between files.`);
} else {
  console.error(`duplicates: ${groups.size} group(s) of files share copied blocks (count = shared ${WINDOW}-line windows):`);
  for (const [id, count] of [...groups].sort((a, b) => b[1] - a[1])) console.error(`  ${String(count).padStart(3)}  ${id}`);
  process.exitCode = 1;
}
