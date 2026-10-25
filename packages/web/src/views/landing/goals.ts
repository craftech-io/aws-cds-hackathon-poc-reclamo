// The four targets of the impact section (docs/landing-spec.md §2.7), shared by the impact cards and
// the metrics render of the tour. Only the intermediate values count up: a counter that lands exactly
// on 0 or on 100 % reads as a trick, so those two are shown fixed from the start.
import type { LandingCopy } from "./copy";

export const GOAL_KEYS = ["timeToNumber", "resolvedAlone", "answeredOnTime", "violations"] as const;
export type GoalKey = (typeof GOAL_KEYS)[number];

type Goal = LandingCopy["impact"]["goals"][GoalKey];

/** "< 5 s", "≥ 60 %": the goal with `value` in place of its target (the counter's current value). */
export function goalText(goal: Goal, value: number = goal.value): string {
  return `${goal.prefix}${value}${goal.suffix}`;
}

/** Whether the goal's figure counts up when its card enters the viewport. */
export function countsUp(goal: Goal): boolean {
  return goal.value !== 0 && goal.value !== 100;
}
