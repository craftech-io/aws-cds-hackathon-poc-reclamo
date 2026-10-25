// `ScheduleDispatch` (docs/architecture.md §10, FL-081): one fire of a Scheduler schedule.
//
//   1. the input passes zod (events.ts `ScheduleInput`), or the fire is dropped (`INVALID`)
//   2. the name recomputed from `timerKey` and `epoch` must be the one in `scheduleArn` (the Scheduler's
//      context attribute) → otherwise `SCHEDULE_NAME_MISMATCH`
//   3. timer (strongly consistent), tombstone of the input's epoch and clock are read, and decide.ts
//      decides from them alone → `LATE_FIRE_DISCARDED` / `EARLY_FIRE_DISCARDED`, audited, with the
//      metrics `LateFiresDiscarded` / `EarlyFiresDiscarded`, and no effect
//   4. fire.ts claims (`firedBy SCHEDULER`, `eventAtSim = dueAtSim`) and runs the effect; a lost race
//      is a late fire too
//   5. a running world keeps its schedules topped up (up to 50): the next ones are created as the
//      earlier ones fire (resync.ts), where the role can reach the Scheduler
import type { Timer } from "../domain/timer";
import { arnMatchesTimer } from "./schedule-name";
import { type FireDecision, decideScheduledFire } from "./decide";
import { type TimerDeps, errorNameOf } from "./deps";
import { ScheduleInput, kindAndIdOf } from "./events";
import { type FireOutcome, auditTimer, fireTimer } from "./fire";
import { resyncWorld } from "./resync";

export type ScheduledStatus =
  | "INVALID"
  | "SCHEDULE_NAME_MISMATCH"
  | "LATE_FIRE_DISCARDED"
  | "EARLY_FIRE_DISCARDED"
  | "TIMER_FIRED"
  | "DISPATCH_FAILED";

export interface ScheduledResult {
  readonly status: ScheduledStatus;
  readonly reason?: string;
}

export interface ScheduleDispatchOptions {
  /** The group the stage's schedules live in, when the caller knows it (an ARN of another group is refused). */
  readonly group?: string;
}

const LATE_METRIC = "LateFiresDiscarded";
const EARLY_METRIC = "EarlyFiresDiscarded";

async function discard(deps: TimerDeps, timer: Timer | undefined, input: ScheduleInput, decision: Exclude<FireDecision, { outcome: "FIRE" }>): Promise<ScheduledResult> {
  const metric = decision.outcome === "LATE_FIRE_DISCARDED" ? LATE_METRIC : EARLY_METRIC;
  deps.log.info("timers.fire_discarded", { metric, worldId: input.worldId, outcome: decision.outcome, reason: decision.reason, version: input.version, epoch: input.epoch });
  const { kind, timerId } = kindAndIdOf(input.timerKey);
  const subject: Timer = timer ?? { worldId: input.worldId, kind, timerId, dueAtSim: input.dueAtSim, seq: 0, status: "DISCARDED", epoch: input.epoch, payload: {}, version: input.version };
  await auditTimer(deps, { ...subject, epoch: input.epoch }, decision.outcome, decision.reason, {
    inputVersion: input.version,
    inputEpoch: input.epoch,
    ...(timer ? { storedVersion: timer.version, storedStatus: timer.status } : {}),
    ...(decision.outcome === "EARLY_FIRE_DISCARDED" && decision.dueAtReal ? { dueAtReal: decision.dueAtReal } : {}),
  });
  return { status: decision.outcome, reason: decision.reason };
}

function resultOf(outcome: FireOutcome): ScheduledResult {
  if (outcome.status === "FIRED") return { status: "TIMER_FIRED" };
  if (outcome.status === "RACE") return { status: "LATE_FIRE_DISCARDED", reason: "ALREADY_FIRED" };
  return { status: "DISPATCH_FAILED", reason: outcome.errorName };
}

/** The whole `ScheduleDispatch` decision and effect for one raw Scheduler input. */
export async function dispatchScheduled(raw: unknown, deps: TimerDeps, options: ScheduleDispatchOptions = {}): Promise<ScheduledResult> {
  const parsed = ScheduleInput.safeParse(raw);
  if (!parsed.success) {
    deps.log.warn("timers.invalid_input", { issues: parsed.error.issues.length });
    return { status: "INVALID" };
  }
  const input = parsed.data;
  const expected = { worldId: input.worldId, epoch: input.epoch, timerKey: input.timerKey, ...(options.group ? { group: options.group } : {}) };
  if (!arnMatchesTimer(input.scheduleArn, expected)) {
    deps.log.warn("timers.schedule_name_mismatch", { metric: LATE_METRIC, worldId: input.worldId, epoch: input.epoch });
    const { kind, timerId } = kindAndIdOf(input.timerKey);
    await auditTimer(deps, { worldId: input.worldId, kind, timerId, dueAtSim: input.dueAtSim, seq: 0, status: "DISCARDED", epoch: input.epoch, payload: {}, version: input.version }, "LATE_FIRE_DISCARDED", "SCHEDULE_NAME_MISMATCH", {
      inputVersion: input.version,
    });
    return { status: "SCHEDULE_NAME_MISMATCH" };
  }

  const [timer, tombstone, clock] = await Promise.all([
    deps.connector.timers.getByKey(input.worldId, input.timerKey),
    deps.connector.runtime.getTombstone(input.worldId, input.epoch),
    deps.connector.runtime.getClock(input.worldId),
  ]);
  const decision = decideScheduledFire({ version: input.version, epoch: input.epoch }, { timer, tombstone, clock, realNow: deps.realNow() });
  if (decision.outcome !== "FIRE") return discard(deps, timer, input, decision);

  const result = resultOf(await fireTimer({ timer: decision.timer, firedBy: "SCHEDULER" }, deps));
  if (deps.scheduler) {
    try {
      await resyncWorld(input.worldId, deps);
    } catch (error) {
      deps.log.warn("timers.top_up_failed", { worldId: input.worldId, errorName: errorNameOf(error) });
    }
  }
  return result;
}
