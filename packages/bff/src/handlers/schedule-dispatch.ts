// Lambda entry of `ScheduleDispatch` (docs/architecture.md §10), the only target of the timers'
// Scheduler schedules, with input `{worldId, timerKey, version, epoch, dueAtSim, scheduleArn}`. The
// whole decision lives in timers/dispatch.ts: the input is validated with zod, the schedule name is
// checked against the ARN of the schedule that fired, and the fire is decided from the stored timer,
// tombstone and clock, never from the input. Discards and races answer normally (no Scheduler retry);
// an effect that failed was undone and audited, and the next move of the clock fires it again.
//
// It reaches `NetworkMock` through its Function URL (publications, scheduled transfer changes), the
// customer queues through worker/enqueue.ts, and the Scheduler (to keep a running world's next
// schedules) through the linked `DispatchScheduler`, whose target is this function's own ARN.
import type { Context } from "aws-lambda";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";
import type { TimerDeps } from "../timers/deps";
import { type ScheduleDispatchOptions, type ScheduledResult, dispatchScheduled } from "../timers/dispatch";
import { dispatchSchedulerLink, stageTimerDeps } from "../timers/stage";

type InvokedFunction = Pick<Context, "invokedFunctionArn">;

export type ScheduleDispatchHandler = (event: unknown, context?: InvokedFunction) => Promise<ScheduledResult>;

export function createScheduleDispatchHandler(
  depsFor: (log: Logger, context: InvokedFunction | undefined) => TimerDeps,
  options: (context: InvokedFunction | undefined) => ScheduleDispatchOptions = () => ({}),
  newLog: () => Logger = () => createLogger({ correlationId: newCorrelationId(), bindings: { service: "schedule-dispatch" } }),
): ScheduleDispatchHandler {
  return async (event, context) => {
    const log = newLog();
    const result = await dispatchScheduled(event, depsFor(log, context), options(context));
    log.info("schedule.dispatched", { status: result.status, reason: result.reason });
    return result;
  };
}

export const handler: ScheduleDispatchHandler = createScheduleDispatchHandler(
  (log, context) => {
    const link = context === undefined ? undefined : dispatchSchedulerLink(context.invokedFunctionArn);
    return stageTimerDeps(log, { networks: true, scheduler: link !== undefined, ...(link === undefined ? {} : { schedulerLink: () => link }) });
  },
  (context) => {
    const group = context === undefined ? undefined : dispatchSchedulerLink(context.invokedFunctionArn)?.groupName;
    return group === undefined ? {} : { group };
  },
);
