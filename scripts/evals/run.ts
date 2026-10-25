// `npm run evals`: EV-1, EV-2 and EV-3 against `poc` through the QaDriver (docs/test-plan.md §6), or the
// SR gate alone. Runs only in CI with the qa-runner role, and only with the spend confirmed: the plan
// is priced first and printed; nothing is sent without `--confirm-spend` and a `--max-usd` that covers
// it. The report (N, date, gates, calibration) goes to `--out` as run artifacts, never committed.
//
//   npm run evals -- --plan-only [--eval ev1|ev2|ev3|all]          price the run, call nothing
//   npm run evals -- --eval all --confirm-spend --max-usd 60          the three evaluations
//   npm run evals -- --sr-gate --confirm-spend --max-usd 5            the SR subset × 5 alone
//
// Exit code: 0 when every gate is PASS, 1 otherwise (FAIL or BLOCKED), 2 when the run did not start.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../channels/cli-args";
import { loadEvalSets } from "./datasets";
import { STAGE, createEvalDriver, runIdFromEnv } from "./driver";
import { runEv1 } from "./ev1-grounding";
import { SR_REPETITIONS, runEv2 } from "./ev2-receipts";
import { runEv3 } from "./ev3-classifier";
import { type EvalId, type EvalResult, blockedEval } from "./gates";
import { EV1_TURNS_PER_QUESTION, EV2_TURNS_PER_PATH, TurnBudget, planOf, spendRefusal, srGatePlan } from "./plan";
import { buildReport, renderMarkdown, writeReport } from "./report";
import { scoreClassifier } from "./score-classifier";
import { scoreGrounding } from "./score-grounding";
import { scoreReceipts } from "./score-receipts";
import { runSrGate } from "./sr-gate";

export const DEFAULT_OUT = "test-results/evals";
const EVALS: Readonly<Record<string, readonly EvalId[]>> = { ev1: ["EV-1"], ev2: ["EV-2"], ev3: ["EV-3"], all: ["EV-1", "EV-2", "EV-3"] };

export interface RunOptions {
  readonly evals: readonly EvalId[];
  readonly srGate: boolean;
  readonly planOnly: boolean;
  readonly confirmSpend: boolean;
  readonly maxUsd?: number;
  readonly maxTurns?: number;
  readonly out: string;
}

export function parseRunOptions(argv: readonly string[]): RunOptions {
  let evals: readonly EvalId[] = EVALS.all ?? [];
  let srGate = false;
  let planOnly = false;
  let confirmSpend = false;
  let maxUsd: number | undefined;
  let maxTurns: number | undefined;
  let out = DEFAULT_OUT;
  const positive = (raw: string, flag: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${flag} needs a positive number`);
    return value;
  };
  parseFlags(argv, {
    "--eval": (value) => {
      const name = value();
      const selected = EVALS[name];
      if (selected === undefined) throw new RangeError(`--eval is one of ${Object.keys(EVALS).join(", ")}`);
      evals = selected;
    },
    "--sr-gate": () => {
      srGate = true;
    },
    "--plan-only": () => {
      planOnly = true;
    },
    "--confirm-spend": () => {
      confirmSpend = true;
    },
    "--max-usd": (value) => {
      maxUsd = positive(value(), "--max-usd");
    },
    "--max-turns": (value) => {
      maxTurns = Math.floor(positive(value(), "--max-turns"));
    },
    "--out": (value) => {
      out = value();
    },
  });
  return { evals: srGate ? ["EV-2"] : evals, srGate, planOnly, confirmSpend, ...(maxUsd === undefined ? {} : { maxUsd }), ...(maxTurns === undefined ? {} : { maxTurns }), out };
}

async function main(): Promise<number> {
  const options = parseRunOptions(process.argv.slice(2));
  const sets = loadEvalSets();
  const plan = options.srGate ? srGatePlan(sets) : planOf(options.evals, sets);
  console.log(`evals: ${options.srGate ? "SR gate" : plan.evals.join(", ")} · ${plan.turns.low}-${plan.turns.high} turns · ${plan.receiptReads} reads · US$ ${plan.usd.low.toFixed(2)}-${plan.usd.high.toFixed(2)}`);
  if (options.planOnly) return 0;
  const refusal = spendRefusal(plan, options.confirmSpend, options.maxUsd);
  if (refusal !== undefined) {
    console.error(`evals: not started: ${refusal}`);
    return 2;
  }
  const runId = runIdFromEnv(process.env);
  const driver = createEvalDriver({ runId });
  const budget = new TurnBudget(options.maxTurns ?? plan.turns.high);
  const startedAt = new Date();
  const results: EvalResult[] = [];
  const attempt = async (evalId: EvalId, title: string, n: number, run: () => Promise<EvalResult>) => {
    try {
      results.push(await run());
    } catch (error) {
      results.push(blockedEval(evalId, title, n, error instanceof Error ? error.message : String(error)));
    }
  };
  if (options.srGate) {
    await attempt("EV-2", "Receipt reading · SR subset before the full suite", sets.receipts.srSubset.length * SR_REPETITIONS, async () => (await runSrGate(driver, sets.receipts)).result);
  } else {
    if (options.evals.includes("EV-1")) {
      await attempt("EV-1", "Grounding", sets.grounding.entries.length, async () =>
        scoreGrounding(sets.grounding, await runEv1(driver, { set: sets.grounding, models: sets.models, withinBudget: () => budget.take(EV1_TURNS_PER_QUESTION) })),
      );
    }
    if (options.evals.includes("EV-2")) {
      await attempt("EV-2", "Receipt reading", plan.receiptReads, async () =>
        scoreReceipts(sets.receipts, await runEv2(driver, { set: sets.receipts, models: sets.models, withinBudget: () => budget.take(EV2_TURNS_PER_PATH) }), SR_REPETITIONS),
      );
    }
    if (options.evals.includes("EV-3")) {
      await attempt("EV-3", "Intake classifier", sets.classifier.entries.length, async () =>
        scoreClassifier(sets.classifier, await runEv3(driver, { set: sets.classifier, models: sets.models, withinBudget: () => budget.take(0) })),
      );
    }
  }
  const report = buildReport({ stage: STAGE, runId, ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}), startedAt, finishedAt: new Date(), plan, turnsBudgeted: budget.max, evals: results });
  const files = writeReport(report, options.out);
  console.log(renderMarkdown(report));
  console.log(`evals: ${report.verdict} · report in ${files.json} and ${files.markdown}`);
  return report.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
