// Fails when two work packages of the same wave of docs/build-plan.md list the same file (or a
// directory glob that contains a file of the other), so parallel agents never edit one file.
//
// Every WP line reads `**WP-NN · title** — owner · deps` followed by `Archivos: … Aceptación: …`;
// the backticked repository paths between "Archivos:" and "Aceptación:" are its files. Brace lists
// (`lib/{log,mask}.ts`) are expanded; `**` matches any depth. Backticks that are not repository
// paths (identifiers, commands, documents the WP only reads under docs/) are ignored.
//
//   npm run lint:wp-ownership
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLAN_FILE = "docs/build-plan.md";

const PATH_ROOTS = ["packages/", "infra/", "scripts/", "tests/", ".github/", ".claude/"];
const ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.infra.json",
  "vitest.config.ts",
  ".gitignore",
  ".editorconfig",
  ".nvmrc",
  "sst.config.ts",
  "sst-env.d.ts",
  "docs/viewer.html",
]);

export interface WorkPackage {
  readonly id: string;
  readonly files: readonly string[];
}

export interface Wave {
  readonly title: string;
  readonly packages: readonly WorkPackage[];
}

export interface Conflict {
  readonly wave: string;
  readonly a: string;
  readonly b: string;
  readonly pathA: string;
  readonly pathB: string;
}

/** `a/{b,c}/{d,e}.ts` → the four concrete patterns. */
export function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return (match[1] ?? "").split(",").flatMap((option) => expandBraces(`${before}${option.trim()}${after}`));
}

export function isRepositoryPath(token: string): boolean {
  if (/[\s"'…:@]/.test(token) || token.endsWith("/")) return false;
  return ROOT_FILES.has(token) || PATH_ROOTS.some((root) => token.startsWith(root));
}

export function parsePlan(markdown: string): Wave[] {
  const start = markdown.indexOf("## 2.");
  const end = markdown.indexOf("\n## 3.", start);
  const section = markdown.slice(start, end === -1 ? undefined : end);
  return section
    .split(/\n### /)
    .slice(1)
    .map((chunk) => {
      const title = (chunk.split("\n")[0] ?? "").trim();
      const packages = [...chunk.matchAll(/\*\*(WP-\d+) · [^*]*\*\*([\s\S]*?)(?=\n\*\*WP-|$)/g)].map((match) => {
        const body = match[2] ?? "";
        const files = /Archivos:([\s\S]*?)(?:Aceptación:|$)/.exec(body)?.[1] ?? "";
        const paths = [...files.matchAll(/`([^`]+)`/g)].map((token) => token[1] ?? "").filter(isRepositoryPath).flatMap(expandBraces);
        return { id: match[1] ?? "", files: [...new Set(paths)] };
      });
      return { title, packages };
    });
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
}

function literalPrefix(pattern: string): string {
  const star = pattern.indexOf("*");
  return star === -1 ? pattern : pattern.slice(0, star);
}

/** True when some file could be matched by both patterns. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const aGlob = a.includes("*");
  const bGlob = b.includes("*");
  if (!aGlob && !bGlob) return false;
  if (!aGlob) return globToRegExp(b).test(a);
  if (!bGlob) return globToRegExp(a).test(b);
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export function conflicts(waves: readonly Wave[]): Conflict[] {
  const found: Conflict[] = [];
  for (const wave of waves) {
    wave.packages.forEach((first, index) => {
      for (const second of wave.packages.slice(index + 1)) {
        for (const pathA of first.files) {
          for (const pathB of second.files) {
            if (overlaps(pathA, pathB)) found.push({ wave: wave.title, a: first.id, b: second.id, pathA, pathB });
          }
        }
      }
    });
  }
  return found;
}

function main(): void {
  const waves = parsePlan(readFileSync(resolve(process.cwd(), PLAN_FILE), "utf8"));
  const found = conflicts(waves);
  if (found.length > 0) {
    console.error(`wp-ownership: ${found.length} file(s) owned by two work packages of the same wave:`);
    for (const conflict of found) console.error(`  ${conflict.wave}: ${conflict.a} ${conflict.pathA}  ×  ${conflict.b} ${conflict.pathB}`);
    process.exit(1);
  }
  const count = waves.reduce((total, wave) => total + wave.packages.length, 0);
  console.log(`wp-ownership: ${count} work package(s) in ${waves.length} wave(s), no file owned twice in a wave.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
