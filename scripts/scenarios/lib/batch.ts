// `--suite batch`: the real-agent metrics batch (docs/seed-spec.md §13, docs/tool-catalog.md `batch.run`).
// The QaDriver builds the `sim-<runId>-<batchId>-<n>` worlds, sends the 30 presentations of
// `Seed/load/batch-inputs.jsonl` and, once every world is quiet, returns the run's record; this module
// prices it, refuses to start without the spend confirmed and covered, and polls `batch.run` under one
// key `<runId>/sc20-batch/1/<batchId>` (the metrics source of SC-20; CREATING and RUNNING are interim:
// the same key runs again) until DONE or the deadline.
// Publishing the record as the "Lote · agente real" tab is the operator's (scripts/metrics/publish-batch.ts):
// the runner's role never writes `Reference`.
import { BATCH_SIZE } from "@reclamo/bff/metrics/inputs";
import { idempotencyKeyOf } from "@reclamo/bff/qa-driver/contract";
import { perTurnUsd, shortCallUsd } from "../../pricing/estimate";
import { HAPPY_PATH } from "../../pricing/workload";
import type { DriverClient } from "./driver-client";
import { realSleep } from "./eventually";

/** Turns one presentation may cost: the agent's answer, plus the obligations the code enqueues after it. */
export const BATCH_TURNS_PER_PRESENTATION = { low: 1, high: 3 } as const;
export const DEFAULT_BATCH_ID = "b1";
/** The batch answers in minutes; past this the run reports the last state and fails. */
export const BATCH_TIMEOUT_MS = 60 * 60_000;
const POLL_EVERY_MS = 30_000;

export interface BatchSpend {
  readonly presentations: number;
  readonly turns: { readonly low: number; readonly high: number };
  readonly usd: { readonly low: number; readonly high: number };
}

const round = (usd: number): number => Math.round(usd * 100) / 100;

export function batchSpend(presentations: number = BATCH_SIZE): BatchSpend {
  const turns = { low: presentations * BATCH_TURNS_PER_PRESENTATION.low, high: presentations * BATCH_TURNS_PER_PRESENTATION.high };
  const usdOf = (bound: "low" | "high") => round(turns[bound] * perTurnUsd(HAPPY_PATH, bound) + presentations * shortCallUsd(HAPPY_PATH, bound).classifier);
  return { presentations, turns, usd: { low: usdOf("low"), high: usdOf("high") } };
}

/** Why the batch must not start, or undefined when the spend is confirmed and covered. */
export function batchRefusal(spend: BatchSpend, confirmed: boolean, maxCostUsd: number | undefined): string | undefined {
  if (!confirmed) return `the batch spends Bedrock (up to US$ ${spend.usd.high.toFixed(2)}): pass --confirm-spend once the CTO approved it`;
  if (maxCostUsd === undefined || !(maxCostUsd >= spend.usd.high)) return `--max-cost-usd must cover the high estimate of the batch (US$ ${spend.usd.high.toFixed(2)})`;
  return undefined;
}

export interface BatchOutcome {
  readonly state: string;
  readonly done: boolean;
  readonly polls: number;
  readonly result?: unknown;
  readonly error?: string;
}

export interface BatchRun {
  readonly runId: string;
  readonly batchId: string;
  readonly driver: DriverClient;
  readonly timeoutMs?: number;
  readonly everyMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

/** Polls `batch.run` until DONE, a refusal, or the deadline. Only states and counts are logged. */
export async function runBatch(run: BatchRun): Promise<BatchOutcome> {
  const now = run.now ?? Date.now;
  const sleep = run.sleep ?? realSleep;
  const deadline = now() + (run.timeoutMs ?? BATCH_TIMEOUT_MS);
  const key = idempotencyKeyOf({ runId: run.runId, scenario: "sc20-batch", step: 1, label: run.batchId });
  let state = "NOT_STARTED";
  for (let polls = 1; ; polls += 1) {
    const answer = await run.driver.call("batch.run", { runId: run.runId, batchId: run.batchId }, key);
    if (!answer.ok) return { state, done: false, polls, error: `${answer.error.code}${answer.error.reason ? ` ${answer.error.reason}` : ""}: ${answer.error.message}` };
    const result = answer.result as { state?: unknown } | undefined;
    state = typeof result?.state === "string" ? result.state : "UNKNOWN";
    run.log?.(`batch ${run.batchId}: ${state} (poll ${polls})`);
    if (state === "DONE") return { state, done: true, polls, result };
    if (now() + (run.everyMs ?? POLL_EVERY_MS) > deadline) return { state, done: false, polls, error: `still ${state} after ${Math.round((run.timeoutMs ?? BATCH_TIMEOUT_MS) / 60_000)} min` };
    await sleep(run.everyMs ?? POLL_EVERY_MS);
  }
}
