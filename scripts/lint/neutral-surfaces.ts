// Neutral surfaces (ADR-0019): what a visitor, a customer or a staff member can see never names the
// contest the repository was built for, nor the people who judge it, nor the app's technical id.
// The word list is public (it is ADR-0019's own list, plus its English forms), so the report prints
// the word; the external brand list stays in scripts/lint/forbidden-terms.ts.
//
//   npm run lint:neutral-surfaces            visible sources (see SURFACE_ROOTS)
//   npm run lint:neutral-surfaces -- --dist  packages/web/dist
//
// Matching ignores case and accents and is by whole word: letters and digits are word characters,
// `_` and `-` are not, so `aws_cds_hackathon_poc_reclamo` and `aws-cds-hackathon-poc-reclamo`
// both match while `evaluate` or `prejudged` do not.
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distFiles, isBinary, pdfText, pngText, stripAccents } from "./forbidden-terms";
import { isTestFile, sourceFiles } from "./shared-walk";

export interface NeutralTerm {
  /** The word as ADR-0019 lists it: what the report prints. */
  readonly label: string;
  readonly pattern: RegExp;
}

export interface NeutralFinding {
  readonly source: string;
  readonly line: number;
  readonly term: string;
}

const WORD = "[\\p{L}\\p{N}]";

function term(label: string, body: string): NeutralTerm {
  return { label, pattern: new RegExp(`(?<!${WORD})(?:${body})(?!${WORD})`, "iu") };
}

/** ADR-0019's list, accent-free (the text is stripped of accents before matching). */
export const NEUTRAL_TERMS: readonly NeutralTerm[] = [
  term("hackathon", "hackathons?"),
  term("hackatón", "hackaton(?:es)?"),
  term("Devpost", "devpost"),
  term("concurso", "concursos?"),
  term("premio", "premios?"),
  term("jurado", "jurados?"),
  term("juez", "juez"),
  term("jueces", "jueces"),
  term("judge", "judges?|judging|judged"),
  term("evaluación", "evaluacion(?:es)?"),
  term("AWS CDS", "aws[\\s_-]*cds"),
  term("contest", "contests?"),
  term("prize", "prizes?"),
  term("jury", "jury|juries"),
  term("evaluation", "evaluations?"),
];

/** Every (line, term) of `text` that names the contest, in line order. */
export function findNeutralTerms(source: string, text: string, terms: readonly NeutralTerm[] = NEUTRAL_TERMS): NeutralFinding[] {
  const findings: NeutralFinding[] = [];
  text.split("\n").forEach((line, index) => {
    const plain = stripAccents(line);
    for (const { label, pattern } of terms) if (pattern.test(plain)) findings.push({ source, line: index + 1, term: label });
  });
  return findings;
}

/** Roots of the visible sources (ADR-0019 §3); tests and test helpers under them are skipped. */
export const SURFACE_ROOTS: readonly string[] = [
  "packages/web/src",
  "packages/web/public",
  "packages/web/index.html",
  "packages/bff/src/copy",
  "packages/bff/src/pdf",
  "packages/bff/src/auth-triggers",
  "infra/auth-email.ts",
  "scripts/seed/data",
];

/** Whether a repository path is a visible source the guard reads. */
export function isSurface(path: string): boolean {
  const file = path.replaceAll("\\", "/");
  if (isTestFile(file) || /(^|\/)testing(\/|\.tsx?$)/.test(file) || file.endsWith(".d.ts")) return false;
  if (file.startsWith("packages/bff/src/auth-triggers/")) return /\/custom-message[^/]*\.ts$/.test(file);
  return SURFACE_ROOTS.some((root) => file === root || file.startsWith(`${root}/`));
}

/** The visible sources that exist under `cwd`, sorted. */
export function surfaceFiles(cwd: string): string[] {
  return sourceFiles(cwd, SURFACE_ROOTS, /[^/]$/).filter(isSurface);
}

/** The findings of one file: text, the text and metadata of a PDF, the text chunks of a PNG. */
export async function scanSurfaceFile(cwd: string, path: string): Promise<NeutralFinding[]> {
  const bytes = readFileSync(path);
  const source = relative(cwd, path);
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return findNeutralTerms(`${source} (pdf text and metadata)`, await pdfText(bytes));
  if (lower.endsWith(".png")) return findNeutralTerms(`${source} (png text chunks)`, pngText(bytes));
  if (isBinary(bytes)) return [];
  return findNeutralTerms(source, bytes.toString("utf8"));
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const dist = process.argv.includes("--dist");
  let files: string[];
  if (dist) {
    const dir = join(cwd, "packages/web/dist");
    if (!existsSync(dir)) {
      console.error("neutral-surfaces: packages/web/dist does not exist; run `npm run build -w packages/web` first.");
      process.exit(1);
    }
    files = distFiles(dir);
  } else {
    files = surfaceFiles(cwd).map((file) => join(cwd, file));
  }
  const findings: NeutralFinding[] = [];
  for (const file of files) findings.push(...(await scanSurfaceFile(cwd, file)));
  if (findings.length > 0) {
    console.error(`neutral-surfaces: ${findings.length} visible mention(s) of the contest or of the app's technical id (ADR-0019):`);
    for (const { source, line, term: word } of findings) console.error(`  ${source}:${line}  "${word}"`);
    process.exit(1);
  }
  console.log(`neutral-surfaces: ${files.length} file(s)${dist ? " of the web build" : " of visible sources"} checked, no mention.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
