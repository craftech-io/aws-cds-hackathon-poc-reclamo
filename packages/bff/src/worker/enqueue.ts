/// <reference path="../../sst-env.d.ts" />
// `enqueue_customer_event` (docs/architecture.md §7, docs/tool-catalog.md): the ONLY producer of the
// customer queues and of `ScanDeadlines`. `lint:chokepoint` fails if `SendMessageCommand` appears
// anywhere else, and IAM cannot fence the `MessageGroupId` (docs/architecture.md §13, residual risk 7):
// this module does.
//
//   1. the event is validated (a malformed event is a bug, never a message);
//   2. the caller may only enqueue for its own world, and a QA caller only for a QA world: otherwise
//      `DENY CROSS_WORLD`, audited in the caller's world, and nothing is sent;
//   3. the queue comes from the world's class and origin alone (`worldKindOf`, `guestOriginOf`):
//        demo, gNN, gtest, gprobe   → CustomerEvents.fifo
//        gs-* (self-signup)         → SignupCustomerEvents.fifo   (never CustomerEvents.fifo)
//        qa-*, qamin, sim-*         → QaCustomerEvents.fifo
//   4. an event the worker already processed (`IDEMP#<type>#<eventId>`) is not enqueued again: SQS would
//      drop the copy inside its 5-minute window and nobody would take its token out of `inFlight`;
//   5. `ADD <customerId>#<eventId>~<addedAtMs>` to `WORLDSTATE.inFlight` BEFORE the message exists, so
//      quiescence never misses it, unless the row already holds a token of the same event: a repeat adds
//      no second token (SQS drops its copy within 5 minutes, and nobody would remove a token added after
//      the worker settled). The worker takes every token of the event out once it is done; only a token
//      older than the message's whole life in the queue is reported stale (clock/busy.ts);
//   6. `SendMessage` with `MessageGroupId = <worldId>#<customerId>` and `MessageDeduplicationId = eventId`
//      (a repeat within 5 minutes is dropped by SQS and `IDEMP#` covers the rest), retried with backoff.
//      A repeat is still sent: the first send may have failed after its `ADD`, and skipping it would lose
//      the event while its token kept the world busy.
//
// `enqueueScanDeadline` puts the 120 s scan deadline of a bound media object on `ScanDeadlines`
// (standard queue, `DelaySeconds 120`, consumed by MediaIntake, docs/architecture.md §6).
import { SQSClient, SendMessageCommand, type SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { type Caller, ConnectorError, ToolError, guestOriginOf, worldKindOf } from "@reclamo/shared";
import { writeAudit } from "../agent-tools/common/context";
import type { Connector } from "../connector/port";
import { awsClientConfig } from "../lib/clients";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import type { EmailEventEnqueue } from "../email-events/schema";
import { type MediaEventEnqueue, ScanDeadlineMessage } from "../media-intake/schema";
import { CustomerEvent, type CustomerEventInput, inFlightToken, isInFlightTokenOf, messageGroupOf } from "./events";

export const CUSTOMER_QUEUES = ["CustomerEvents", "SignupCustomerEvents", "QaCustomerEvents"] as const;
export type CustomerQueue = (typeof CUSTOMER_QUEUES)[number];

/** The queue of a world, from its id only (docs/architecture.md §7 and §10). */
export function queueFor(worldId: string): CustomerQueue {
  const kind = worldKindOf(worldId);
  if (kind === undefined) throw new ToolError("INVALID", "not a world id");
  if (kind === "QA" || kind === "SIM") return "QaCustomerEvents";
  if (guestOriginOf(worldId) === "SIGNUP") return "SignupCustomerEvents";
  return "CustomerEvents";
}

/** Which queue an SQS `eventSourceARN` (`…:<app>-<stage>-<Queue>.fifo`) is, or `undefined`. */
export function queueOfArn(arn: string): CustomerQueue | undefined {
  const name = arn.split(":").pop() ?? "";
  // Longest names first: `CustomerEvents` is a suffix of the other two.
  return (["SignupCustomerEvents", "QaCustomerEvents", "CustomerEvents"] as const).find((queue) => name.endsWith(`-${queue}.fifo`));
}

/** SQS answers in tens of milliseconds; a send that takes seconds is an outage. */
export const QUEUE_TIMEOUTS = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;
export const SEND_ATTEMPTS = 3;
/** `ScanDeadlines` delay (docs/architecture.md §6), also the queue's own default. */
export const SCAN_DEADLINE_DELAY_SECONDS = 120;

export type QueueSend = (input: SendMessageCommandInput) => Promise<unknown>;
export type QueueTarget = CustomerQueue | "ScanDeadlines";

export interface EnqueueDeps {
  readonly data: Pick<Connector, "runtime" | "write" | "worlds" | "audit" | "claims">;
  readonly send: QueueSend;
  /** `Resource.<queue>.url`: only the queues linked to the calling function resolve. */
  readonly queueUrl: (queue: QueueTarget) => string;
  /** Real time (audit stamps). */
  readonly now: () => Date;
  readonly log: Logger;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A send that failed after its attempts: the caller decides (an entry fails and is retried). */
export class EnqueueError extends Error {
  override readonly name = "EnqueueError";
  readonly retryable = true;
}

export interface Enqueuer {
  /** `enqueue_customer_event`: refuses a world the caller cannot touch with `FORBIDDEN CROSS_WORLD`. */
  enqueueCustomerEvent(input: CustomerEventInput, caller: Caller): Promise<CustomerEvent>;
  enqueueScanDeadline(input: Omit<ScanDeadlineMessage, "kind">, caller: Caller): Promise<void>;
}

/** Why a caller may not enqueue for a world, or `undefined` when it may. */
export function crossWorldReason(caller: Caller, worldId: string): string | undefined {
  if (caller.worldId !== worldId) return "CALLER_WORLD";
  const kind = worldKindOf(worldId);
  if (caller.kind === "QA" && kind !== "QA" && kind !== "SIM") return "QA_OUTSIDE_QA";
  return undefined;
}

export function sendMessageInput(queueUrl: string, event: CustomerEvent): SendMessageCommandInput {
  return { QueueUrl: queueUrl, MessageBody: JSON.stringify(event), MessageGroupId: messageGroupOf(event), MessageDeduplicationId: event.eventId };
}

export function createEnqueuer(deps: EnqueueDeps): Enqueuer {
  async function deny(caller: Caller, worldId: string, reason: string, what: string): Promise<never> {
    await writeAudit(
      { connector: deps.data as Connector, worldId: caller.worldId, actor: caller.kind === "QA" ? "QA" : "SYSTEM", wallClock: deps.now, log: deps.log },
      { action: "DENY", outcome: "CROSS_WORLD", ruleIds: ["ENQUEUE"], refs: { targetWorld: worldId, what, reason, callerEventId: caller.eventId } },
    );
    deps.log.warn("enqueue.cross_world_refused", { reason, what });
    throw new ToolError("FORBIDDEN", "the caller cannot enqueue for this world", "CROSS_WORLD");
  }

  async function send(input: SendMessageCommandInput, what: string): Promise<void> {
    try {
      await withRetry(() => deps.send(input), { attempts: SEND_ATTEMPTS, shouldRetry: () => true, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
    } catch (error) {
      throw new EnqueueError(`SendMessage of ${what} failed`, { cause: error });
    }
  }

  async function addInFlight(worldId: string, token: string): Promise<void> {
    try {
      await deps.data.write(deps.data.runtime.addInFlightOp(worldId, token));
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "VALIDATION") throw error;
      await deps.data.write(deps.data.runtime.replaceInFlightListOp(worldId, token));
      deps.log.warn("enqueue.in_flight_list_replaced", {});
    }
  }

  return {
    async enqueueCustomerEvent(input, caller) {
      const event = CustomerEvent.parse(input);
      const reason = crossWorldReason(caller, event.worldId);
      if (reason !== undefined) return deny(caller, event.worldId, reason, event.type);
      if ((event.type === "POISON" || event.type === "HEALTH_PROBE") && queueFor(event.worldId) !== "QaCustomerEvents") {
        throw new ToolError("FORBIDDEN", `${event.type} only runs in a QA world`);
      }
      const queue = queueFor(event.worldId);
      if ((await deps.data.claims.getIdempotency(event.worldId, event.type, event.eventId)) !== undefined) {
        deps.log.info("enqueue.already_processed", { type: event.type, queue, eventId: event.eventId });
        return event;
      }
      const repeat = (await deps.data.runtime.getWorldState(event.worldId)).inFlight.some((token) => isInFlightTokenOf(token, event));
      if (!repeat) await addInFlight(event.worldId, inFlightToken(event, deps.now()));
      await send(sendMessageInput(deps.queueUrl(queue), event), event.type);
      deps.log.info("enqueue.sent", { type: event.type, queue, eventId: event.eventId, repeat });
      return event;
    },
    async enqueueScanDeadline(input, caller) {
      const message = ScanDeadlineMessage.parse({ kind: "SCAN_DEADLINE", ...input });
      const reason = crossWorldReason(caller, message.worldId);
      if (reason !== undefined) return deny(caller, message.worldId, reason, "SCAN_DEADLINE");
      await send({ QueueUrl: deps.queueUrl("ScanDeadlines"), MessageBody: JSON.stringify(message), DelaySeconds: SCAN_DEADLINE_DELAY_SECONDS }, "SCAN_DEADLINE");
    },
  };
}

/**
 * The `EmailEventEnqueue` of `EmailEvents` (email-events/schema.ts) over this producer: the event takes
 * the epoch and the instant of its SES record, with the `CHANNEL` caller of that world.
 */
export function emailEventEnqueue(enqueuer: Enqueuer): EmailEventEnqueue {
  return async (message) => {
    const caller: Caller = { kind: "CHANNEL", worldId: message.worldId, eventId: message.eventId };
    await enqueuer.enqueueCustomerEvent(
      { type: "EMAIL_EVENT", eventId: message.eventId, worldId: message.worldId, customerId: message.customerId, epoch: message.payload.epoch, eventAtSim: message.payload.sentAtSim, payload: message.payload },
      caller,
    );
  };
}

/**
 * The `MediaEventEnqueue` of `MediaIntake` and of `InboundWhatsApp` (media-intake/schema.ts) over this
 * producer: `RECEIPT_RECEIVED` and `MEDIA_REJECTED` with the `CHANNEL` caller of that world.
 */
export function mediaEventEnqueue(enqueuer: Enqueuer): MediaEventEnqueue {
  return async (message) => {
    const caller: Caller = { kind: "CHANNEL", worldId: message.worldId, eventId: message.eventId };
    await enqueuer.enqueueCustomerEvent(message, caller);
  };
}

const QueueLink = z.object({ url: z.url() });

let sqs: SQSClient | undefined;

function sqsClient(): SQSClient {
  sqs ??= new SQSClient({ region: "us-east-1", ...awsClientConfig(QUEUE_TIMEOUTS) });
  return sqs;
}

/** The producer of a Lambda: the queues SST linked to it (`Resource.<Queue>.url`, `sqs:SendMessage`). */
export function linkedEnqueuer(data: EnqueueDeps["data"], log: Logger): Enqueuer {
  return createEnqueuer({
    data,
    send: (input) => sqsClient().send(new SendMessageCommand(input)),
    queueUrl: (queue) => {
      try {
        return readLinked(queue, QueueLink).url;
      } catch (error) {
        throw new ConnectorError("UNAVAILABLE", `queue ${queue} is not linked to this function`, queue, { cause: error });
      }
    },
    now: () => new Date(),
    log,
  });
}
