// Keeps the guest's guided tour in ONE source (docs/design-brief.md §15, docs/architecture.md §18):
// packages/web/src/views/tour/steps.ts drives the console's panel, and this check makes the other readers
// follow it and proves it on a world.
//
//   1. The steps are consistent: in the order of TOUR_STEP_IDS, every one with a button, every "Qué
//      mirar" placeholder declared (and every declared fact used) in both languages, every expected
//      instant inside the tour's window, each block within its time budget, and each challenge answer
//      the one the step's persona gives.
//   2. The budgets are the ones `tour.steps` answers (packages/bff/src/routers/tour.ts, `TOUR_BLOCKS`).
//   3. The README's "Guided tour" table between <!-- TOUR:START --> and <!-- TOUR:END --> is exactly the
//      one rendered here, in English (`--write` rewrites the block; the markers are the README author's).
//   4. The SC-21 scenario (scripts/scenarios/sc-21-*.ts) imports steps.ts and walks `TOUR_STEPS` (or
//      names every step), so it cannot follow another list.
//   5. The replay (scripts/tour/timeline.ts over scripts/tour/lf-world.ts): the steps walked on a local
//      world of the `guest` template reach every promised state (invariants 18 to 22 of
//      docs/seed-spec.md §14). `--no-replay` skips it.
//
// A README without the markers or an SC-21 not written yet is reported as pending (later work
// packages write them); `--strict` fails on it.
//
//   npm run tour:check [-- --write] [-- --strict] [-- --no-replay]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOUR_BLOCKS as SERVED_BLOCKS } from "../../packages/bff/src/routers/tour";
import {
  CHALLENGE_ANSWERS,
  HUMAN_CASE,
  TOUR_BLOCKS,
  TOUR_START_SIM,
  TOUR_STEPS,
  TOUR_STEP_IDS,
  type TourBlock,
  type TourStep,
  formatBudget,
  lookText,
  placeholdersOf,
} from "../../packages/web/src/views/tour/steps";

export const README_FILE = "README.md";
export const TOUR_START = "<!-- TOUR:START -->";
export const TOUR_END = "<!-- TOUR:END -->";
export const SCENARIOS_DIR = "scripts/scenarios";
export const SC21_PREFIX = "sc-21-";

/** The window every expected instant lives in: from the world's start to the human case's due date. */
export const TOUR_WINDOW = { startSim: TOUR_START_SIM, endSim: HUMAN_CASE.deadlineSim } as const;

const HEADER = ["| # | Step | Button / action | What to look at | Budget |", "|---|---|---|---|---|"];

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** The README's "Guided tour" block, in English: one table per block, with its time budget. */
export function renderReadmeSection(steps: readonly TourStep[] = TOUR_STEPS): string {
  const blocks: TourBlock[] = ["QUICK", "DEEP"];
  return blocks
    .map((block) => {
      const rows = steps.filter((step) => step.block === block).map((step) => `| ${step.id} | ${cell(step.title.en)} | ${cell(step.moves.map((move) => move.label.en).join(" · "))} | ${cell(lookText(step, "en"))} | ${formatBudget(step.budgetSeconds, "en")} |`);
      return [`**${TOUR_BLOCKS[block].en}**`, "", ...HEADER, ...rows].join("\n");
    })
    .join("\n\n");
}

function inWindow(instant: string): boolean {
  const at = Date.parse(instant);
  return at >= Date.parse(TOUR_WINDOW.startSim) && at <= Date.parse(TOUR_WINDOW.endSim);
}

/** Problems of the steps themselves; empty when they are consistent. */
export function validateSteps(steps: readonly TourStep[] = TOUR_STEPS): string[] {
  const errors: string[] = [];
  const ids = steps.map((step) => step.id);
  if (ids.join(",") !== TOUR_STEP_IDS.join(",")) errors.push(`steps are ${ids.join(", ")}; expected ${TOUR_STEP_IDS.join(", ")}`);
  for (const step of steps) {
    if (step.moves.length === 0) errors.push(`${step.id}: no button`);
    if (step.budgetSeconds < 0) errors.push(`${step.id}: negative budget`);
    const declared = Object.keys(step.facts).sort();
    for (const lang of ["es", "en"] as const) {
      const used = [...new Set(placeholdersOf(step.look[lang]))].sort();
      if (used.join(",") !== declared.join(",")) errors.push(`${step.id}: "${lang}" uses {${used.join(", ")}} but declares {${declared.join(", ")}}`);
      if (step.title[lang].trim() === "" || step.moves.some((move) => move.label[lang].trim() === "")) errors.push(`${step.id}: an empty "${lang}" text`);
    }
    for (const [name, fact] of Object.entries(step.facts)) {
      if (fact.format !== "text" && !inWindow(fact.expected)) errors.push(`${step.id}: {${name}} ${fact.expected} is outside the tour window`);
    }
    for (const move of step.moves) {
      if (move.kind !== "run" || move.action.kind !== "sendText") continue;
      const { persona, text } = move.action;
      if (persona === "C09" || CHALLENGE_ANSWERS[persona] !== text) errors.push(`${step.id}: “${text}” is not ${persona}'s challenge answer`);
    }
  }
  for (const block of ["QUICK", "DEEP"] as const) {
    const total = steps.filter((step) => step.block === block).reduce((sum, step) => sum + step.budgetSeconds, 0);
    if (total > TOUR_BLOCKS[block].budgetSeconds) errors.push(`${block}: the steps add up to ${total} s, over the block's ${TOUR_BLOCKS[block].budgetSeconds} s`);
  }
  return errors;
}

type ServedBlocks = readonly { readonly block: string; readonly budgetSeconds: number; readonly steps: readonly (readonly [string, number])[] }[];

/** The budgets steps.ts declares against the ones `tour.steps` serves. */
export function checkBudgets(steps: readonly TourStep[] = TOUR_STEPS, served: ServedBlocks = SERVED_BLOCKS): string[] {
  const errors: string[] = [];
  for (const block of served) {
    const own = TOUR_BLOCKS[block.block as TourBlock] as (typeof TOUR_BLOCKS)[TourBlock] | undefined;
    if (own === undefined) {
      errors.push(`tour.steps serves an unknown block ${block.block}`);
      continue;
    }
    if (own.budgetSeconds !== block.budgetSeconds) errors.push(`${block.block}: steps.ts budgets ${own.budgetSeconds} s, tour.steps ${block.budgetSeconds} s`);
    const mine = steps.filter((step) => step.block === block.block).map((step) => `${step.id}=${step.budgetSeconds}`);
    const theirs = block.steps.map(([id, seconds]) => `${id}=${seconds}`);
    if (mine.join(",") !== theirs.join(",")) errors.push(`${block.block}: steps.ts has ${mine.join(", ")}, tour.steps ${theirs.join(", ")}`);
  }
  return errors;
}

/** The block between the README markers; undefined when the markers are not there. */
export function readmeBlock(readme: string): string | undefined {
  const start = readme.indexOf(TOUR_START);
  const end = readme.indexOf(TOUR_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return readme.slice(start + TOUR_START.length, end).trim();
}

export function withReadmeBlock(readme: string, section: string): string {
  const start = readme.indexOf(TOUR_START);
  const end = readme.indexOf(TOUR_END);
  if (start === -1 || end === -1 || end < start) return readme;
  return `${readme.slice(0, start + TOUR_START.length)}\n${section}\n${readme.slice(end)}`;
}

export type Verdict = { readonly status: "ok" } | { readonly status: "pending"; readonly why: string } | { readonly status: "error"; readonly errors: readonly string[] };

export function checkReadme(readme: string | undefined, section: string = renderReadmeSection()): Verdict {
  if (readme === undefined) return { status: "pending", why: `${README_FILE} does not exist` };
  const block = readmeBlock(readme);
  if (block === undefined) return { status: "pending", why: `${README_FILE} has no ${TOUR_START} … ${TOUR_END} block yet` };
  if (block === section) return { status: "ok" };
  const want = section.split("\n");
  const have = block.split("\n");
  const errors = [`${README_FILE}: the guided tour differs from views/tour/steps.ts (run \`npm run tour:check -- --write\`):`];
  for (let line = 0; line < Math.max(want.length, have.length); line += 1) {
    if (want[line] !== have[line]) errors.push(`  line ${line + 1}: expected ${want[line] ?? "(nothing)"} / found ${have[line] ?? "(nothing)"}`);
  }
  return { status: "error", errors: errors.slice(0, 12) };
}

const STEPS_IMPORT = /from\s+["'][^"']*packages\/web\/src\/views\/tour\/steps(?:\.ts)?["']/;

/** SC-21 must take its steps from steps.ts: import the module and walk `TOUR_STEPS` or name every step. */
export function checkScenario(fileName: string | undefined, source: string | undefined, steps: readonly TourStep[] = TOUR_STEPS): Verdict {
  if (fileName === undefined || source === undefined) return { status: "pending", why: `${SCENARIOS_DIR}/${SC21_PREFIX}*.ts is not in the repository yet` };
  const errors: string[] = [];
  if (!STEPS_IMPORT.test(source)) errors.push(`${fileName}: does not import packages/web/src/views/tour/steps`);
  const walksAll = /\bTOUR_STEPS\b/.test(source);
  const missing = steps.filter((step) => !source.includes(`"${step.id}"`) && !source.includes(`'${step.id}'`)).map((step) => step.id);
  if (!walksAll && missing.length > 0) errors.push(`${fileName}: neither walks TOUR_STEPS nor names the steps ${missing.join(", ")}`);
  return errors.length === 0 ? { status: "ok" } : { status: "error", errors };
}

function scenarioFile(cwd: string): { name: string; source: string } | undefined {
  const dir = join(cwd, SCENARIOS_DIR);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((entry) => entry.startsWith(SC21_PREFIX) && entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
  return name === undefined ? undefined : { name: `${SCENARIOS_DIR}/${name}`, source: readFileSync(join(dir, name), "utf8") };
}

/** The replay over a local world; loaded lazily so the static checks never build a world. */
async function replayProblems(): Promise<{ problems: string[]; warnings: string[] }> {
  const [{ createLfTourWorld }, { walkTour }] = await Promise.all([import("./lf-world"), import("./timeline")]);
  const report = await walkTour(await createLfTourWorld());
  return { problems: report.problems.map((problem) => `replay: ${problem}`), warnings: [...report.warnings] };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const flags = new Set(process.argv.slice(2));
  const errors = [...validateSteps(), ...checkBudgets()].map((error) => `views/tour/steps.ts: ${error}`);
  const pending: string[] = [];
  const readmePath = join(cwd, README_FILE);
  const section = renderReadmeSection();
  let readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : undefined;
  if (flags.has("--write") && readme !== undefined && readmeBlock(readme) !== undefined && readmeBlock(readme) !== section) {
    readme = withReadmeBlock(readme, section);
    writeFileSync(readmePath, readme);
    console.log(`tour:check: rewrote the guided tour of ${README_FILE}.`);
  }
  const scenario = scenarioFile(cwd);
  for (const verdict of [checkReadme(readme, section), checkScenario(scenario?.name, scenario?.source)]) {
    if (verdict.status === "error") errors.push(...verdict.errors);
    if (verdict.status === "pending") pending.push(verdict.why);
  }
  if (!flags.has("--no-replay")) {
    const replay = await replayProblems();
    errors.push(...replay.problems);
    for (const warning of replay.warnings) console.warn(`tour:check: warning: ${warning}`);
  }
  if (flags.has("--strict")) errors.push(...pending.map((why) => `pending: ${why}`));
  if (errors.length > 0) {
    console.error(`tour:check: ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const note = pending.length > 0 ? `; pending: ${pending.join("; ")}` : "";
  console.log(`tour:check: ${TOUR_STEPS.length} step(s) consistent${flags.has("--no-replay") ? "" : ", replay reached every step"}${note}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
