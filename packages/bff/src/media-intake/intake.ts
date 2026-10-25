// What a resolved scan does (docs/architecture-integrations.md §9, docs/architecture.md §6; FL-029):
//
//   NO_THREATS_FOUND            the object (by `s3Key`) passes magic number, ≤ 3.75 MB and ≤ 8,000 px
//                               → message marked, `RECEIPT_RECEIVED`, `MEDIA_ACCEPTED`; otherwise the
//                               object is deleted and `MEDIA_REJECTED` with the fixed reply of the check
//   THREATS_FOUND               `quarantine/`, audit `MALWARE`, metric `MalwareFindings`, `MEDIA_REJECTED`
//   ACCESS_DENIED, FAILED,      the image is never read: audit `SCAN_NOT_COMPLETED` with the status,
//   UNSUPPORTED, TIMEOUT        metric `ScanFailures`, `MEDIA_REJECTED` with `IMAGE_NOT_PROCESSED`
//
// In every case the quiescence pending `SCAN#` closes LAST: while it is open a redelivery knows the
// resolution did not finish and completes it (resolve.ts). Every effect is idempotent: the event id and
// the audit ids derive from the registry, so a completion run twice enqueues and audits once.
import { ConnectorError } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import { scanObjectId } from "../connector/repos/scans";
import type { NewOf } from "../connector/codec";
import type { Evidence } from "../domain/case-items";
import type { ScanObject } from "../domain/runtime-claims";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { inspectImage } from "../receipts/image";
import { MAX_IMAGE_BYTES, type MediaImageDetails } from "../receipts/schema";
import { mediaEventId, scanPendingId } from "./keys";
import { type MediaEventEnqueue, type MediaObjects, MediaRejectedPayload, type MediaRejectionReason, type MediaReplyKey, ReceiptReceivedPayload } from "./schema";

export interface MediaIntakeDeps {
  readonly connector: Pick<Connector, "scans" | "runtime" | "audit" | "conversations" | "reference" | "write">;
  readonly objects: MediaObjects;
  readonly enqueue: MediaEventEnqueue;
  /** Real clock: audit stamps and the registry (scans are real time, ADR-0011). */
  readonly now: () => Date;
  readonly log: Logger;
}

/** A registry with both halves: a message bound to it (and, except for a seed skip, a result). */
export type BoundScan = ScanObject & { readonly messageId: string; readonly customerId: string };

export function isBound(scan: ScanObject): scan is BoundScan {
  return scan.messageId !== undefined && scan.customerId !== undefined;
}

const SHORT_ACTION: Readonly<Record<string, string>> = {
  SCAN_RESOLVED: "res",
  MEDIA_ACCEPTED: "acc",
  MEDIA_REJECTED: "rej",
  MALWARE: "mal",
  SCAN_NOT_COMPLETED: "snc",
  SCAN_RESULT_LATE: "late",
  SCAN_RESULT_ORPHAN: "orph",
  SCAN_WAIT_SKIPPED_SEED: "seed",
  TOMBSTONED_EVENT: "tomb",
};

/** One audit row per registry and action: a retried completion finds it written and goes on. */
export async function auditScan(
  deps: Pick<MediaIntakeDeps, "connector" | "now" | "log">,
  entry: { worldId: string; epoch: number; announceKey: string; action: keyof typeof SHORT_ACTION; outcome?: string; refs?: Record<string, string>; detail?: Record<string, string | number> },
): Promise<void> {
  const id = scanObjectId(entry.announceKey);
  const now = deps.now();
  try {
    await deps.connector.audit.append({
      worldId: entry.worldId,
      epoch: entry.epoch,
      auditId: `aud-scan-${SHORT_ACTION[entry.action] ?? "x"}-${id}${entry.action === "SCAN_RESULT_ORPHAN" || entry.action === "SCAN_RESULT_LATE" ? `-${now.getTime()}` : ""}`,
      ts: now.toISOString(),
      action: entry.action,
      actor: "SYSTEM",
      refs: { scanObjectId: id, ...(entry.refs ?? {}) },
      ...(entry.refs?.messageId ? { primaryRef: `MSG#${entry.refs.messageId}` } : {}),
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return;
    throw error;
  }
}

export async function pendingOpen(deps: Pick<MediaIntakeDeps, "connector">, scan: Pick<ScanObject, "worldId" | "announceKey">): Promise<boolean> {
  const id = scanPendingId(scan.announceKey);
  return (await deps.connector.runtime.listPending(scan.worldId)).some((pending) => pending.kind === "SCAN" && pending.pendingId === id);
}

async function closePending(deps: MediaIntakeDeps, scan: BoundScan): Promise<void> {
  await deps.connector.write(deps.connector.runtime.closePendingOp(scan.worldId, "SCAN", scanPendingId(scan.announceKey)));
}

/** The epoch and the simulated "now" of the world when the scan resolved. */
export interface WorldContext {
  readonly epoch: number;
  readonly simNow: string;
}

/** The message's `media.scan`, so the case view and the simulator show what became of the image. */
async function markMessage(deps: MediaIntakeDeps, scan: BoundScan, state: string): Promise<string | undefined> {
  const message = await deps.connector.conversations.findMessage(scan.worldId, scan.customerId, scan.messageId);
  if (message === undefined) return undefined;
  await deps.connector.conversations.updateMessage(
    { worldId: scan.worldId, customerId: scan.customerId, atSim: message.atSim, messageId: message.messageId },
    { media: { ...(message.media ?? {}), announceKey: scan.announceKey, ...(scan.s3Key ? { s3Key: scan.s3Key } : {}), scan: state } },
  );
  return message.atSim;
}

const REPLY_OF: Readonly<Record<MediaRejectionReason, MediaReplyKey>> = {
  TOO_LARGE: "MEDIA_TOO_LARGE",
  TOO_MANY_PIXELS: "MEDIA_TOO_LARGE",
  BAD_MAGIC: "MEDIA_UNSUPPORTED",
  EMPTY: "IMAGE_NOT_PROCESSED",
  UNREADABLE_HEADER: "IMAGE_NOT_PROCESSED",
  GONE: "IMAGE_NOT_PROCESSED",
  THREATS_FOUND: "IMAGE_NOT_PROCESSED",
  ACCESS_DENIED: "IMAGE_NOT_PROCESSED",
  FAILED: "IMAGE_NOT_PROCESSED",
  UNSUPPORTED: "IMAGE_NOT_PROCESSED",
  TIMEOUT: "IMAGE_NOT_PROCESSED",
};

function common(scan: BoundScan, world: WorldContext) {
  return { eventId: mediaEventId(scan.announceKey), worldId: scan.worldId, customerId: scan.customerId, epoch: world.epoch, eventAtSim: world.simNow };
}

/** The fixed reply, without a turn and without reading the image. */
export async function rejectMedia(deps: MediaIntakeDeps, scan: BoundScan, world: WorldContext, reason: MediaRejectionReason): Promise<void> {
  const reply = REPLY_OF[reason];
  const messageAtSim = await markMessage(deps, scan, reason);
  const payload = MediaRejectedPayload.parse({ messageId: scan.messageId, ...(messageAtSim ? { messageAtSim } : {}), reason, reply });
  await deps.enqueue({ type: "MEDIA_REJECTED", ...common(scan, world), payload });
  await auditScan(deps, { worldId: scan.worldId, epoch: world.epoch, announceKey: scan.announceKey, action: "MEDIA_REJECTED", outcome: reply, refs: { messageId: scan.messageId }, detail: { reason } });
  await closePending(deps, scan);
  deps.log.info("media_intake.rejected", { worldId: scan.worldId, reason, reply });
}

/**
 * A clean (or seed) object: checked by its bytes, then handed to the worker. An object that fails is
 * deleted from `Media` and never reaches a model.
 */
export async function acceptClean(deps: MediaIntakeDeps, scan: BoundScan, world: WorldContext, state: MediaImageDetails["scan"]): Promise<"ACCEPTED" | "REJECTED"> {
  const key = scan.s3Key;
  const bytes = key === undefined ? undefined : await deps.objects.get(key, MAX_IMAGE_BYTES);
  const check = bytes instanceof Uint8Array ? inspectImage(bytes) : undefined;
  if (key === undefined || !(bytes instanceof Uint8Array) || check === undefined || !check.ok) {
    const reason: MediaRejectionReason = bytes === "TOO_LARGE" ? "TOO_LARGE" : check !== undefined && !check.ok ? check.problem : "GONE";
    if (key !== undefined && bytes !== undefined) await deps.objects.remove(key);
    await rejectMedia(deps, scan, world, reason);
    return "REJECTED";
  }
  const image: MediaImageDetails = {
    s3Key: key,
    sha256: sha256Hex(bytes),
    contentType: check.contentType,
    sizeBytes: check.sizeBytes,
    width: check.width,
    height: check.height,
    scan: state,
    messageId: scan.messageId,
    source: scan.source,
  };
  const messageAtSim = (await markMessage(deps, scan, state)) ?? world.simNow;
  const payload = ReceiptReceivedPayload.parse({ messageId: scan.messageId, messageAtSim, image });
  await deps.enqueue({ type: "RECEIPT_RECEIVED", ...common(scan, world), payload });
  await auditScan(deps, { worldId: scan.worldId, epoch: world.epoch, announceKey: scan.announceKey, action: "MEDIA_ACCEPTED", outcome: state, refs: { messageId: scan.messageId } });
  await closePending(deps, scan);
  deps.log.info("media_intake.accepted", { worldId: scan.worldId, scan: state, sizeBytes: check.sizeBytes });
  return "ACCEPTED";
}

/** A threat: the object leaves the readable prefixes; the customer gets the neutral fixed reply. */
export async function quarantine(deps: MediaIntakeDeps, scan: Pick<ScanObject, "worldId" | "announceKey" | "s3Key" | "messageId">, world: WorldContext): Promise<void> {
  if (scan.s3Key !== undefined) await deps.objects.quarantine(scan.s3Key);
  deps.log.warn("media_intake.malware", { metric: "MalwareFindings", worldId: scan.worldId });
  await auditScan(deps, { worldId: scan.worldId, epoch: world.epoch, announceKey: scan.announceKey, action: "MALWARE", outcome: "QUARANTINED", ...(scan.messageId ? { refs: { messageId: scan.messageId } } : {}) });
}

/** The effects of a resolved registry, by its result (the table at the top). */
export async function completeResolution(deps: MediaIntakeDeps, scan: BoundScan, world: WorldContext): Promise<void> {
  switch (scan.result) {
    case "NO_THREATS_FOUND":
      await acceptClean(deps, scan, world, "NO_THREATS_FOUND");
      return;
    case "THREATS_FOUND":
      await quarantine(deps, scan, world);
      await rejectMedia(deps, scan, world, "THREATS_FOUND");
      return;
    case undefined:
      throw new Error("a registry without a result cannot be completed");
    default:
      deps.log.error("media_intake.scan_not_completed", { metric: "ScanFailures", status: scan.result, worldId: scan.worldId });
      await auditScan(deps, { worldId: scan.worldId, epoch: world.epoch, announceKey: scan.announceKey, action: "SCAN_NOT_COMPLETED", outcome: scan.result, refs: { messageId: scan.messageId } });
      await rejectMedia(deps, scan, world, scan.result);
  }
}

/** The `RECEIPT_IMAGE` evidence id of an image: one per message, so a redelivered event files it once. */
export function receiptImageEvidenceId(messageId: string): string {
  return `evd-img-${messageId}`;
}

/** The evidence the worker files for `RECEIPT_RECEIVED` in the complaint it belongs to. */
export function receiptImageEvidence(input: { worldId: string; complaintId: string; payload: ReceiptReceivedPayload; atSim: string }): NewOf<typeof Evidence> {
  return {
    worldId: input.worldId,
    complaintId: input.complaintId,
    evidenceId: receiptImageEvidenceId(input.payload.messageId),
    kind: "RECEIPT_IMAGE",
    atSim: input.atSim,
    actor: "SYSTEM",
    details: { ...input.payload.image },
  };
}
