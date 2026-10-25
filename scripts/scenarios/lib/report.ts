// `scenario-report.json` and `scenario-report.md` (docs/test-plan.md §4.4): per step its flows, verdict,
// ids, duration, measures and where every block came from; per scenario the policy audit of its worlds
// and the turns it used; per flow one verdict over every step that declares it. Artifacts of the CI run,
// never committed (they land under `test-results/`). No PII: ids, codes, counts and durations only.
//
// "100 % probada" needs three runs in a row (§1.3): `passRates` merges the reports of several runs into
// the pass rate of every step and flow (`3/3`); anything below every run is not proven.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlockOrigin, Suite } from "./steps";

/** `BLOCKED`: the step could not run because what it drives is not deployed (`NOT_WIRED`); never a pass. */
export type Verdict = "PASS" | "WARN" | "FAIL" | "BLOCKED" | "SKIPPED";

export interface StepResult {
  readonly step: number;
  readonly title: string;
  readonly flows: readonly string[];
  readonly verdict: Verdict;
  readonly durationMs: number;
  readonly ids: Readonly<Record<string, string>>;
  readonly measures: Readonly<Record<string, number>>;
  readonly blocks: ReadonlyArray<{ readonly origin: BlockOrigin; readonly detail: string }>;
  readonly warnings: readonly string[];
  readonly error?: string;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly title: string;
  readonly verdict: Verdict;
  readonly durationMs: number;
  readonly steps: readonly StepResult[];
  /** Policy audit of each world the scenario created (`policyAudit.run` before `world.destroy`). */
  readonly audits: ReadonlyArray<{ readonly worldId: string; readonly violations: number | null }>;
  readonly turns: number;
  readonly cleanupError?: string;
}

export interface RunReport {
  readonly runId: string;
  readonly suite: Suite;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly verdict: Verdict;
  readonly preflight?: { readonly guestTurns: number; readonly waitedSec: number; readonly forced: boolean };
  readonly scenarios: readonly ScenarioResult[];
  readonly flows: Readonly<Record<string, Verdict>>;
  readonly budget: { readonly maxTurns: number; readonly turns: number; readonly maxCostUsd?: number; readonly estimatedCostUsd: number; readonly aborted?: string };
  /** The SR subset of EV-2 that precedes the full suite (lib/precondition.ts); absent for the smoke. */
  readonly srGate?: { readonly verdict: Verdict; readonly n: number; readonly measured: string; readonly notes: readonly string[]; readonly usdHigh: number };
}

const SEVERITY: readonly Verdict[] = ["FAIL", "BLOCKED", "SKIPPED", "WARN", "PASS"];

/** The worst of several verdicts (FAIL over BLOCKED over SKIPPED over WARN over PASS). */
export function worst(verdicts: readonly Verdict[]): Verdict {
  for (const verdict of SEVERITY) if (verdicts.includes(verdict)) return verdict;
  return "SKIPPED";
}

export const passed = (verdict: Verdict): boolean => verdict === "PASS" || verdict === "WARN";

/** One verdict per flow over every step that declares it. */
export function flowVerdicts(scenarios: readonly ScenarioResult[]): Record<string, Verdict> {
  const byFlow = new Map<string, Verdict[]>();
  for (const scenario of scenarios) for (const step of scenario.steps) for (const flow of step.flows) byFlow.set(flow, [...(byFlow.get(flow) ?? []), step.verdict]);
  return Object.fromEntries([...byFlow.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([flow, verdicts]) => [flow, worst(verdicts)]));
}

export interface PassRate {
  readonly passed: number;
  readonly runs: number;
}

export interface PassRates {
  readonly runs: readonly string[];
  /** `SC-01/5` → passes over the runs that had the step. */
  readonly steps: Readonly<Record<string, PassRate>>;
  readonly flows: Readonly<Record<string, PassRate>>;
  /** Steps and flows that did not pass in every run: not proven (§1.3). */
  readonly unproven: readonly string[];
}

/** Pass rate per step and per flow over several runs of the suite. */
export function passRates(reports: readonly RunReport[]): PassRates {
  const steps = new Map<string, { passed: number; runs: number }>();
  const flows = new Map<string, { passed: number; runs: number }>();
  const add = (map: Map<string, { passed: number; runs: number }>, key: string, ok: boolean) => {
    const rate = map.get(key) ?? { passed: 0, runs: 0 };
    map.set(key, { passed: rate.passed + (ok ? 1 : 0), runs: rate.runs + 1 });
  };
  for (const report of reports) {
    for (const scenario of report.scenarios) for (const step of scenario.steps) add(steps, `${scenario.scenario}/${step.step}`, passed(step.verdict));
    for (const [flow, verdict] of Object.entries(report.flows)) add(flows, flow, passed(verdict));
  }
  const sorted = (map: Map<string, PassRate>) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
  const unproven = [...steps.entries(), ...flows.entries()].filter(([, rate]) => rate.passed < reports.length).map(([key]) => key);
  return { runs: reports.map((report) => report.runId), steps: sorted(steps), flows: sorted(flows), unproven };
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function measuresOf(step: StepResult): string {
  return Object.entries(step.measures).map(([name, value]) => `${name}=${Math.round(value)}`).join(" ");
}

export function renderMarkdown(report: RunReport): string {
  const budget = report.budget;
  const lines = [
    `# Scenario run ${report.runId} · ${report.suite}`,
    "",
    `Verdict **${report.verdict}** · ${report.scenarios.length} scenario(s) · ${Math.round(report.durationMs / 1_000)} s · ${budget.turns}/${budget.maxTurns} turns · estimated USD ${budget.estimatedCostUsd}${budget.aborted ? ` · aborted: ${budget.aborted}` : ""}`,
    ...(report.srGate ? ["", `SR gate (EV-2 SR subset × 5, before the suite): **${report.srGate.verdict}** · ${report.srGate.measured} · N = ${report.srGate.n} · up to USD ${report.srGate.usdHigh}${report.srGate.notes.length > 0 ? ` · ${cell(report.srGate.notes.join("; "))}` : ""}`] : []),
    ...(report.preflight ? ["", `Preflight: ${report.preflight.guestTurns} guest turn(s) in the last 15 min · waited ${report.preflight.waitedSec} s${report.preflight.forced ? " · forced" : ""}`] : []),
    "",
    "| Scenario | Step | Flows | Verdict | Seconds | Measures | Blocks | Detail |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const scenario of report.scenarios) {
    for (const step of scenario.steps) {
      const blocks = step.blocks.map((block) => `${block.origin}: ${block.detail}`).join("; ");
      const detail = [step.error, ...step.warnings].filter((item) => item !== undefined).join("; ");
      lines.push(`| ${scenario.scenario} | ${step.step} ${cell(step.title)} | ${step.flows.join(", ")} | ${step.verdict} | ${Math.round(step.durationMs / 1_000)} | ${measuresOf(step)} | ${cell(blocks)} | ${cell(detail)} |`);
    }
    const audits = scenario.audits.map((audit) => `${audit.worldId}: ${audit.violations ?? "not run"}`).join(", ");
    lines.push(`| ${scenario.scenario} | policy audit | FL-075 | ${scenario.audits.every((audit) => audit.violations === 0) ? "PASS" : "FAIL"} | — | turns=${scenario.turns} | — | ${cell(audits)}${scenario.cleanupError ? ` · cleanup: ${cell(scenario.cleanupError)}` : ""} |`);
  }
  lines.push("", "| Flow | Verdict |", "|---|---|", ...Object.entries(report.flows).map(([flow, verdict]) => `| ${flow} | ${verdict} |`));
  return `${lines.join("\n")}\n`;
}

export function renderRates(rates: PassRates): string {
  const row = ([key, rate]: [string, PassRate]) => `| ${key} | ${rate.passed}/${rate.runs} |`;
  return [
    `# Pass rate over ${rates.runs.length} run(s): ${rates.runs.join(", ")}`,
    "",
    rates.unproven.length === 0 ? "Every step and flow passed in every run." : `Not proven: ${rates.unproven.join(", ")}`,
    "",
    "| Step | Passed |",
    "|---|---|",
    ...Object.entries(rates.steps).map(row),
    "",
    "| Flow | Passed |",
    "|---|---|",
    ...Object.entries(rates.flows).map(row),
    "",
  ].join("\n");
}

export async function writeReport(directory: string, report: RunReport): Promise<{ readonly json: string; readonly markdown: string }> {
  await mkdir(directory, { recursive: true });
  const json = join(directory, "scenario-report.json");
  const markdown = join(directory, "scenario-report.md");
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdown, renderMarkdown(report));
  return { json, markdown };
}

/** Merges the reports of several runs (`--merge a.json b.json c.json`) into `pass-rates.{json,md}`. */
export async function writePassRates(directory: string, files: readonly string[]): Promise<PassRates> {
  const reports = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as RunReport));
  const rates = passRates(reports);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "pass-rates.json"), `${JSON.stringify(rates, null, 2)}\n`);
  await writeFile(join(directory, "pass-rates.md"), renderRates(rates));
  return rates;
}
