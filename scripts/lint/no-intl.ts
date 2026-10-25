// Fails when the seed generator or the shared formatting (money in es-AR) uses `Intl` or a
// `toLocale*` method (docs/seed-spec.md): their output depends on the ICU data of the Node build, so
// two machines could write different bytes for the same seed. Dates and numbers are formatted with
// our own tested helpers.
//
//   npm run lint   (runs max-lines, then this)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories whose output must be byte-for-byte reproducible. */
export const DETERMINISTIC_ROOTS = ["scripts/seed/generate", "packages/shared/src"];

const FORBIDDEN = /\bIntl\b|\.toLocale(?:String|DateString|TimeString|UpperCase|LowerCase)\s*\(/;

export interface IntlUsage {
  readonly file: string;
  readonly line: number;
}

/** Lines of `source` that use Intl or toLocale*, ignoring comment lines. */
export function findIntlUsages(file: string, source: string): IntlUsage[] {
  const usages: IntlUsage[] = [];
  source.split("\n").forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (FORBIDDEN.test(text)) usages.push({ file, line: index + 1 });
  });
  return usages;
}

function walk(path: string, out: string[]): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) if (entry !== "node_modules") walk(join(path, entry), out);
    return;
  }
  if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
}

function main(): void {
  const cwd = process.cwd();
  const files: string[] = [];
  for (const root of DETERMINISTIC_ROOTS) walk(join(cwd, root), files);
  const usages = files.flatMap((file) => findIntlUsages(relative(cwd, file), readFileSync(file, "utf8")));
  if (usages.length > 0) {
    console.error(`no-intl: ${usages.length} use(s) of Intl or toLocale* in deterministic code:`);
    for (const { file, line } of usages) console.error(`  ${file}:${line}`);
    process.exit(1);
  }
  console.log(`no-intl: ${files.length} file(s) checked, no Intl or toLocale*.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
