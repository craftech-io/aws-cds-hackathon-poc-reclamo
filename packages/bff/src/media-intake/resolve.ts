// The scan registry resolved in ANY order (docs/architecture.md §6, docs/architecture-integrations.md §9;
// `record_media` of docs/tool-catalog.md; FL-029, FL-101, FL-103). Three entries meet on the same
// `Runtime/W#<w>#SCANOBJ#…` item, written before the object could exist:
//
//   recordScanResult   MediaIntake, on GuardDuty's result: found by `announceKeyOf(objectKey)`; stored
//                      even when no message is bound yet; no registry → `SCAN_RESULT_ORPHAN`
//   bindScanMessage    InboundWhatsApp, on the message: binds it and opens `PENDING#…SCAN#`; with a
//                      result already there it resolves (`RESULT_FIRST`); a seed copy with a known hash
//                      is accepted at once (`SCAN_WAIT_SKIPPED_SEED`); otherwise it enqueues the 120 s
//                      deadline
//   processScanDeadline MediaIntake, on `ScanDeadlines`: re-reads the registry and GuardDuty's object
//                      tag (by `s3Key`); with either it resolves by them, with none it is `TIMEOUT`
//
// Whoever leaves the registry with both halves resolves it ONCE (`markResolved`, conditional) and
// audits `SCAN_RESOLVED` with the order. A redelivery of any entry that finds its write already done
// continues from what the registry says (resolve, or complete the effects while the pending is open),
// so a crash between two steps never leaves an image waiting. A result after a `TIMEOUT` is audited
// `SCAN_RESULT_LATE` and reopens nothing; a result of a world with a tombstone is discarded with an audit.
import type { ScanObject } from "../domain/runtime-claims";
import { ClockState, simulatedNow } from "../lib/clock";
import { sha256Hex } from "../lib/crypto";
import { MAX_IMAGE_BYTES } from "../receipts/schema";
import { isSeedReceiptHash } from "../receipts/seed-hash";
import { type BoundScan, type MediaIntakeDeps, type WorldContext, acceptClean, auditScan, completeResolution, isBound, pendingOpen, quarantine } from "./intake";
import { scanPendingId, scanTargetOf } from "./keys";
import { GuardDutyScanStatus, type ScanDeadlineEnqueue, type ScanDeadlineMessage } from "./schema";

export type ScanOrder = "RESULT_FIRST" | "BIND_FIRST";

export type ResolveOutcome =
  | "RESOLVED"
  | "STORED"
  | "WAITING"
  | "SEED_SKIPPED"
  | "ALREADY_RESOLVED"
  | "DUPLICATE"
  | "LATE"
  | "ORPHAN"
  | "TOMBSTONED"
  | "WORLD_GONE"
  | "NOT_ANNOUNCED"
  | "NOT_BOUND";

type World = ({ readonly kind: "OPEN" } & WorldContext) | { readonly kind: "TOMBSTONED"; readonly epoch: number } | { readonly kind: "GONE" };

/** The world's epoch and simulated "now" from its clock (`MediaIntake` reads `Runtime`, not `Worlds`), and its tombstone. */
async function worldOf(deps: Pick<MediaIntakeDeps, "connector" | "now">, worldId: string): Promise<World> {
  const clock = await deps.connector.runtime.getClock(worldId);
  if (clock === undefined) return { kind: "GONE" };
  const tomb = await deps.connector.runtime.getTombstone(worldId, clock.worldEpoch);
  if (tomb !== undefined) return { kind: "TOMBSTONED", epoch: clock.worldEpoch };
  // The event is dated by the world's clock (ADR-0011): an unreadable clock fails the entry, never the date.
  const simNow = simulatedNow(ClockState.parse(clock), deps.now()).toISOString();
  return { kind: "OPEN", epoch: clock.worldEpoch, simNow };
}

async function discardTombstoned(deps: MediaIntakeDeps, worldId: string, epoch: number, announceKey: string): Promise<ResolveOutcome> {
  await auditScan(deps, { worldId, epoch, announceKey, action: "TOMBSTONED_EVENT", outcome: "DISCARDED" });
  deps.log.info("media_intake.tombstoned", { worldId, epoch });
  return "TOMBSTONED";
}

/** The single resolution of a registry with both halves, then its effects. */
async function resolve(deps: MediaIntakeDeps, scan: BoundScan, order: ScanOrder, world: WorldContext): Promise<ResolveOutcome> {
  if (!(await deps.connector.scans.markResolved(scan.worldId, scan.announceKey, order))) return "ALREADY_RESOLVED";
  await auditScan(deps, { worldId: scan.worldId, epoch: world.epoch, announceKey: scan.announceKey, action: "SCAN_RESOLVED", outcome: scan.result ?? "NONE", refs: { messageId: scan.messageId }, detail: { order } });
  await completeResolution(deps, scan, world);
  return "RESOLVED";
}

/** A seed copy accepted without waiting: its pending is closed but its registry not resolved. */
async function acceptedAsSeed(deps: MediaIntakeDeps, scan: ScanObject): Promise<boolean> {
  return scan.source === "SEED_COPY" && scan.resolvedAtReal === undefined && isBound(scan) && !(await pendingOpen(deps, scan));
}

/** A late result for a seed copy already accepted: it only matters when it found a threat. */
async function lateSeedResult(deps: MediaIntakeDeps, scan: BoundScan, world: WorldContext): Promise<ResolveOutcome> {
  // The quarantine goes first: a retry after a failed move finds the registry still unresolved.
  if (scan.result === "THREATS_FOUND") await quarantine(deps, scan, world);
  await deps.connector.scans.markResolved(scan.worldId, scan.announceKey, "BIND_FIRST");
  return "LATE";
}

/** Both halves are there and nobody resolved them yet: resolve now (a seed copy only settles its late result). */
async function settle(deps: MediaIntakeDeps, scan: BoundScan, order: ScanOrder, world: WorldContext): Promise<ResolveOutcome> {
  if (await acceptedAsSeed(deps, scan)) return lateSeedResult(deps, scan, world);
  return resolve(deps, scan, order, world);
}

/**
 * A registry an earlier delivery already wrote: with both halves and no resolution it resolves (once);
 * resolved while its pending is still open, its effects complete (they are idempotent: the event and
 * audit ids derive from the registry). `undefined` when it lacks a half.
 */
async function continueExisting(deps: MediaIntakeDeps, scan: ScanObject, world: WorldContext, order: ScanOrder): Promise<ResolveOutcome | undefined> {
  if (!isBound(scan) || scan.result === undefined) return undefined;
  if (scan.resolvedAtReal === undefined) return settle(deps, scan, order, world);
  if (!(await pendingOpen(deps, scan))) return "ALREADY_RESOLVED";
  await completeResolution(deps, scan, world);
  return "RESOLVED";
}

export async function recordScanResult(deps: MediaIntakeDeps, input: { readonly objectKey: string; readonly status: GuardDutyScanStatus }): Promise<ResolveOutcome> {
  const target = scanTargetOf(input.objectKey);
  if (target === undefined) {
    deps.log.warn("media_intake.unattributed_result", { status: input.status });
    return "ORPHAN";
  }
  const { worldId, announceKey } = target;
  const world = await worldOf(deps, worldId);
  if (world.kind === "GONE") {
    deps.log.info("media_intake.world_gone", { worldId });
    return "WORLD_GONE";
  }
  if (world.kind === "TOMBSTONED") return discardTombstoned(deps, worldId, world.epoch, announceKey);

  const after = await deps.connector.scans.recordResult(worldId, announceKey, { status: input.status, objectKey: input.objectKey });
  if (after === undefined) {
    const existing = await deps.connector.scans.get(worldId, announceKey);
    if (existing === undefined) {
      await auditScan(deps, { worldId, epoch: world.epoch, announceKey, action: "SCAN_RESULT_ORPHAN", outcome: input.status });
      deps.log.warn("media_intake.orphan_result", { worldId, status: input.status });
      return "ORPHAN";
    }
    if (existing.result === "TIMEOUT") {
      await auditScan(deps, { worldId, epoch: world.epoch, announceKey, action: "SCAN_RESULT_LATE", outcome: input.status, ...(existing.messageId ? { refs: { messageId: existing.messageId } } : {}) });
      // Reopens nothing; a threat still leaves the readable prefixes (the object GuardDuty named).
      if (input.status === "THREATS_FOUND") await quarantine(deps, { ...existing, s3Key: input.objectKey }, world);
      return "LATE";
    }
    return (await continueExisting(deps, existing, world, "BIND_FIRST")) ?? "DUPLICATE";
  }

  const latency = Date.parse(after.resultAtReal ?? "") - Date.parse(after.createdAtReal);
  if (Number.isFinite(latency)) deps.log.info("media_intake.scan_result", { metric: "ScanLatency", scanLatencyMs: latency, status: input.status, worldId });
  if (!isBound(after)) return "STORED";
  return settle(deps, after, "BIND_FIRST", world);
}

export interface BindDeps extends MediaIntakeDeps {
  readonly enqueueDeadline: ScanDeadlineEnqueue;
}

export interface BindInput {
  readonly worldId: string;
  readonly announceKey: string;
  readonly messageId: string;
  readonly customerId: string;
  readonly complaintId?: string;
}

/** A server-side copy of a synthetic receipt: its bytes hash to one the seed rendered. */
async function isKnownSeedCopy(deps: MediaIntakeDeps, scan: BoundScan): Promise<boolean> {
  if (scan.s3Key === undefined) return false;
  const bytes = await deps.objects.get(scan.s3Key, MAX_IMAGE_BYTES);
  if (!(bytes instanceof Uint8Array)) return false;
  return isSeedReceiptHash(deps.connector, sha256Hex(bytes));
}

/** A bound registry without a result: a known seed copy is accepted at once, anything else waits 120 s. */
async function skipOrWait(deps: BindDeps, scan: BoundScan, world: WorldContext): Promise<ResolveOutcome> {
  if (scan.source === "SEED_COPY" && (await isKnownSeedCopy(deps, scan))) {
    await auditScan(deps, { worldId: scan.worldId, epoch: world.epoch, announceKey: scan.announceKey, action: "SCAN_WAIT_SKIPPED_SEED", refs: { messageId: scan.messageId } });
    await acceptClean(deps, scan, world, "SEED_SKIPPED");
    return "SEED_SKIPPED";
  }
  const deadline: ScanDeadlineMessage = { kind: "SCAN_DEADLINE", worldId: scan.worldId, announceKey: scan.announceKey, messageId: scan.messageId, boundAtReal: scan.boundAtReal ?? deps.now().toISOString() };
  await deps.enqueueDeadline(deadline);
  return "WAITING";
}

/** Called by InboundWhatsApp once the message is stored: binds it, then resolves, skips or waits. */
export async function bindScanMessage(deps: BindDeps, input: BindInput): Promise<ResolveOutcome> {
  const world = await worldOf(deps, input.worldId);
  if (world.kind === "GONE") return "WORLD_GONE";
  if (world.kind === "TOMBSTONED") return discardTombstoned(deps, input.worldId, world.epoch, input.announceKey);
  const pending = {
    worldId: input.worldId,
    kind: "SCAN" as const,
    pendingId: scanPendingId(input.announceKey),
    openedAtReal: deps.now().toISOString(),
    customerId: input.customerId,
    ...(input.complaintId ? { complaintId: input.complaintId } : {}),
    ref: input.messageId,
  };
  // A missing registry or a message already bound both cancel the transaction (`undefined`).
  const after = await deps.connector.scans.bind(input.worldId, input.announceKey, { messageId: input.messageId, customerId: input.customerId, pending });
  if (after !== undefined) {
    if (!isBound(after)) throw new Error("a bound registry without its message");
    return after.result === undefined ? skipOrWait(deps, after, world) : resolve(deps, after, "RESULT_FIRST", world);
  }
  const existing = await deps.connector.scans.get(input.worldId, input.announceKey);
  if (existing === undefined) return "NOT_ANNOUNCED";
  const resumed = await continueExisting(deps, existing, world, "RESULT_FIRST");
  if (resumed !== undefined) return resumed;
  // This message was bound by a delivery that stopped before its tail: run the tail again (a second
  // deadline is harmless, the first one to arrive settles the registry).
  if (isBound(existing) && existing.messageId === input.messageId && (await pendingOpen(deps, existing))) return skipOrWait(deps, existing, world);
  return "DUPLICATE";
}

/** 120 real seconds after the binding: the registry and the object's tag decide, or it is a `TIMEOUT`. */
export async function processScanDeadline(deps: MediaIntakeDeps, message: ScanDeadlineMessage): Promise<ResolveOutcome> {
  const world = await worldOf(deps, message.worldId);
  if (world.kind === "GONE") return "WORLD_GONE";
  if (world.kind === "TOMBSTONED") return discardTombstoned(deps, message.worldId, world.epoch, message.announceKey);
  const scan = await deps.connector.scans.get(message.worldId, message.announceKey);
  if (scan === undefined) {
    deps.log.warn("media_intake.deadline_without_registry", { worldId: message.worldId });
    return "NOT_ANNOUNCED";
  }
  if (!isBound(scan)) return "NOT_BOUND";
  const resumed = await continueExisting(deps, scan, world, "BIND_FIRST");
  if (resumed !== undefined) return resumed;
  // A seed copy accepted at the binding has nothing to wait for.
  if (await acceptedAsSeed(deps, scan)) return "ALREADY_RESOLVED";

  // A lost EventBridge event must not leave the image unread: GuardDuty's tag says what it found.
  // A live registry without `s3Key` has no object to read and is not asked.
  const tag = scan.s3Key === undefined ? undefined : GuardDutyScanStatus.safeParse(await deps.objects.scanTag(scan.s3Key));
  const status = tag?.success ? tag.data : "TIMEOUT";
  // A bound registry always has its real key (InboundWhatsApp binds only what it located).
  const after = await deps.connector.scans.recordResult(scan.worldId, scan.announceKey, { status, objectKey: scan.s3Key ?? scan.announceKey });
  if (after === undefined) {
    // The real result landed between the read and the write: settle by it.
    const raced = await deps.connector.scans.get(scan.worldId, scan.announceKey);
    return (raced && (await continueExisting(deps, raced, world, "BIND_FIRST"))) ?? "DUPLICATE";
  }
  if (!isBound(after)) return "NOT_BOUND";
  deps.log.info("media_intake.deadline", { worldId: scan.worldId, status, byTag: status !== "TIMEOUT" });
  return resolve(deps, after, "BIND_FIRST", world);
}
