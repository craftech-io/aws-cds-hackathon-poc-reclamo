// The event workers (docs/architecture.md §7): `EventWorker` (CustomerEvents.fifo), `SignupEventWorker`
// (SignupCustomerEvents.fifo, only `gs-*`) and `QaEventWorker` (QaCustomerEvents.fifo) run this same code,
// one event at a time (batch 1; the events of a customer in order by their FIFO group).
//
//   1. the body is parsed with zod (a malformed body fails, and on its last delivery is dead-lettered);
//   2. an event of a world that does not belong to this queue is discarded and audited `WRONG_QUEUE`
//      (best effort: the signup worker's IAM cannot even write another world's rows);
//   3. an event of a destroyed world or an old epoch is discarded and audited `TOMBSTONED_EVENT`;
//   4. double idempotency: SQS drops a repeated `MessageDeduplicationId = eventId` for 5 minutes, and
//      `Runtime/W#<w>#IDEMP#<type>#<eventId>` (7 days) is written once the event's effect is done, so a
//      redelivery after that is acknowledged without running again while a delivery that failed halfway
//      runs again;
//   5. dispatch by type (worker/dispatch.ts); then the event leaves `inFlight`.
//
// An event that fails is thrown back to SQS. On its last delivery (`ApproximateReceiveCount ≥ 2`) it
// never finishes, so before rethrowing the worker takes it out of `inFlight`, writes `processError` and
// audits `EVENT_DEAD_LETTERED` (worker/settle.ts), and the message goes to the DLQ and its alarm.
import { correlationIdFrom } from "../lib/log";
import { auditOnce, countMetric, WORKER_ACTIONS } from "./audit";
import { type DeliveryRef, dispatchEvent } from "./dispatch";
import { queueFor, queueOfArn } from "./enqueue";
import { CustomerEvent, MAX_RECEIVE_COUNT, looseIdentity } from "./events";
import { type WorkerContext, type WorkerDeps, workerCaller } from "./ports";
import { deadLetter, discardTombstoned, isTombstoned, settleEvent } from "./settle";

/** Real time kept after a turn for its writes (note, usage, obligations) before the Lambda's own timeout. */
export const TURN_TAIL_MARGIN_MS = 60_000;
/** Deadline of a turn when the runtime gives no remaining time (tests, local flows). */
export const DEFAULT_TURN_BUDGET_MS = 300_000;
export const WRONG_QUEUE_METRIC = "EventWrongQueue";

export interface SqsRecordLike {
  readonly body: string;
  readonly receiptHandle: string;
  readonly eventSourceARN?: string;
  readonly attributes: { readonly ApproximateReceiveCount?: string };
}

export interface LambdaContextLike {
  getRemainingTimeInMillis(): number;
}

export type EventWorker = (event: { readonly Records: readonly SqsRecordLike[] }, context?: LambdaContextLike) => Promise<void>;

export type RecordOutcome = "PROCESSED" | "ALREADY_PROCESSED" | "TOMBSTONED" | "WRONG_QUEUE";

function receiveCountOf(record: SqsRecordLike): number {
  const count = Number(record.attributes.ApproximateReceiveCount);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

/** `https://sqs.<region>.amazonaws.com/<account>/<name>` of an SQS ARN (what `ChangeMessageVisibility` needs). */
export function queueUrlOfArn(arn: string | undefined): string | undefined {
  const parts = arn?.split(":");
  if (parts === undefined || parts.length !== 6 || parts[2] !== "sqs") return undefined;
  return `https://sqs.${parts[3]}.amazonaws.com/${parts[4]}/${parts[5]}`;
}

function deadlineOf(deps: WorkerDeps, context: LambdaContextLike | undefined): number {
  const remaining = context === undefined ? DEFAULT_TURN_BUDGET_MS + TURN_TAIL_MARGIN_MS : context.getRemainingTimeInMillis();
  return deps.now().getTime() + Math.max(0, remaining - TURN_TAIL_MARGIN_MS);
}

async function wrongQueue(deps: WorkerDeps, ctx: WorkerContext, event: CustomerEvent, own: string): Promise<RecordOutcome> {
  countMetric(ctx.log, WRONG_QUEUE_METRIC, { queue: own, expected: queueFor(event.worldId) });
  try {
    await auditOnce({ data: deps.data, now: ctx.now, log: ctx.log }, { action: WORKER_ACTIONS.wrongQueue, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, refs: { customerId: event.customerId, type: event.type, queue: own } });
    await settleEvent(deps.data, event);
  } catch (error) {
    ctx.log.warn("event.wrong_queue_unrecorded", { errorName: error instanceof Error ? error.name : "unknown" });
  }
  return "WRONG_QUEUE";
}

export async function processRecord(deps: WorkerDeps, record: SqsRecordLike, context?: LambdaContextLike): Promise<RecordOutcome> {
  const identity = looseIdentity(record.body);
  const receiveCount = receiveCountOf(record);
  const log = deps.loggerFor(correlationIdFrom(identity.correlationId ?? identity.eventId)).child({ service: "event-worker", type: identity.type ?? "UNKNOWN", eventId: identity.eventId, receiveCount });
  try {
    const event = CustomerEvent.parse(JSON.parse(record.body));
    const ctx: WorkerContext = {
      log,
      now: deps.now,
      receiveCount,
      enqueue: async (input) => {
        await deps.enqueuer.enqueueCustomerEvent(input, workerCaller(event.worldId, event.eventId));
      },
    };
    const own = record.eventSourceARN === undefined ? undefined : queueOfArn(record.eventSourceARN);
    if (own !== undefined && queueFor(event.worldId) !== own) return await wrongQueue(deps, ctx, event, own);
    if (await isTombstoned(deps.data, event)) {
      await discardTombstoned({ data: deps.data, now: deps.now, log }, event);
      return "TOMBSTONED";
    }
    if ((await deps.data.claims.getIdempotency(event.worldId, event.type, event.eventId)) !== undefined) {
      log.info("event.already_processed");
      await settleEvent(deps.data, event);
      return "ALREADY_PROCESSED";
    }
    const queueUrl = queueUrlOfArn(record.eventSourceARN);
    const delivery: DeliveryRef = { receiptHandle: record.receiptHandle, ...(queueUrl === undefined ? {} : { queueUrl }) };
    await dispatchEvent(deps, { ...ctx, deadlineMs: deadlineOf(deps, context), delivery }, event);
    await deps.data.claims.claimOnce(event.worldId, event.type, event.eventId);
    await settleEvent(deps.data, event);
    log.info("event.processed");
    return "PROCESSED";
  } catch (error) {
    const last = receiveCount >= MAX_RECEIVE_COUNT;
    log.error("event.failed", { errorName: error instanceof Error ? error.name : "unknown", lastAttempt: last });
    if (last) await deadLetter({ data: deps.data, now: deps.now, log }, identity);
    throw error;
  }
}

/** The SQS handler: batch 1, so a failure fails only its own event. */
export function createEventWorker(deps: WorkerDeps): EventWorker {
  return async (event, context) => {
    for (const record of event.Records) await processRecord(deps, record, context);
  };
}
