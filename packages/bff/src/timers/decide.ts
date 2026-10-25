// Whether a schedule's fire may run (docs/architecture.md §10, FL-081), decided ONLY from what is
// stored — the timer (read strongly consistent), the tombstone of the input's epoch and the world's
// clock — never from the input, in this order:
//
//   1. no timer, a tombstoned epoch, another epoch, CANCELLED, FIRED or another version
//        → LATE_FIRE_DISCARDED (TOMBSTONED, CANCELLED, ALREADY_FIRED, STALE_VERSION)
//   2. the world's clock is PAUSED (or its live window ended): a paused world has no real schedules
//        → EARLY_FIRE_DISCARDED CLOCK_PAUSED
//   3. `dueAtReal`, recomputed from the stored clock and timer, more than 90 s away
//        → EARLY_FIRE_DISCARDED NOT_DUE
//   4. otherwise FIRE: the conditional `SCHEDULED → FIRED` on version and epoch follows (fire.ts)
//
// An old input ends in 1; one fabricated with the current version ends in 2 or 3, except in a running
// world less than 90 s before the real fire, where it advances by at most 90 real seconds a fire the
// Scheduler was about to make anyway, with the same effect (`eventAtSim = dueAtSim`).
import type { Timer } from "../domain/timer";
import type { StoredClock, Tombstone } from "../domain/runtime";
import { dueAtRealOf, viewOf } from "../clock/state";

/** How early a fire may arrive before its recomputed real instant. */
export const EARLY_FIRE_TOLERANCE_MS = 90_000;

export type LateReason = "TOMBSTONED" | "CANCELLED" | "ALREADY_FIRED" | "STALE_VERSION";
export type EarlyReason = "CLOCK_PAUSED" | "NOT_DUE";

export type FireDecision =
  | { readonly outcome: "FIRE"; readonly timer: Timer }
  | { readonly outcome: "LATE_FIRE_DISCARDED"; readonly reason: LateReason }
  | { readonly outcome: "EARLY_FIRE_DISCARDED"; readonly reason: EarlyReason; readonly dueAtReal?: string };

export interface StoredFacts {
  readonly timer: Timer | undefined;
  /** Tombstone of the input's epoch. */
  readonly tombstone: Tombstone | undefined;
  readonly clock: StoredClock | undefined;
  readonly realNow: Date;
}

/** The input's claim: which timer, at which version and epoch (only compared, never trusted). */
export interface FireClaim {
  readonly version: number;
  readonly epoch: number;
}

function late(claim: FireClaim, facts: StoredFacts): LateReason | undefined {
  const { timer } = facts;
  if (facts.tombstone !== undefined) return "TOMBSTONED";
  if (timer === undefined) return "STALE_VERSION";
  if (timer.epoch !== claim.epoch) return "TOMBSTONED";
  if (timer.status === "CANCELLED") return "CANCELLED";
  if (timer.status === "FIRED") return "ALREADY_FIRED";
  if (timer.version !== claim.version || timer.status !== "SCHEDULED") return "STALE_VERSION";
  return undefined;
}

export function decideScheduledFire(claim: FireClaim, facts: StoredFacts): FireDecision {
  const lateReason = late(claim, facts);
  if (lateReason !== undefined || facts.timer === undefined) return { outcome: "LATE_FIRE_DISCARDED", reason: lateReason ?? "STALE_VERSION" };
  const timer = facts.timer;
  if (facts.clock === undefined) return { outcome: "EARLY_FIRE_DISCARDED", reason: "CLOCK_PAUSED" };
  const view = viewOf(facts.clock, facts.realNow);
  if (!view.running) return { outcome: "EARLY_FIRE_DISCARDED", reason: "CLOCK_PAUSED" };
  const dueAtReal = dueAtRealOf(facts.clock, timer.dueAtSim);
  if (dueAtReal.getTime() - facts.realNow.getTime() > EARLY_FIRE_TOLERANCE_MS) return { outcome: "EARLY_FIRE_DISCARDED", reason: "NOT_DUE", dueAtReal: dueAtReal.toISOString() };
  return { outcome: "FIRE", timer };
}
