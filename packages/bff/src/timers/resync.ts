// The real schedules of a world (docs/architecture.md §10, FL-082). A PAUSED world has none; a
// RUNNING one has one schedule per SCHEDULED timer whose `dueAtReal` falls inside the next real hour
// (and before its live window ends), at most 50 per world in `dueAtSim` order; the next ones are
// created as the earlier ones fire. A timer due within a minute is not scheduled: it fires right away
// (`firedBy SCHEDULER`, at its `dueAtSim`). Every move of the clock or change of `rate` resynchronizes:
// each schedule is put again with its recomputed `dueAtReal` (CreateSchedule, or UpdateSchedule when
// it exists), so no schedule keeps a real instant computed with an old anchor; the rest are deleted.
//
// Recording a new schedule name bumps the timer's version, and the schedule's input carries the new
// one: a schedule left over from before fires a stale version, which the dispatcher discards.
import type { Timer } from "../domain/timer";
import { type ClockView, dueAtRealOf, readClock, viewOf } from "../clock/state";
import { isConflict } from "../connector/errors";
import { type TimerDeps, errorNameOf } from "./deps";
import { fireTimer } from "./fire";
import { ScheduleNameError, scheduleNameOf } from "./schedule-name";

/** Schedules exist only for timers due within this real horizon. */
export const SCHEDULE_HORIZON_MS = 60 * 60_000;
/** At most this many schedules per world at a time. */
export const MAX_SCHEDULES_PER_WORLD = 50;
/** A timer this close (real time) fires right away instead of getting a schedule. */
export const DIRECT_DISPATCH_MS = 60_000;
/** Scheduled timers a resync looks at (a world rarely has more than a few dozen). */
const SCAN_LIMIT = 500;

export interface ResyncSummary {
  readonly put: number;
  readonly deleted: number;
  readonly direct: number;
  readonly skipped: number;
}

const ZERO: ResyncSummary = { put: 0, deleted: 0, direct: 0, skipped: 0 };

async function forget(timer: Timer, deps: TimerDeps): Promise<boolean> {
  if (!timer.scheduleName || !deps.scheduler) return false;
  await deps.scheduler.delete(timer.scheduleName);
  try {
    await deps.connector.write(deps.connector.timers.rescheduleOp({ worldId: timer.worldId, kind: timer.kind, timerId: timer.timerId, version: timer.version, scheduleName: null }));
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  return true;
}

/** Records the schedule name (version + 1 when it changes) and puts the schedule; `false` on a lost race. */
async function schedule(timer: Timer, view: ClockView, deps: TimerDeps): Promise<boolean> {
  if (!deps.scheduler) return false;
  const timerKey = deps.connector.timers.timerKey(timer);
  const name = scheduleNameOf(timer.worldId, timer.epoch, timerKey);
  let version = timer.version;
  if (timer.scheduleName !== name) {
    try {
      await deps.connector.write(deps.connector.timers.rescheduleOp({ worldId: timer.worldId, kind: timer.kind, timerId: timer.timerId, version, scheduleName: name }));
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
    version += 1;
  }
  await deps.scheduler.put({ name, at: dueAtRealOf(view.stored, timer.dueAtSim), input: { worldId: timer.worldId, timerKey, version, epoch: timer.epoch, dueAtSim: timer.dueAtSim } });
  return true;
}

/**
 * Brings the schedules of one world in line with its clock. Without a Scheduler (a role without
 * TIMERS) it does nothing. `view` is the clock the caller just wrote; absent, it is read (never
 * written: a reader without write access to `Runtime` may resync too).
 */
export async function resyncWorld(worldId: string, deps: TimerDeps, options: { readonly view?: ClockView } = {}): Promise<ResyncSummary> {
  if (!deps.scheduler) return ZERO;
  const realNow = deps.realNow();
  const view = options.view ?? viewOf(await readClock(deps.connector, worldId), realNow);
  const timers = await deps.connector.timers.listDue(worldId, { limit: SCAN_LIMIT });
  const counts = { put: 0, deleted: 0, direct: 0, skipped: 0 };
  if (!view.running) {
    for (const timer of timers) if (await forget(timer, deps)) counts.deleted += 1;
    return counts;
  }
  const until = view.stored.runningUntilReal ? Date.parse(view.stored.runningUntilReal) : Number.POSITIVE_INFINITY;
  const horizon = Math.min(realNow.getTime() + SCHEDULE_HORIZON_MS, until);
  let slots = MAX_SCHEDULES_PER_WORLD;
  for (const timer of timers) {
    const dueAtReal = dueAtRealOf(view.stored, timer.dueAtSim).getTime();
    try {
      if (dueAtReal - realNow.getTime() <= DIRECT_DISPATCH_MS) {
        // Its schedule (if any) would only fire a discarded duplicate: it goes, and frees its slot.
        if (timer.scheduleName) await deps.scheduler.delete(timer.scheduleName);
        await fireTimer({ timer, firedBy: "SCHEDULER" }, deps);
        counts.direct += 1;
      } else if (dueAtReal < horizon && slots > 0) {
        slots -= 1;
        if (await schedule(timer, view, deps)) counts.put += 1;
        else counts.skipped += 1;
      } else if (await forget(timer, deps)) {
        counts.deleted += 1;
      }
    } catch (error) {
      if (!(error instanceof ScheduleNameError)) throw error;
      counts.skipped += 1;
      deps.log.error("timers.schedule_name_invalid", { worldId, kind: timer.kind, timerId: timer.timerId, errorName: errorNameOf(error) });
    }
  }
  deps.log.info("timers.resynced", { worldId, ...counts });
  return counts;
}

/** Deletes the schedules of timers that were just cancelled (`ResourceNotFoundException` is fine). */
export async function deleteSchedules(names: readonly string[], deps: Pick<TimerDeps, "scheduler" | "log">): Promise<number> {
  if (!deps.scheduler) return 0;
  for (const name of names) await deps.scheduler.delete(name);
  return names.length;
}
