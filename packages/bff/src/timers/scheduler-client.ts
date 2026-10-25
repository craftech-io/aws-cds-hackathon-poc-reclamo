// The one EventBridge Scheduler client (docs/architecture.md §10, ADR-0004): a timer of a world in
// `RUNNING` has at most one one-time schedule in the group of the stage, `at(<dueAtReal UTC>)`,
// `FlexibleTimeWindow OFF`, `ActionAfterCompletion DELETE`, target `ScheduleDispatch` with the
// Scheduler's invocation role and the input of events.ts `ScheduleInput`, whose `scheduleArn` is the
// Scheduler's context attribute (`<aws.scheduler.schedule-arn>`), so a fire carries the ARN of the
// schedule that really fired. Group, role and target come from the linked `Scheduler` (infra/scheduler.ts,
// capability TIMERS), never from `process.env`.
//
// Create, update and delete are idempotent: creating an existing schedule updates it, deleting a
// missing one (already fired, or never created) is fine (`ResourceNotFoundException` is ignored).
// Every call has the SDK timeout and a retry with backoff on throttling and 5xx.
import { ConflictException, CreateScheduleCommand, DeleteScheduleCommand, ResourceNotFoundException, SchedulerClient, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import { z } from "zod";
import { ConnectorError } from "@reclamo/shared";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { SCHEDULE_ARN_PLACEHOLDER, atExpression } from "./schedule-name";
import type { ScheduleInput } from "./events";

/** What a schedule carries; `scheduleArn` is filled by the Scheduler when it fires. */
export type ScheduleTargetInput = Omit<ScheduleInput, "scheduleArn">;

export interface ScheduleSpec {
  readonly name: string;
  /** Real instant the schedule fires at (`dueAtReal`). */
  readonly at: Date;
  readonly input: ScheduleTargetInput;
}

export interface SchedulerPort {
  /** Creates the schedule, or moves it when it already exists. */
  put(spec: ScheduleSpec): Promise<void>;
  /** Deletes the schedule; one that is already gone is fine. */
  delete(name: string): Promise<void>;
}

/** `Resource.Scheduler` (infra/scheduler.ts, WP-31). */
export const SchedulerLink = z.object({ groupName: z.string().min(1), roleArn: z.string().min(1), targetArn: z.string().min(1) });
export type SchedulerLink = z.infer<typeof SchedulerLink>;

/** `Resource.DispatchScheduler` (ScheduleDispatch's own TIMERS): the target is the function's own ARN. */
export const DispatchSchedulerLink = SchedulerLink.omit({ targetArn: true });

/** `arn:aws:lambda:<region>:<account>:function:<name>` without a version or alias qualifier. */
export function unqualifiedFunctionArn(arn: string): string {
  return arn.split(":").slice(0, 7).join(":");
}

// One schedule call answers in well under a second; a throttled call is retried below.
export const SCHEDULER_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 2 };

const RETRYABLE = new Set(["ThrottlingException", "InternalServerException", "ServiceQuotaExceededException", "TimeoutError"]);

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function mapped(error: unknown, what: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = errorName(error);
  if (name === "ValidationException") return new ConnectorError("VALIDATION", `${what}: the Scheduler refused the request`, "Scheduler", { cause: error });
  if (name === "TimeoutError" || name === "AbortError") return new ConnectorError("TIMEOUT", `${what}: the Scheduler did not answer`, "Scheduler", { cause: error });
  if (RETRYABLE.has(name)) return new ConnectorError("THROTTLED", `${what}: the Scheduler is busy`, "Scheduler", { cause: error });
  return new ConnectorError("UNAVAILABLE", `${what}: the Scheduler failed`, "Scheduler", { cause: error });
}

/** The Scheduler's `Input`: the target input with the ARN context attribute. */
export function scheduleInputJson(input: ScheduleTargetInput): string {
  return JSON.stringify({ ...input, scheduleArn: SCHEDULE_ARN_PLACEHOLDER });
}

export interface EventBridgeSchedulerOptions {
  readonly link?: () => SchedulerLink;
  readonly client?: Pick<SchedulerClient, "send">;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The production `SchedulerPort` over `@aws-sdk/client-scheduler`. */
export function eventBridgeScheduler(options: EventBridgeSchedulerOptions = {}): SchedulerPort {
  const link = options.link ?? (() => readLinked("Scheduler", SchedulerLink));
  let client = options.client;
  const scheduler = (): Pick<SchedulerClient, "send"> => (client ??= new SchedulerClient(awsClientConfig(SCHEDULER_TIMEOUTS)));

  async function call(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await withRetry(run, { attempts: 3, ...(options.sleep ? { sleep: options.sleep } : {}), shouldRetry: (error) => RETRYABLE.has(errorName(error)) });
    } catch (error) {
      throw mapped(error, what);
    }
  }

  function request(spec: ScheduleSpec) {
    const { groupName, roleArn, targetArn } = link();
    return {
      Name: spec.name,
      GroupName: groupName,
      ScheduleExpression: atExpression(spec.at),
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" as const },
      ActionAfterCompletion: "DELETE" as const,
      State: "ENABLED" as const,
      Target: { Arn: targetArn, RoleArn: roleArn, Input: scheduleInputJson(spec.input), RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 600 } },
    };
  }

  return {
    async put(spec) {
      await call("schedule.put", async () => {
        try {
          await scheduler().send(new CreateScheduleCommand(request(spec)));
        } catch (error) {
          if (!(error instanceof ConflictException) && errorName(error) !== "ConflictException") throw error;
          await scheduler().send(new UpdateScheduleCommand(request(spec)));
        }
      });
    },

    async delete(name) {
      await call("schedule.delete", async () => {
        try {
          await scheduler().send(new DeleteScheduleCommand({ Name: name, GroupName: link().groupName }));
        } catch (error) {
          if (!(error instanceof ResourceNotFoundException) && errorName(error) !== "ResourceNotFoundException") throw error;
        }
      });
    },
  };
}
