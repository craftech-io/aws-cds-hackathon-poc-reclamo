/// <reference path="../../sst-env.d.ts" />
// Lambda entry of `MediaIntake` (docs/architecture-integrations.md §9, docs/architecture.md §6): the
// EventBridge rule of the GuardDuty Malware Protection results of `Media` (infra/malware.ts) and the
// `ScanDeadlines` queue (infra/workers.ts) both invoke it. It validates the input with zod and hands it
// to media-intake/resolve.ts; it never reads an image for a model and never sends: a decision leaves as
// `RECEIPT_RECEIVED` or `MEDIA_REJECTED` through the single queue producer (worker/enqueue.ts
// `mediaEventEnqueue`), which also takes the event in flight in `Runtime` (`MediaIntake` holds Runtime write).
//
// A malformed input, a result for another bucket or an orphan returns normally (no retry, no dead
// letter); anything that failed midway throws, so EventBridge (asynchronous retries) or SQS delivers
// it again and resolve.ts completes what was interrupted.
import type { Context } from "aws-lambda";
import { dynamoConnector } from "../connector/dynamo/connector";
import { type LogSink, type Logger, correlationIdFrom, createLogger } from "../lib/log";
import { bucketName } from "../lib/resource";
import type { MediaIntakeDeps } from "../media-intake/intake";
import { s3MediaObjects } from "../media-intake/objects";
import { type ResolveOutcome, processScanDeadline, recordScanResult } from "../media-intake/resolve";
import { GuardDutyScanEvent, ScanDeadlineMessage, SqsBatch } from "../media-intake/schema";
import { linkedEnqueuer, mediaEventEnqueue } from "../worker/enqueue";

export interface MediaIntakeHandlerDeps extends Omit<MediaIntakeDeps, "log" | "enqueue"> {
  /** The single producer of the customer queues, with the invocation's logger. */
  readonly enqueue: (log: Logger) => MediaIntakeDeps["enqueue"];
  /** Physical name of `Media`: a result for any other bucket is not ours. */
  readonly mediaBucket: string;
  readonly logSink?: LogSink;
}

export type MediaIntakeSummary =
  | { readonly kind: "SCAN_RESULT"; readonly outcome: ResolveOutcome | "WRONG_BUCKET" }
  | { readonly kind: "DEADLINES"; readonly outcomes: readonly (ResolveOutcome | "INVALID")[] }
  | { readonly kind: "INVALID" };

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function deadlines(deps: MediaIntakeDeps, records: readonly { body: string }[], log: Logger): Promise<MediaIntakeSummary> {
  const outcomes: (ResolveOutcome | "INVALID")[] = [];
  for (const record of records) {
    const message = ScanDeadlineMessage.safeParse(parseBody(record.body));
    if (!message.success) {
      log.warn("media_intake.invalid_deadline");
      outcomes.push("INVALID");
      continue;
    }
    outcomes.push(await processScanDeadline(deps, message.data));
  }
  return { kind: "DEADLINES", outcomes };
}

export function createMediaIntakeHandler(build: () => MediaIntakeHandlerDeps) {
  return async (event: unknown, context: Pick<Context, "awsRequestId">): Promise<MediaIntakeSummary> => {
    const { mediaBucket, logSink, enqueue, ...rest } = build();
    const log = createLogger({ correlationId: correlationIdFrom(context.awsRequestId), bindings: { fn: "MediaIntake" }, ...(logSink === undefined ? {} : { sink: logSink }) });
    const deps: MediaIntakeDeps = { ...rest, enqueue: enqueue(log), log };
    const batch = SqsBatch.safeParse(event);
    if (batch.success) return deadlines(deps, batch.data.Records, log);
    const scan = GuardDutyScanEvent.safeParse(event);
    if (!scan.success) {
      log.warn("media_intake.invalid_event");
      return { kind: "INVALID" };
    }
    const { bucketName: bucket, objectKey } = scan.data.detail.s3ObjectDetails;
    if (bucket !== mediaBucket) {
      log.warn("media_intake.wrong_bucket");
      return { kind: "SCAN_RESULT", outcome: "WRONG_BUCKET" };
    }
    const outcome = await recordScanResult(deps, { objectKey, status: scan.data.detail.scanResultDetails.scanResultStatus });
    log.info("media_intake.scan_result_handled", { outcome });
    return { kind: "SCAN_RESULT", outcome };
  };
}

let stageDeps: MediaIntakeHandlerDeps | undefined;

function mediaIntakeDeps(): MediaIntakeHandlerDeps {
  if (stageDeps === undefined) {
    const mediaBucket = bucketName("Media");
    const connector = dynamoConnector();
    stageDeps = { connector, objects: s3MediaObjects(mediaBucket), enqueue: (log) => mediaEventEnqueue(linkedEnqueuer(connector, log)), now: () => new Date(), mediaBucket };
  }
  return stageDeps;
}

export const handler = createMediaIntakeHandler(mediaIntakeDeps);
