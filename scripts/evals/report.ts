// The report of a run of the evaluations (docs/test-plan.md §6: "with N and date"): `eval-report.json`
// and `eval-report.md`, run artifacts that are never committed. It carries the run, the commit, the
// dataset versions, the plan's spend estimate and, per eval, N, the gates with their thresholds and
// measured values, the informative figures and, for EV-1, the calibration ADR-0008 records. Pure but
// for `writeReport`. No body, address, phone or token ever reaches it: notes are case ids and reasons.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalPlan } from "./plan";
import { type EvalResult, type Gate, type Verdict, overall } from "./gates";

export const REPORT_FORMAT = "reclamo-eval-report/1";
export const THRESHOLDS_SOURCE = "docs/seed-spec.md §12";

export interface EvalReport {
  readonly format: typeof REPORT_FORMAT;
  readonly stage: string;
  readonly runId: string;
  readonly commit: string | null;
  /** Real instants of the run (the report's date is the real one, never a world's clock). */
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly date: string;
  readonly thresholdsSource: typeof THRESHOLDS_SOURCE;
  readonly plan: EvalPlan;
  readonly turnsBudgeted: number;
  readonly verdict: Verdict;
  readonly evals: readonly EvalResult[];
}

export interface ReportInput {
  readonly stage: string;
  readonly runId: string;
  readonly commit?: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly plan: EvalPlan;
  readonly turnsBudgeted: number;
  readonly evals: readonly EvalResult[];
}

export function buildReport(input: ReportInput): EvalReport {
  return {
    format: REPORT_FORMAT,
    stage: input.stage,
    runId: input.runId,
    commit: input.commit ?? null,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    date: input.finishedAt.toISOString().slice(0, 10),
    thresholdsSource: THRESHOLDS_SOURCE,
    plan: input.plan,
    turnsBudgeted: input.turnsBudgeted,
    verdict: overall(input.evals),
    evals: input.evals,
  };
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function gateRows(gates: readonly Gate[]): string[] {
  const rows = ["| Gate | What | Threshold | Measured | N | Verdict |", "|---|---|---|---|---|---|"];
  for (const gate of gates) rows.push(`| \`${gate.id}\` | ${cell(gate.label)} | ${cell(gate.threshold)} | ${cell(gate.measured)} | ${gate.n} | **${gate.verdict}** |`);
  const notes = gates.flatMap((gate) => gate.notes.map((note) => `- \`${gate.id}\` ${cell(note)}`));
  return notes.length === 0 ? rows : [...rows, "", ...notes];
}

function calibrationLines(result: EvalResult): string[] {
  const calibration = result.calibration;
  if (calibration === undefined) return [];
  const value = (number: number | undefined) => (number === undefined ? "—" : number.toFixed(2));
  const { scores } = calibration;
  return [
    "",
    "#### Grounding threshold calibration (ADR-0008)",
    "",
    `- Current threshold: ${value(calibration.currentThreshold)}`,
    `- Grounding scores seen: n = ${scores.n}, min ${value(scores.min)}, p05 ${value(scores.p05)}, p50 ${value(scores.p50)}, max ${value(scores.max)}`,
    `- Lowest sent score of a well-grounded question: ${value(calibration.goodSentMin)}`,
    `- Replies refused for grounding: ${calibration.refusedForGrounding} (${calibration.refusedInGoodQuestions} in well-grounded questions)`,
    `- Good replies judged on grounding (sent or refused for grounding): ${calibration.goodJudged}; below the current threshold: ${calibration.goodBelowCurrent}; below the proposal: ${calibration.goodBelowProposed ?? "—"}`,
    `- Proposed threshold: ${value(calibration.proposedThreshold)} (to be recorded in ADR-0008 by the architect; never applied by this run)`,
  ];
}

export function renderMarkdown(report: EvalReport): string {
  const lines = [
    `# Evaluations · ${report.stage} · ${report.date}`,
    "",
    `- Verdict: **${report.verdict}**`,
    `- Run: \`${report.runId}\` · commit \`${report.commit ?? "unknown"}\``,
    `- From ${report.startedAt} to ${report.finishedAt} (real time)`,
    `- Thresholds: ${report.thresholdsSource}`,
    `- Spend estimate: ${report.plan.turns.low}-${report.plan.turns.high} turns, ${report.plan.classifierCalls.low}-${report.plan.classifierCalls.high} classifier calls, ${report.plan.receiptReads} receipt reads, US$ ${report.plan.usd.low.toFixed(2)}-${report.plan.usd.high.toFixed(2)}; turn budget ${report.turnsBudgeted}`,
  ];
  for (const result of report.evals) {
    lines.push("", `## ${result.evalId} · ${result.title} · N = ${result.n} · **${result.verdict}**`, "", ...gateRows(result.gates));
    const info = Object.entries(result.info);
    if (info.length > 0) lines.push("", ...info.map(([key, value]) => `- ${key}: ${cell(String(value))}`));
    lines.push(...calibrationLines(result));
  }
  return `${lines.join("\n")}\n`;
}

/** Writes both files under `dir` (created if missing); returns their paths. */
export function writeReport(report: EvalReport, dir: string): { readonly json: string; readonly markdown: string } {
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "eval-report.json");
  const markdown = join(dir, "eval-report.md");
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
