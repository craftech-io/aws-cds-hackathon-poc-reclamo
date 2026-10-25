// What a run of the evaluations will spend, priced before anything is sent (docs/test-plan.md §4.4 and
// §7; the rate card of WP-46): turns of the agent, classifier calls and receipt reads, each with a
// `low` and a `high` bound. The run refuses to start without `--confirm-spend` and a `--max-usd` that
// covers the `high` bound (evaluations on the stage spend Bedrock: they run only with the CTO's OK),
// and stops a conversation short when the turn budget is spent.
import { perTurnUsd, shortCallUsd } from "../pricing/estimate";
import { HAPPY_PATH } from "../pricing/workload";
import type { EvalSets } from "./datasets";
import { FULL_PATH_IDS, SR_REPETITIONS } from "./ev2-receipts";
import type { EvalId } from "./gates";

/** Upper bound of agent turns per conversation: the message, two challenge answers. */
export const EV1_TURNS_PER_QUESTION = 3;
/** Complaint, two answers, the receipt, two answers, RECONCILE_DUE and ANSWER_DUE obligations. */
export const EV2_TURNS_PER_PATH = 8;

export interface Bounds {
  readonly low: number;
  readonly high: number;
}

export interface EvalPlan {
  readonly evals: readonly EvalId[];
  readonly turns: Bounds;
  readonly classifierCalls: Bounds;
  readonly receiptReads: number;
  readonly usd: Bounds;
}

const round = (usd: number): number => Math.round(usd * 100) / 100;

export function planOf(evals: readonly EvalId[], sets: Pick<EvalSets, "grounding" | "receipts" | "classifier">): EvalPlan {
  const has = (id: EvalId) => evals.includes(id);
  const questions = has("EV-1") ? sets.grounding.entries.length : 0;
  const paths = has("EV-2") ? FULL_PATH_IDS.length : 0;
  const messages = has("EV-3") ? sets.classifier.entries.length : 0;
  // EV-3 runs without turns (`intakeOnly`); a world that ignores it spends one before the eval stops.
  const turns = { low: questions + paths * 3, high: questions * EV1_TURNS_PER_QUESTION + paths * EV2_TURNS_PER_PATH + (messages > 0 ? 1 : 0) };
  // Every customer message is classified: questions and challenge answers, the complaint and the receipt.
  const classifierCalls = { low: questions + paths * 2 + messages, high: questions * EV1_TURNS_PER_QUESTION + paths * 6 + messages };
  const receiptReads = has("EV-2") ? sets.receipts.images.length + sets.receipts.srSubset.length * SR_REPETITIONS + paths : 0;
  const usdOf = (bound: "low" | "high") => {
    const short = shortCallUsd(HAPPY_PATH, bound);
    return round(turns[bound] * perTurnUsd(HAPPY_PATH, bound) + classifierCalls[bound] * short.classifier + receiptReads * short.reader);
  };
  return { evals, turns, classifierCalls, receiptReads, usd: { low: usdOf("low"), high: usdOf("high") } };
}

/** The SR gate alone: no turns, no classifier, the SR receipts × 5 through the reader. */
export function srGatePlan(sets: Pick<EvalSets, "receipts">): EvalPlan {
  const receiptReads = sets.receipts.srSubset.length * SR_REPETITIONS;
  const usdOf = (bound: "low" | "high") => round(receiptReads * shortCallUsd(HAPPY_PATH, bound).reader);
  return { evals: ["EV-2"], turns: { low: 0, high: 0 }, classifierCalls: { low: 0, high: 0 }, receiptReads, usd: { low: usdOf("low"), high: usdOf("high") } };
}

/** Why the run must not start, or undefined when the spend is confirmed and covered. */
export function spendRefusal(plan: EvalPlan, confirmed: boolean, maxUsd: number | undefined): string | undefined {
  if (!confirmed) return `the run spends Bedrock (up to US$ ${plan.usd.high.toFixed(2)}): pass --confirm-spend once the CTO approved it`;
  if (maxUsd === undefined || !(maxUsd >= plan.usd.high)) return `--max-usd must cover the high estimate (US$ ${plan.usd.high.toFixed(2)})`;
  return undefined;
}

/** The turn budget of a run: a conversation starts only if its upper bound still fits. */
export class TurnBudget {
  private used = 0;

  constructor(readonly max: number) {}

  take(turns: number): boolean {
    if (this.used + turns > this.max) return false;
    this.used += turns;
    return true;
  }

  get spent(): number {
    return this.used;
  }
}
