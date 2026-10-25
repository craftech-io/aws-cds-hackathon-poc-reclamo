// The timers' deps inside a Lambda of the stage: DynamoDB, the customer queues through
// worker/enqueue.ts, `NetworkMock` through its Function URL where the role holds MOCK_NETWORK, and the
// Scheduler where it holds TIMERS (the linked `Scheduler`). ScheduleDispatch, the worker and the
// console's clock procedures build theirs here, each with what its role can reach.
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { linkedNetworkClient } from "../networks/linked";
import { linkedEnqueuer } from "../worker/enqueue";
import type { TimerDeps } from "./deps";
import { DispatchSchedulerLink, SchedulerLink, eventBridgeScheduler, unqualifiedFunctionArn } from "./scheduler-client";
import { enqueuerSink } from "./sink";

export interface StageTimerOptions {
  /** The role can call `NetworkMock` (MOCK_NETWORK): publications and scheduled transfer changes. */
  readonly networks: boolean;
  /** The role holds TIMERS: schedules are created, moved and deleted from here. */
  readonly scheduler: boolean;
  /** Where the schedules' group, role and target come from; the linked `Scheduler` by default. */
  readonly schedulerLink?: () => SchedulerLink;
}

export function stageTimerDeps(log: Logger, options: StageTimerOptions): TimerDeps {
  const connector = dynamoConnector();
  return {
    connector,
    sink: enqueuerSink(linkedEnqueuer(connector, log)),
    ...(options.networks ? { networks: linkedNetworkClient() } : {}),
    ...(options.scheduler ? { scheduler: eventBridgeScheduler(options.schedulerLink === undefined ? {} : { link: options.schedulerLink }) } : {}),
    log,
    realNow: () => new Date(),
  };
}

/** The schedules' group when `Scheduler` is linked here; `undefined` otherwise (the name check still holds). */
export function linkedScheduleGroup(): string | undefined {
  try {
    return readLinked("Scheduler", SchedulerLink).groupName;
  } catch {
    return undefined;
  }
}

/**
 * ScheduleDispatch's own TIMERS (`DispatchScheduler`): group and role from the link, the target is the
 * invoked function itself. `undefined` when the link is missing (the fire still works; the next
 * schedules then wait for the next move of the clock).
 */
export function dispatchSchedulerLink(invokedFunctionArn: string): SchedulerLink | undefined {
  try {
    return { ...readLinked("DispatchScheduler", DispatchSchedulerLink), targetArn: unqualifiedFunctionArn(invokedFunctionArn) };
  } catch {
    return undefined;
  }
}
