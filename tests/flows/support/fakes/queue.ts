// The queues of an in-process world: what the single producer (worker/enqueue.ts) sends with
// `SendMessage` lands here, and `drain` delivers it the way the event source mappings do — the three
// customer FIFO queues to the event worker (batch 1, in order, `MessageDeduplicationId` honoured for
// five real minutes, a failed delivery retried once and then dead-lettered) and `ScanDeadlines` to
// `MediaIntake` once its `DelaySeconds` passed on the real clock. Nothing is concurrent: one message at
// a time, so a test reads a settled world after `drain`.
import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { CUSTOMER_QUEUES, type CustomerQueue, type QueueTarget } from "@reclamo/bff/worker/enqueue";
import { MAX_RECEIVE_COUNT } from "@reclamo/bff/worker/events";
import type { SqsRecordLike } from "@reclamo/bff/worker/worker";

const ACCOUNT = "776805327629";
const QUEUE_PREFIX = "aws-cds-hackathon-poc-reclamo-poc-";
const DEDUP_WINDOW_MS = 5 * 60_000;
/** A runaway loop of follow-ups is a bug of the flow, not something to wait out. */
const MAX_DELIVERIES_PER_DRAIN = 500;

function physicalName(queue: QueueTarget): string {
  return `${QUEUE_PREFIX}${queue}${queue === "ScanDeadlines" ? "" : ".fifo"}`;
}

export function queueUrlOf(queue: QueueTarget): string {
  return `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/${physicalName(queue)}`;
}

export function queueArnOf(queue: QueueTarget): string {
  return `arn:aws:sqs:us-east-1:${ACCOUNT}:${physicalName(queue)}`;
}

function queueOfUrl(url: string): QueueTarget {
  const queue = (["ScanDeadlines", ...CUSTOMER_QUEUES] as const).find((candidate) => url === queueUrlOf(candidate));
  if (queue === undefined) throw new Error("SendMessage to a queue this world does not have");
  return queue;
}

export interface QueuedMessage {
  readonly queue: QueueTarget;
  readonly body: string;
  readonly groupId?: string;
  readonly dedupId?: string;
  readonly sentAtMs: number;
  readonly visibleAtMs: number;
  receiveCount: number;
}

export interface QueueConsumers {
  /** The event worker of a customer queue; throws to fail the delivery. */
  customer(queue: CustomerQueue, record: SqsRecordLike): Promise<void>;
  /** `MediaIntake` with an SQS batch of `ScanDeadlines`. */
  scanDeadline(body: string): Promise<void>;
}

export interface DeadLetter {
  readonly queue: QueueTarget;
  readonly body: string;
  readonly errorName: string;
}

export class FakeQueues {
  private readonly pending: QueuedMessage[] = [];
  private readonly dedup = new Map<string, number>();
  /** Every `SendMessage` input, in order (accepted or deduplicated). */
  readonly sent: SendMessageCommandInput[] = [];
  readonly deadLetters: DeadLetter[] = [];
  /** Receipt handles the worker released at once (`ChangeMessageVisibility` 0). */
  readonly released: string[] = [];
  private handles = 0;

  constructor(private readonly realNow: () => Date) {}

  /** The producer's `send` (worker/enqueue.ts `QueueSend`). */
  readonly send = async (input: SendMessageCommandInput): Promise<unknown> => {
    this.sent.push(input);
    const queue = queueOfUrl(input.QueueUrl ?? "");
    const nowMs = this.realNow().getTime();
    const dedupKey = input.MessageDeduplicationId === undefined ? undefined : `${queue}#${input.MessageDeduplicationId}`;
    if (dedupKey !== undefined && nowMs - (this.dedup.get(dedupKey) ?? -Infinity) < DEDUP_WINDOW_MS) return { MessageId: `dedup-${this.sent.length}` };
    if (dedupKey !== undefined) this.dedup.set(dedupKey, nowMs);
    this.pending.push({
      queue,
      body: input.MessageBody ?? "",
      ...(input.MessageGroupId === undefined ? {} : { groupId: input.MessageGroupId }),
      ...(input.MessageDeduplicationId === undefined ? {} : { dedupId: input.MessageDeduplicationId }),
      sentAtMs: nowMs,
      visibleAtMs: nowMs + (input.DelaySeconds ?? 0) * 1_000,
      receiveCount: 0,
    });
    return { MessageId: `msg-${this.sent.length}` };
  };

  /** Messages still waiting, in order (a deadline not yet due included). */
  waiting(queue?: QueueTarget): readonly QueuedMessage[] {
    return this.pending.filter((message) => queue === undefined || message.queue === queue);
  }

  /**
   * Delivers every visible message, the follow-ups they produce included, until none is left; answers
   * how many deliveries it made.
   */
  async drain(consumers: QueueConsumers): Promise<number> {
    let deliveries = 0;
    for (;;) {
      const nowMs = this.realNow().getTime();
      const index = this.pending.findIndex((message) => message.visibleAtMs <= nowMs);
      if (index < 0) return deliveries;
      if (deliveries >= MAX_DELIVERIES_PER_DRAIN) throw new Error(`more than ${MAX_DELIVERIES_PER_DRAIN} deliveries in one drain: a loop of events`);
      const [message] = this.pending.splice(index, 1);
      if (message === undefined) return deliveries;
      deliveries += 1;
      message.receiveCount += 1;
      try {
        if (message.queue === "ScanDeadlines") await consumers.scanDeadline(message.body);
        else await consumers.customer(message.queue, this.recordOf(message));
      } catch (error) {
        if (message.receiveCount >= MAX_RECEIVE_COUNT) {
          this.deadLetters.push({ queue: message.queue, body: message.body, errorName: error instanceof Error ? error.name : "unknown" });
        } else {
          this.pending.splice(index, 0, message);
        }
      }
    }
  }

  private recordOf(message: QueuedMessage): SqsRecordLike {
    this.handles += 1;
    return {
      body: message.body,
      receiptHandle: `rh-local-${this.handles}`,
      eventSourceARN: queueArnOf(message.queue),
      attributes: { ApproximateReceiveCount: String(message.receiveCount) },
    };
  }
}
