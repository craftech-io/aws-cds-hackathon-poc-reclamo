// Scenario runner against the deployed stage `poc` (docs/test-plan.md §4-§5, ADR-0009). It talks to the
// stage only through the `QaDriver` Lambda with the `qa-runner` role that CI assumes by OIDC: deploy.yml
// runs the smoke after a deploy only with the repository variable DEPLOY_CHECKS=on (`--suite smoke`,
// SC-00), and scenarios.yml every suite by hand. There is no laptop path: the role trusts only those two
// workflows on main.
//
//   npm run scenarios -- --suite smoke|full [--scenario SC-xx]… [--run-id <run>-<attempt>] [--max-turns <n>]
//                        [--max-cost-usd <n>] [--max-tpm <n>] [--parallel <n>] [--report-dir <dir>] [--force]
//   npm run scenarios -- --scenario SC-23 --live           live WhatsApp, attended, approved world only
//   npm run scenarios -- --merge <scenario-report.json>…   pass rate per step and flow over several runs
//   npm run scenarios -- --suite eval -- <evals args>      the evaluations: everything after `--` goes to
//                                                          scripts/evals/run.ts (`--eval all --confirm-spend --max-usd 60`)
//   npm run scenarios -- --suite batch --confirm-spend --max-cost-usd <n> [--batch-id b1]
//                                                          the real-agent metrics batch (`batch.run`)
//
// The full suite (no scenario named) is preceded by the SR subset of EV-2 (lib/precondition.ts): if it
// is not an exact PASS, no scenario runs and the run fails. A `--max-cost-usd` must cover the gate.
//
// Writes `scenario-report.json` and `scenario-report.md` under test-results/ (artifacts, never committed)
// and exits 1 unless every scenario passed (a WARN passes; BLOCKED, SKIPPED and FAIL do not); 2 when the
// run did not start. Before the full suite it waits until nobody used the agent for 15 minutes (`--force`
// goes on regardless).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunId } from "@reclamo/bff/qa-driver/contract";
import { parseFlags } from "../channels/cli-args";
import { loadEvalSets } from "../evals/datasets";
import { createEvalDriver } from "../evals/driver";
import { srGatePlan } from "../evals/plan";
import { runSrGate } from "../evals/sr-gate";
import { HAPPY_PATH } from "../pricing/workload";
import { perTurnUsd } from "../pricing/estimate";
import { DEFAULT_BATCH_ID, batchRefusal, batchSpend, runBatch } from "./lib/batch";
import { createDriverClient } from "./lib/driver-client";
import { runGatedFullSuite } from "./lib/precondition";
import { cloudWatchTurnCounter, noGuestsActive } from "./lib/preflight";
import { type RunReport, writePassRates, writeReport } from "./lib/report";
import { runSuite } from "./lib/runner";
import type { Suite } from "./lib/steps";
import { loadScenarios, namedScenarios, scenariosOf } from "./lib/suites";

export type RunSuite = Suite | "eval" | "batch";

export interface RunArgs {
  readonly suite: RunSuite;
  readonly scenarios: readonly string[];
  readonly runId?: string;
  readonly maxTurns: number;
  readonly maxCostUsd?: number;
  readonly maxTokensPerMinute: number;
  readonly parallel: number;
  readonly reportDir: string;
  readonly force: boolean;
  readonly merge: readonly string[];
  /** SC-23 against the product's own number (`SCENARIOS_LIVE=1` for the scenario). */
  readonly live: boolean;
  /** `--suite eval`: the arguments after `--`, handed to scripts/evals/run.ts as they are. */
  readonly evalArgs: readonly string[];
  /** `--suite batch`: the CTO approved the spend. */
  readonly confirmSpend: boolean;
  readonly batchId: string;
}

/** Turn budget per run when none is given (docs/test-plan.md §4.4: 450 for the full suite). */
export const DEFAULT_MAX_TURNS: Readonly<Record<Suite, number>> = { smoke: 40, full: 450 };
/** Estimated tokens per minute of the whole run (turns × TOKENS_PER_TURN over the run's minutes). */
export const DEFAULT_MAX_TPM = 1_000_000;

/** `<github run id>-<attempt>` (docs/test-plan.md §4.4); runs exist only in CI. */
export function defaultRunId(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const run = env.GITHUB_RUN_ID;
  return run !== undefined && /^\d+$/.test(run) ? `${run}-${env.GITHUB_RUN_ATTEMPT ?? "1"}` : undefined;
}

function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new RangeError(`${name} needs a positive number`);
  return parsed;
}

export function parseRunArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): RunArgs {
  let suite: RunArgs["suite"] | undefined;
  const scenarios: string[] = [];
  const merge: string[] = [];
  let runId = defaultRunId(env);
  let maxTurns: number | undefined;
  let maxCostUsd: number | undefined;
  let maxTokensPerMinute = DEFAULT_MAX_TPM;
  let parallel = 4;
  let reportDir = "test-results/scenarios";
  let force = false;
  let live = false;
  let confirmSpend = false;
  let batchId = DEFAULT_BATCH_ID;
  const separator = argv.indexOf("--");
  const evalArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  const rest = separator >= 0 ? argv.slice(0, separator) : [...argv];
  const mergeAt = rest.indexOf("--merge");
  if (mergeAt >= 0) merge.push(...rest.splice(mergeAt).slice(1));
  parseFlags(rest, {
    "--suite": (value) => {
      const name = value();
      if (name !== "smoke" && name !== "full" && name !== "eval" && name !== "batch") throw new RangeError("--suite is smoke, full, eval or batch");
      suite = name;
    },
    "--scenario": (value) => void scenarios.push(value()),
    "--run-id": (value) => {
      runId = RunId.parse(value());
    },
    "--max-turns": (value) => {
      maxTurns = Math.floor(positive("--max-turns", value()));
    },
    "--max-cost-usd": (value) => {
      maxCostUsd = positive("--max-cost-usd", value());
    },
    "--max-tpm": (value) => {
      maxTokensPerMinute = positive("--max-tpm", value());
    },
    "--parallel": (value) => {
      parallel = Math.min(4, Math.floor(positive("--parallel", value())));
    },
    "--report-dir": (value) => {
      reportDir = value();
    },
    "--force": () => {
      force = true;
    },
    "--live": () => {
      live = true;
    },
    "--confirm-spend": () => {
      confirmSpend = true;
    },
    "--batch-id": (value) => {
      const id = value();
      if (!/^[a-z0-9]{1,10}$/.test(id)) throw new RangeError("--batch-id is 1-10 lowercase letters or digits");
      batchId = id;
    },
  });
  if (live && !scenarios.includes("SC-23")) throw new RangeError("--live runs SC-23 only: name it with --scenario SC-23");
  if (merge.length > 0 && (suite !== undefined || scenarios.length > 0)) throw new RangeError("--merge reads reports; it runs nothing");
  const chosen = suite ?? (scenarios.length > 0 ? "full" : "smoke");
  if (separator >= 0 && chosen !== "eval") throw new RangeError("arguments after -- go to the evaluations: use them with --suite eval");
  if (chosen === "eval" && scenarios.length > 0) throw new RangeError("--suite eval runs no scenario");
  if (confirmSpend && chosen !== "batch") throw new RangeError("--confirm-spend here is for --suite batch; the evaluations take it after --");
  const turns = chosen === "eval" || chosen === "batch" ? 0 : (maxTurns ?? DEFAULT_MAX_TURNS[chosen]);
  return { suite: chosen, scenarios, ...(runId === undefined ? {} : { runId }), maxTurns: turns, ...(maxCostUsd === undefined ? {} : { maxCostUsd }), maxTokensPerMinute, parallel, reportDir, force, merge, live, evalArgs, confirmSpend, batchId };
}

/** The full suite, not a list of named scenarios: the SR gate of EV-2 runs first (docs/test-plan.md §5). */
export function needsSrGate(args: Pick<RunArgs, "suite" | "scenarios">): boolean {
  return args.suite === "full" && args.scenarios.length === 0;
}

function evals(args: RunArgs): number {
  if (!existsSync("scripts/evals/run.ts")) throw new Error("scripts/evals/run.ts is not in the repository yet");
  return spawnSync("npx", ["tsx", "scripts/evals/run.ts", ...args.evalArgs], { stdio: "inherit" }).status ?? 1;
}

async function batch(args: RunArgs, runId: string): Promise<number> {
  const spend = batchSpend();
  console.log(`scenarios: batch ${args.batchId} · ${spend.presentations} presentations · ${spend.turns.low}-${spend.turns.high} turns · US$ ${spend.usd.low.toFixed(2)}-${spend.usd.high.toFixed(2)}`);
  const refusal = batchRefusal(spend, args.confirmSpend, args.maxCostUsd);
  if (refusal !== undefined) {
    console.error(`scenarios: not started: ${refusal}`);
    return 2;
  }
  const outcome = await runBatch({ runId, batchId: args.batchId, driver: createDriverClient(), log: (line) => console.log(`  ${line}`) });
  await mkdir(args.reportDir, { recursive: true });
  const file = join(args.reportDir, "batch-report.json");
  await writeFile(file, `${JSON.stringify({ runId, batchId: args.batchId, spend, ...outcome }, null, 2)}\n`);
  console.log(`scenarios: batch ${outcome.done ? "DONE" : `not done (${outcome.error ?? outcome.state})`} · ${file} · publish with scripts/metrics/publish-batch.ts (operator)`);
  return outcome.done ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseRunArgs(process.argv.slice(2), process.env);
  if (args.merge.length > 0) {
    const rates = await writePassRates(args.reportDir, args.merge);
    console.log(`scenarios: pass rates over ${rates.runs.length} run(s) · ${rates.unproven.length} step(s) or flow(s) not proven`);
    return rates.unproven.length === 0 ? 0 : 1;
  }
  if (args.suite === "eval") return evals(args);
  if (args.runId === undefined) throw new Error("no run id: the runner runs in CI (GITHUB_RUN_ID) or with --run-id <run>-<attempt>");
  const runId = args.runId;
  if (args.suite === "batch") return batch(args, runId);
  const suite = args.suite;
  // SC-23 reads the flag from its environment: without it, its first step is BLOCKED, never run.
  if (args.live) process.env["SCENARIOS_LIVE"] = "1";
  const all = await loadScenarios();
  const scenarios = args.scenarios.length > 0 ? namedScenarios(all, args.scenarios) : scenariosOf(all, suite);
  const preflight = suite === "full" ? await noGuestsActive({ count: cloudWatchTurnCounter(), force: args.force, log: (line) => console.log(line) }) : undefined;
  const usdPerTurn = perTurnUsd(HAPPY_PATH, "high");
  console.log(`scenarios: run ${runId} · ${suite} · ${scenarios.map((scenario) => scenario.id).join(", ")} · max ${args.maxTurns} turns · ~USD ${usdPerTurn}/turn`);
  const suiteRun = (maxCostUsd: number | undefined): Promise<RunReport> =>
    runSuite({
      runId,
      suite,
      scenarios,
      driver: createDriverClient(),
      budget: { maxTurns: args.maxTurns, ...(maxCostUsd === undefined ? {} : { maxCostUsd }), maxTokensPerMinute: args.maxTokensPerMinute, usdPerTurn },
      parallel: args.parallel,
      ...(preflight ? { preflight } : {}),
      log: (line) => console.log(`  ${line}`),
    });
  let report: RunReport;
  if (needsSrGate(args)) {
    const sets = loadEvalSets();
    const plan = srGatePlan(sets);
    console.log(`scenarios: SR gate first · ${plan.receiptReads} reads · up to US$ ${plan.usd.high.toFixed(2)}`);
    report = await runGatedFullSuite({
      runId,
      maxTurns: args.maxTurns,
      gateUsdHigh: plan.usd.high,
      ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
      gate: () => runSrGate(createEvalDriver({ runId }), sets.receipts),
      suite: suiteRun,
      log: (line) => console.log(`  ${line}`),
    });
  } else report = await suiteRun(args.maxCostUsd);
  const written = await writeReport(args.reportDir, report);
  console.log(`scenarios: ${report.verdict} in ${Math.round(report.durationMs / 1_000)} s · ${report.budget.turns} turn(s) · ~USD ${report.budget.estimatedCostUsd} · ${written.markdown}`);
  return report.verdict === "PASS" || report.verdict === "WARN" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await main());
  } catch (error) {
    // Only the name and message: an SDK error may carry request details.
    console.error(`scenarios: ${error instanceof Error ? `${error.name}: ${error.message}` : "failed"}`);
    process.exit(2);
  }
}
