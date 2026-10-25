// Runs a suite of scenarios against `poc` (docs/test-plan.md §4.4):
//
//   - up to 4 scenarios at a time on the QA queue; the scenarios of one lane run one after the other
//     (SC-22 then SC-21); then the `alone` ones, one by one; and a `last` scenario (SC-20) at the end,
//     with the results of every earlier one;
//   - inside a scenario the steps run in order; after a failed step the rest are SKIPPED, never retried
//     (a step that waits for the agent already admits the obligation turn the code enqueues);
//   - the cleanup always runs: the scenario's own, then per world its turns, its policy audit and
//     `world.destroy`;
//   - the budget is checked before each scenario: turns (`--max-turns`), the estimated cost
//     (`--max-cost-usd`, turns × the verified rate of one turn) and the estimated tokens per minute
//     (`--max-tpm`, turns × TOKENS_PER_TURN over the run's minutes: the runner pauses before starting
//     another scenario until it is back under the cap). Past the turns or the cost the rest are SKIPPED.
import { QA_REASON } from "@reclamo/bff/qa-driver/contract";
import type { DriverClient } from "./driver-client";
import { WaitTimeout, realSleep } from "./eventually";
import { type RunReport, type ScenarioResult, type StepResult, type Verdict, flowVerdicts, worst } from "./report";
import { AssertionFailed, DriverRefusal, ScenarioBug, type ScenarioContext, type ScenarioDef, type Suite, emptyRecord, stepContext } from "./steps";
import { cleanupWorlds } from "./world";

/** Supuesto (docs/test-plan.md §7): the upper bound of input plus output tokens of one turn. */
export const TOKENS_PER_TURN = 61_000;

export interface Budget {
  readonly maxTurns: number;
  readonly maxCostUsd?: number;
  /** Estimated tokens per minute of the whole run. */
  readonly maxTokensPerMinute: number;
  /** Verified USD of one agent turn (scripts/pricing, upper bound). */
  readonly usdPerTurn: number;
}

export interface RunOptions {
  readonly runId: string;
  readonly suite: Suite;
  readonly scenarios: readonly ScenarioDef[];
  readonly driver: DriverClient;
  readonly budget: Budget;
  readonly parallel?: number;
  readonly preflight?: RunReport["preflight"];
  /** Real time in ms (tests inject it). */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitOptions?: { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> };
  readonly log?: (line: string) => void;
}

/** Step number of the cleanup's own calls (keys `<runId>/<scenario>/999/…`). */
export const CLEANUP_STEP = 999;
/** How long the runner waits, at most, for the tokens per minute to come back under the cap. */
const MAX_THROTTLE_MS = 10 * 60_000;

function verdictOf(error: unknown): Verdict {
  if (error instanceof DriverRefusal && error.reason === QA_REASON.NOT_WIRED) return "BLOCKED";
  return "FAIL";
}

function describe(error: unknown): string {
  if (error instanceof AssertionFailed || error instanceof WaitTimeout || error instanceof DriverRefusal) return error.message;
  if (error instanceof ScenarioBug) return `scenario bug: ${error.message}`;
  // Only the name and message: an SDK error may carry request details.
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function runScenario(options: RunOptions, scenario: ScenarioDef, previous: ScenarioContext["previous"]): Promise<ScenarioResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const state: Record<string, unknown> = {};
  const base = { runId: options.runId, scenario, driver: options.driver, state, previous, ...(options.waitOptions ? { waitOptions: options.waitOptions } : {}) };
  const steps: StepResult[] = [];
  let failed = false;
  for (const step of scenario.steps) {
    const record = emptyRecord();
    const stepStarted = now();
    let verdict: Verdict = "PASS";
    let error: string | undefined;
    if (failed) verdict = "SKIPPED";
    else {
      try {
        await step.run(stepContext(base, step.n, record));
        if (record.warnings.length > 0) verdict = "WARN";
      } catch (caught) {
        verdict = verdictOf(caught);
        error = describe(caught);
        failed = true;
      }
    }
    steps.push({ step: step.n, title: step.title, flows: step.flows, verdict, durationMs: now() - stepStarted, ...record, ...(error === undefined ? {} : { error }) });
    options.log?.(`${scenario.id}/${step.n} ${verdict}${error ? ` · ${error}` : ""}`);
  }

  const cleanupCtx = stepContext(base, CLEANUP_STEP, emptyRecord());
  const errors: string[] = [];
  try {
    await scenario.cleanup?.(cleanupCtx);
  } catch (caught) {
    errors.push(describe(caught));
  }
  const cleanup = await cleanupWorlds(cleanupCtx);
  errors.push(...cleanup.errors);
  const auditVerdict: Verdict = cleanup.audits.every((audit) => audit.violations === 0) ? "PASS" : "FAIL";
  const verdict = worst([...steps.map((step) => step.verdict), auditVerdict, ...(errors.length > 0 ? (["WARN"] as const) : [])]);
  const turns = cleanup.usage.reduce((sum, item) => sum + item.turns, 0);
  return { scenario: scenario.id, title: scenario.title, verdict, durationMs: now() - started, steps, audits: cleanup.audits, turns, ...(errors.length > 0 ? { cleanupError: errors.join("; ") } : {}) };
}

function skipped(scenario: ScenarioDef, reason: string): ScenarioResult {
  return {
    scenario: scenario.id,
    title: scenario.title,
    verdict: "SKIPPED",
    durationMs: 0,
    steps: scenario.steps.map((step) => ({ step: step.n, title: step.title, flows: step.flows, verdict: "SKIPPED" as const, durationMs: 0, ids: {}, measures: {}, blocks: [], warnings: [], error: reason })),
    audits: [],
    turns: 0,
  };
}

/** Lanes of the parallel part (one per scenario, except those that share a lane), then the ones that run alone. */
export function lanesOf(scenarios: readonly ScenarioDef[]): { readonly lanes: ScenarioDef[][]; readonly alone: ScenarioDef[]; readonly last: ScenarioDef[] } {
  const lanes = new Map<string, ScenarioDef[]>();
  const alone: ScenarioDef[] = [];
  const last: ScenarioDef[] = [];
  for (const scenario of scenarios) {
    if (scenario.last || scenario.alone) {
      (scenario.last ? last : alone).push(scenario);
      continue;
    }
    const lane = scenario.lane ?? scenario.id;
    lanes.set(lane, [...(lanes.get(lane) ?? []), scenario]);
  }
  const ordered = [...lanes.values()].map((lane) => [...lane].sort((a, b) => (a.laneOrder ?? 0) - (b.laneOrder ?? 0)));
  return { lanes: ordered, alone, last };
}

/** Estimated tokens per minute of a run that spent `turns` turns in `elapsedMs`. */
export function tokensPerMinute(turns: number, elapsedMs: number): number {
  return (turns * TOKENS_PER_TURN) / Math.max(1, elapsedMs / 60_000);
}

export async function runSuite(options: RunOptions): Promise<RunReport> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const started = now();
  const spent = { turns: 0, aborted: undefined as string | undefined };
  const results = new Map<string, ScenarioResult>();
  const costOf = (turns: number) => Math.round(turns * options.budget.usdPerTurn * 10_000) / 10_000;
  const previous = () =>
    [...results.values()].map((result) => ({
      scenario: result.scenario,
      violations: result.audits.reduce((sum, audit) => sum + (audit.violations ?? 0), 0),
      unaudited: result.audits.filter((audit) => audit.violations === null).length,
    }));

  async function throttle(): Promise<void> {
    const since = now();
    while (tokensPerMinute(spent.turns, now() - started) > options.budget.maxTokensPerMinute && now() - since < MAX_THROTTLE_MS) {
      options.log?.(`budget: ~${Math.round(tokensPerMinute(spent.turns, now() - started))} tokens/min over the cap; pausing`);
      await sleep(30_000);
    }
  }

  async function runOne(scenario: ScenarioDef): Promise<void> {
    const { maxTurns, maxCostUsd } = options.budget;
    if (spent.turns >= maxTurns) spent.aborted ??= `turn budget of ${maxTurns} reached`;
    else if (maxCostUsd !== undefined && costOf(spent.turns) >= maxCostUsd) spent.aborted ??= `estimated cost budget of USD ${maxCostUsd} reached`;
    if (spent.aborted !== undefined) {
      results.set(scenario.id, skipped(scenario, spent.aborted));
      return;
    }
    await throttle();
    const result = await runScenario(options, scenario, previous());
    spent.turns += result.turns;
    results.set(scenario.id, result);
  }

  const { lanes, alone, last } = lanesOf(options.scenarios);
  const queue = [...lanes];
  const workers = Array.from({ length: Math.max(1, Math.min(options.parallel ?? 4, queue.length)) }, async () => {
    for (let lane = queue.shift(); lane !== undefined; lane = queue.shift()) for (const scenario of lane) await runOne(scenario);
  });
  await Promise.all(workers);
  for (const scenario of [...alone, ...last]) await runOne(scenario);

  const scenarios = options.scenarios.map((scenario) => results.get(scenario.id)).filter((result) => result !== undefined);
  return {
    runId: options.runId,
    suite: options.suite,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    durationMs: now() - started,
    verdict: worst(scenarios.map((result) => result.verdict)),
    ...(options.preflight ? { preflight: options.preflight } : {}),
    scenarios,
    flows: flowVerdicts(scenarios),
    budget: {
      maxTurns: options.budget.maxTurns,
      turns: spent.turns,
      ...(options.budget.maxCostUsd === undefined ? {} : { maxCostUsd: options.budget.maxCostUsd }),
      estimatedCostUsd: costOf(spent.turns),
      ...(spent.aborted ? { aborted: spent.aborted } : {}),
    },
  };
}
