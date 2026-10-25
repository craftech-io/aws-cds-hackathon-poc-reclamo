// Keeps the flow catalog, the traceability matrix and the tests in step (docs/test-plan.md §2.2,
// docs/architecture.md §18):
//
//   1. The matrix between <!-- MATRIX:START --> and <!-- MATRIX:END --> of docs/test-plan.md is
//      generated from the "Prueba" line of every flow of docs/flows-catalog.md; any difference fails
//      (`--write` rewrites the block instead).
//   2. Every test file a flow cites that exists must carry the flow's `[FL-xxx]` tag, and every
//      scenario file a flow cites that exists must list the flow in a `flows: [...]` step.
//   3. A cited file that does not exist yet is pending and only reported, because the plan builds
//      them wave by wave; `--strict` (the "100 % probada" gate) fails on it.
//
//   npm run flows:check [-- --write] [-- --strict]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG_FILE = "docs/flows-catalog.md";
export const TEST_PLAN_FILE = "docs/test-plan.md";
export const MATRIX_START = "<!-- MATRIX:START -->";
export const MATRIX_END = "<!-- MATRIX:END -->";

export const LEVELS = ["U", "LF", "UI", "SR", "SMK"] as const;
export type Level = (typeof LEVELS)[number];

export interface Flow {
  readonly id: string;
  readonly title: string;
  readonly tests: Readonly<Record<Level, readonly string[]>>;
  readonly notes: string | undefined;
}

const HEADER = ["| Flujo | Título | U | LF | UI | SR | SMK | Notas |", "|---|---|---|---|---|---|---|---|"];

function emptyTests(): Record<Level, string[]> {
  return { U: [], LF: [], UI: [], SR: [], SMK: [] };
}

/** `- Prueba: U \`a\`, \`b\` · SR \`SC-01/1\`. Notas: …` → tests by level and the notes. */
export function parseProofLine(line: string): Pick<Flow, "tests" | "notes"> {
  const body = line.replace(/^- Prueba:\s*/, "").trim();
  const notesAt = body.indexOf(". Notas: ");
  const levels = (notesAt === -1 ? body : body.slice(0, notesAt)).replace(/\.$/, "");
  const notes = notesAt === -1 ? undefined : body.slice(notesAt + ". Notas: ".length).replace(/\.$/, "").trim();
  const tests = emptyTests();
  for (const part of levels.split(" · ")) {
    const level = /^(U|LF|UI|SR|SMK)\s/.exec(part.trim())?.[1] as Level | undefined;
    if (!level) continue;
    tests[level].push(...[...part.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""));
  }
  return { tests, notes: notes === "" ? undefined : notes };
}

export function parseCatalog(markdown: string): Flow[] {
  const flows: Flow[] = [];
  const blocks = markdown.split(/\n(?=### FL-\d{3} · )/);
  for (const block of blocks) {
    const heading = /^### (FL-\d{3}) · (.+)$/m.exec(block);
    if (!heading) continue;
    const proof = block.split("\n").find((line) => line.startsWith("- Prueba:"));
    const parsed = proof ? parseProofLine(proof) : { tests: emptyTests(), notes: undefined };
    flows.push({ id: heading[1] ?? "", title: (heading[2] ?? "").trim(), ...parsed });
  }
  return flows;
}

function cell(items: readonly string[]): string {
  return items.length === 0 ? "—" : items.map((item) => `\`${item}\``).join(", ");
}

export function renderMatrix(flows: readonly Flow[]): string {
  const rows = flows.map((flow) => `| ${flow.id} | ${flow.title} | ${LEVELS.map((level) => cell(flow.tests[level])).join(" | ")} | ${flow.notes ?? "—"} |`);
  return [...HEADER, ...rows].join("\n");
}

export function committedMatrix(testPlan: string): string | undefined {
  const start = testPlan.indexOf(MATRIX_START);
  const end = testPlan.indexOf(MATRIX_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return testPlan.slice(start + MATRIX_START.length, end).trim();
}

/** Lines of the committed matrix that differ from the generated one, as `expected / found`. */
export function matrixDiff(generated: string, committed: string): string[] {
  const want = generated.split("\n");
  const have = committed.split("\n");
  const diff: string[] = [];
  for (let index = 0; index < Math.max(want.length, have.length); index += 1) {
    if (want[index] !== have[index]) diff.push(`line ${index + 1}: expected ${want[index] ?? "(nothing)"} / found ${have[index] ?? "(nothing)"}`);
  }
  return diff;
}

// ---- Citations ---------------------------------------------------------------------------------

/** Repository path of a test cited by its short form (docs/test-plan.md §2, "Etiquetas"). */
export function resolveTestPath(level: Level, cited: string): string {
  if (level === "LF") return cited.startsWith("tests/") ? cited : `tests/flows/${cited}`;
  if (cited.endsWith(".spec.ts")) return `packages/web/e2e/${cited}`;
  if (/^(infra|scripts|tests)\//.test(cited)) return cited;
  // Cited with their `src/` (`core-mock/src/ledger/payments.test.ts`).
  for (const pkg of ["core-mock", "network-mock", "core-contract", "shared"]) if (cited.startsWith(`${pkg}/`)) return `packages/${cited}`;
  if (cited.startsWith("views/")) return `packages/web/src/${cited}`;
  return `packages/bff/src/${cited}`;
}

/** Scenario file prefix of a step (`SC-16/1` → `sc-16-`, `SMK/3` → `sc-00-`). */
export function scenarioPrefix(step: string): string | undefined {
  if (step.startsWith("SMK/")) return "sc-00-";
  const number = /^SC-(\d{2})\//.exec(step)?.[1];
  return number === undefined ? undefined : `sc-${number}-`;
}

export interface CitationReport {
  readonly errors: string[];
  readonly pending: string[];
}

export interface FileAccess {
  exists(path: string): boolean;
  read(path: string): string;
  /** Files of `scripts/scenarios/` (empty when the directory does not exist). */
  scenarios(): string[];
}

export function checkCitations(flows: readonly Flow[], files: FileAccess): CitationReport {
  const errors: string[] = [];
  const pending: string[] = [];
  for (const flow of flows) {
    for (const level of ["U", "LF", "UI"] as const) {
      for (const cited of flow.tests[level]) {
        const path = resolveTestPath(level, cited);
        if (!files.exists(path)) pending.push(`${flow.id} ${level} ${path}`);
        else if (!files.read(path).includes(`[${flow.id}]`)) errors.push(`${flow.id}: ${path} has no test tagged [${flow.id}]`);
      }
    }
    for (const step of [...flow.tests.SR, ...flow.tests.SMK]) {
      const prefix = scenarioPrefix(step);
      const file = prefix === undefined ? undefined : files.scenarios().find((name) => name.startsWith(prefix));
      if (!file) {
        pending.push(`${flow.id} ${step}`);
        continue;
      }
      const source = files.read(`scripts/scenarios/${file}`);
      if (!new RegExp(`flows:\\s*\\[[^\\]]*["']${flow.id}["']`).test(source)) errors.push(`${flow.id}: scripts/scenarios/${file} has no step with flows: [..."${flow.id}"...] (${step})`);
    }
  }
  return { errors, pending };
}

function diskAccess(cwd: string): FileAccess {
  return {
    exists: (path) => existsSync(join(cwd, path)),
    read: (path) => readFileSync(join(cwd, path), "utf8"),
    scenarios: () => (existsSync(join(cwd, "scripts/scenarios")) ? readdirSync(join(cwd, "scripts/scenarios")) : []),
  };
}

function main(): void {
  const cwd = process.cwd();
  const write = process.argv.includes("--write");
  const strict = process.argv.includes("--strict");
  const flows = parseCatalog(readFileSync(join(cwd, CATALOG_FILE), "utf8"));
  const planPath = join(cwd, TEST_PLAN_FILE);
  const plan = readFileSync(planPath, "utf8");
  const generated = renderMatrix(flows);
  const committed = committedMatrix(plan);
  const errors: string[] = [];

  if (committed === undefined) errors.push(`${TEST_PLAN_FILE}: the ${MATRIX_START} / ${MATRIX_END} markers are missing.`);
  else if (committed !== generated) {
    if (write) {
      writeFileSync(planPath, plan.replace(committed, generated));
      console.log(`flows:check: rewrote the matrix of ${TEST_PLAN_FILE}.`);
    } else {
      errors.push(`${TEST_PLAN_FILE}: the matrix differs from ${CATALOG_FILE} (run \`npm run flows:check -- --write\`):`);
      errors.push(...matrixDiff(generated, committed).slice(0, 20).map((line) => `  ${line}`));
    }
  }

  const citations = checkCitations(flows, diskAccess(cwd));
  errors.push(...citations.errors);
  if (strict) errors.push(...citations.pending.map((item) => `pending (not in the repository yet): ${item}`));

  if (errors.length > 0) {
    console.error(`flows:check: ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const note = citations.pending.length > 0 ? `; ${citations.pending.length} cited test(s) or step(s) not written yet` : "";
  console.log(`flows:check: ${flows.length} flow(s), matrix in step${note}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
