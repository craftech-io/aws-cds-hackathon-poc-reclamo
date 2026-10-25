// The `MilestoneScheduler` of complaints/deps.ts over the timers (docs/architecture.md §8.4 and §10):
//
//   schedule_sla_milestones   after the commit that created a complaint's timers (its three milestones,
//                             or the `AUTO_CLOSE` of an answer): nothing while the world is paused; in a
//                             running world the world's schedules are resynchronized, so the new timers
//                             get theirs within the cap of 50
//   cancel_milestones         after the commit that cancelled them (the written answer or a withdrawal):
//                             the schedules they had are deleted (`ResourceNotFoundException` is fine;
//                             one left behind would fire a CANCELLED timer, which is discarded)
import type { MilestoneScheduler } from "../complaints/deps";
import { readClock, viewOf } from "../clock/state";
import type { TimerDeps } from "./deps";
import { deleteSchedules, resyncWorld } from "./resync";

export function timerMilestoneScheduler(deps: TimerDeps): MilestoneScheduler {
  return {
    async schedule(worldId) {
      if (!deps.scheduler) return;
      const view = viewOf(await readClock(deps.connector, worldId), deps.realNow());
      if (!view.running) return;
      await resyncWorld(worldId, deps, { view });
    },
    async cancel(_worldId, scheduleNames) {
      await deleteSchedules(scheduleNames, deps);
    },
  };
}
