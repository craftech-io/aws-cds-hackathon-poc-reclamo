// The image half of an inbound message (docs/architecture.md §6, docs/architecture-integrations.md §9):
// `InboundWhatsApp` binds the stored message to the `SCANOBJ#` the adapter announced before the object
// could exist (media-intake/resolve.ts `bindScanMessage`). With the scan result already there (or a
// seed copy with a known hash) the binding resolves at once, and what the resolution hands over leaves
// through the single queue producer (worker/enqueue.ts `mediaEventEnqueue`), as from `MediaIntake`:
//
//   RECEIPT_RECEIVED   the checked image, with the complaint the intake bound the message to; the worker
//                      files it as `RECEIPT_IMAGE` evidence (worker/receipt.ts) and runs the turn
//   MEDIA_REJECTED     the fixed reply of the check that failed, sent by the worker through the gate
//
// Without a result yet, the 120 s deadline goes to `ScanDeadlines` through the same single producer.
import type { Caller } from "@reclamo/shared";
import type { Logger } from "../lib/log";
import type { MediaIntakeDeps } from "../media-intake/intake";
import { type BindDeps, type ResolveOutcome, bindScanMessage } from "../media-intake/resolve";
import type { MediaEventEnqueue, MediaObjects } from "../media-intake/schema";
import { type Enqueuer, mediaEventEnqueue } from "../worker/enqueue";

export interface BindPorts {
  readonly connector: MediaIntakeDeps["connector"];
  readonly objects: MediaObjects;
  readonly enqueuer: Enqueuer;
  readonly now: () => Date;
  readonly log: Logger;
}

/** The producer's `MediaEventEnqueue`, with the complaint the intake already knows for this message. */
export function intakeMediaEnqueue(enqueuer: Enqueuer, complaintId: string | undefined): MediaEventEnqueue {
  const enqueue = mediaEventEnqueue(enqueuer);
  return async (message) => {
    if (message.type === "RECEIPT_RECEIVED" && complaintId !== undefined) {
      await enqueue({ ...message, payload: { ...message.payload, complaintId } });
      return;
    }
    await enqueue(message);
  };
}

/** Binds the message to its image; resolves, skips (seed copy) or schedules the 120 s deadline. */
export async function bindImage(ports: BindPorts, input: { worldId: string; customerId: string; messageId: string; announceKey: string; complaintId?: string }): Promise<ResolveOutcome> {
  const caller: Caller = { kind: "CHANNEL", worldId: input.worldId, eventId: input.messageId };
  const deps: BindDeps = {
    connector: ports.connector,
    objects: ports.objects,
    enqueue: intakeMediaEnqueue(ports.enqueuer, input.complaintId),
    enqueueDeadline: ({ kind: _kind, ...deadline }) => ports.enqueuer.enqueueScanDeadline(deadline, caller),
    now: ports.now,
    log: ports.log,
  };
  const outcome = await bindScanMessage(deps, { worldId: input.worldId, announceKey: input.announceKey, messageId: input.messageId, customerId: input.customerId, ...(input.complaintId === undefined ? {} : { complaintId: input.complaintId }) });
  ports.log.info("intake.media_bound", { outcome });
  return outcome;
}
