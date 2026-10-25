// What enters and leaves `MediaIntake` (docs/architecture-integrations.md §9, docs/architecture.md §6-§7):
//
//   in   the GuardDuty Malware Protection result of a `Media` object (EventBridge), and the 120 s scan
//        deadline of `ScanDeadlines` (SQS, produced by worker/enqueue.ts `enqueueScanDeadline`)
//   out  `RECEIPT_RECEIVED` (a checked image; the worker files it as `RECEIPT_IMAGE` evidence and runs
//        the turn) or `MEDIA_REJECTED` (a fixed reply of copy/ through the gate, no turn), through the
//        single producer of the customer queues (worker/enqueue.ts `enqueueCustomerEvent`)
//
// Every input is parsed with zod before anything is read: a fabricated event names an object the
// registry does not know and ends as an audited orphan.
import { z } from "zod";
import { IsoInstant, WorldId } from "@reclamo/shared";
import { Id } from "../domain/common";
import { ScanResultStatus } from "../domain/runtime-claims";
import { MediaImageDetails } from "../receipts/schema";

export const SCAN_RESULT_DETAIL_TYPE = "GuardDuty Malware Protection Object Scan Result";

/** The statuses GuardDuty reports (the registry adds `TIMEOUT` for the deadline). */
export const GuardDutyScanStatus = ScanResultStatus.exclude(["TIMEOUT"]);
export type GuardDutyScanStatus = z.infer<typeof GuardDutyScanStatus>;

/** Value of the object tag GuardDuty writes after a scan (`actions.tagging`). */
export const SCAN_STATUS_TAG = "GuardDutyMalwareScanStatus";

export const GuardDutyScanEvent = z.object({
  source: z.literal("aws.guardduty"),
  "detail-type": z.literal(SCAN_RESULT_DETAIL_TYPE),
  account: z.string().regex(/^\d{12}$/).optional(),
  time: IsoInstant.optional(),
  detail: z.object({
    scanStatus: z.string().max(40).optional(),
    resourceType: z.string().max(40).optional(),
    s3ObjectDetails: z.object({ bucketName: z.string().min(3).max(63), objectKey: z.string().min(1).max(1_024) }),
    scanResultDetails: z.object({ scanResultStatus: GuardDutyScanStatus }),
  }),
});
export type GuardDutyScanEvent = z.infer<typeof GuardDutyScanEvent>;

/** The body of a `ScanDeadlines` message: which registry to look at, nothing else. */
export const ScanDeadlineMessage = z
  .object({
    kind: z.literal("SCAN_DEADLINE"),
    worldId: WorldId,
    announceKey: z.string().min(1).max(512),
    messageId: Id.optional(),
    boundAtReal: IsoInstant,
  })
  .strict();
export type ScanDeadlineMessage = z.infer<typeof ScanDeadlineMessage>;

export const SqsBatch = z.object({
  Records: z
    .array(z.object({ messageId: z.string().min(1), body: z.string().max(4_096), eventSource: z.literal("aws:sqs") }))
    .min(1)
    .max(10),
});

/** The fixed replies of copy/es-AR.ts `WHATSAPP_TEXT` an image can end in. */
export const MediaReplyKey = z.enum(["IMAGE_NOT_PROCESSED", "MEDIA_TOO_LARGE", "MEDIA_UNSUPPORTED"]);
export type MediaReplyKey = z.infer<typeof MediaReplyKey>;

/**
 * `RECEIPT_RECEIVED`: the checked image; the worker files it as `RECEIPT_IMAGE` evidence of the complaint
 * the intake bound it to (`complaintId`, when it knew one) or of the customer's newest open complaint.
 */
export const ReceiptReceivedPayload = z
  .object({
    messageId: Id,
    messageAtSim: IsoInstant,
    image: MediaImageDetails,
    complaintId: Id.optional(),
  })
  .strict();
export type ReceiptReceivedPayload = z.infer<typeof ReceiptReceivedPayload>;

/** Why an image was not taken: a scan status, or the check of its bytes that failed. */
export const MediaRejectionReason = z.enum([
  "THREATS_FOUND",
  "ACCESS_DENIED",
  "FAILED",
  "UNSUPPORTED",
  "TIMEOUT",
  "TOO_LARGE",
  "TOO_MANY_PIXELS",
  "BAD_MAGIC",
  "EMPTY",
  "UNREADABLE_HEADER",
  "GONE",
]);
export type MediaRejectionReason = z.infer<typeof MediaRejectionReason>;

/** `MEDIA_REJECTED`: the fixed reply the worker sends through the gate, without a turn. */
export const MediaRejectedPayload = z
  .object({
    messageId: Id,
    messageAtSim: IsoInstant.optional(),
    reason: MediaRejectionReason,
    reply: MediaReplyKey,
  })
  .strict();
export type MediaRejectedPayload = z.infer<typeof MediaRejectedPayload>;

interface MediaEventCommon {
  readonly eventId: string;
  readonly worldId: string;
  readonly customerId: string;
  readonly epoch: number;
  /** The world's simulated instant when the scan resolved (ADR-0011). */
  readonly eventAtSim: string;
}

/** What `MediaIntake` hands the single queue producer (worker/enqueue.ts `enqueueCustomerEvent`). */
export type MediaEventMessage =
  | (MediaEventCommon & { readonly type: "RECEIPT_RECEIVED"; readonly payload: ReceiptReceivedPayload })
  | (MediaEventCommon & { readonly type: "MEDIA_REJECTED"; readonly payload: MediaRejectedPayload });

export type MediaEventEnqueue = (message: MediaEventMessage) => Promise<void>;

export type ScanDeadlineEnqueue = (message: ScanDeadlineMessage) => Promise<void>;

/** The `Media` objects as intake uses them; every call names the REAL key (`s3Key`), never the announcement. */
export interface MediaObjects {
  /** The whole object, `TOO_LARGE` above `maxBytes` (never downloaded whole), `undefined` when gone. */
  get(key: string, maxBytes: number): Promise<Uint8Array | "TOO_LARGE" | undefined>;
  /** GuardDuty's `GuardDutyMalwareScanStatus` tag, when the scan already tagged it. */
  scanTag(key: string): Promise<string | undefined>;
  /** Copies the object under `quarantine/` and deletes the original. */
  quarantine(key: string): Promise<void>;
  remove(key: string): Promise<void>;
}
