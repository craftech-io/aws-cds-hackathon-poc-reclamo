// Chequeo previo "sin invitados" (docs/test-plan.md §4.4): before a full suite the runner looks at
// `ReclamoAgent/TurnLatency` of the last 15 minutes (the qa-runner role may read `cloudwatch:GetMetricData`)
// and, while somebody is using the product, waits up to 30 minutes for them to stop, or needs `--force`.
// The series without dimensions counts the turns of every worker; no QA run of this app overlaps
// another (the `scenarios-poc` and `deploy-poc` concurrency groups), so the turns before a suite starts
// are guests' (gNN, gtest and the self-signup worlds `gs-*`), the operator's `demo`, or the tail of the
// previous run: waiting them out is the right call in every case. Only counts are read; no world is named.
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { REGION } from "./driver-client";
import { realSleep } from "./eventually";

export const AGENT_NAMESPACE = "ReclamoAgent";
export const ACTIVITY_WINDOW_MIN = 15;
export const MAX_WAIT_MIN = 30;
const POLL_EVERY_MS = 60_000;

/** Turns of the agent in the last `windowMin` minutes. */
export type TurnCounter = (windowMin: number) => Promise<number>;

export function cloudWatchTurnCounter(client = new CloudWatchClient({ region: REGION, maxAttempts: 3 })): TurnCounter {
  return async (windowMin) => {
    const end = new Date();
    const start = new Date(end.getTime() - windowMin * 60_000);
    const answer = await client.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: [{ Id: "turns", MetricStat: { Metric: { Namespace: AGENT_NAMESPACE, MetricName: "TurnLatency" }, Period: 60, Stat: "SampleCount" } }],
      }),
    );
    return (answer.MetricDataResults?.[0]?.Values ?? []).reduce((sum, value) => sum + value, 0);
  };
}

export interface PreflightResult {
  readonly guestTurns: number;
  readonly waitedSec: number;
  readonly forced: boolean;
}

export class GuestsActive extends Error {
  override readonly name = "GuestsActive";
}

export interface PreflightOptions {
  readonly count: TurnCounter;
  readonly force: boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

/** Waits until nobody used the agent for 15 minutes (at most 30 minutes); `--force` goes on regardless. */
export async function noGuestsActive(options: PreflightOptions): Promise<PreflightResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const started = now();
  let turns = await options.count(ACTIVITY_WINDOW_MIN);
  if (options.force) return { guestTurns: turns, waitedSec: 0, forced: true };
  while (turns > 0) {
    const waited = now() - started;
    if (waited >= MAX_WAIT_MIN * 60_000) throw new GuestsActive(`${turns} agent turn(s) in the last ${ACTIVITY_WINDOW_MIN} minutes after waiting ${MAX_WAIT_MIN} minutes: run with --force, or later`);
    options.log?.(`preflight: ${turns} agent turn(s) in the last ${ACTIVITY_WINDOW_MIN} minutes; waiting`);
    await sleep(POLL_EVERY_MS);
    turns = await options.count(ACTIVITY_WINDOW_MIN);
  }
  return { guestTurns: 0, waitedSec: Math.round((now() - started) / 1_000), forced: false };
}

/**
 * Turns that ended with `stopReason` (`max_tokens`) since `sinceMs`, from `ReclamoAgent/TurnErrors`
 * (docs/test-plan.md §7: 0 `max_tokens`). Metrics land a minute or two late; the caller allows for it.
 */
export async function turnErrors(stopReason: string, sinceMs: number, client = new CloudWatchClient({ region: REGION, maxAttempts: 3 })): Promise<number> {
  const answer = await client.send(
    new GetMetricDataCommand({
      StartTime: new Date(sinceMs - 60_000),
      EndTime: new Date(Date.now() + 60_000),
      MetricDataQueries: [{ Id: "errors", MetricStat: { Metric: { Namespace: AGENT_NAMESPACE, MetricName: "TurnErrors", Dimensions: [{ Name: "stopReason", Value: stopReason }] }, Period: 60, Stat: "Sum" } }],
    }),
  );
  return (answer.MetricDataResults?.[0]?.Values ?? []).reduce((sum, value) => sum + value, 0);
}
