// Test helpers of media intake: an in-memory `Media` (objects, GuardDuty tags, quarantine), a world
// with its clock and a stored inbound message, and the deps of resolve.ts with the enqueued events and
// deadlines captured.
import type { ScanSource } from "../domain/runtime-claims";
import { message, testConnector } from "../connector/testing";
import { receiptPng, SUR_FIELDS, testLog } from "../receipts/testing";
import type { BindDeps } from "./resolve";
import type { MediaEventMessage, MediaObjects, ScanDeadlineMessage } from "./schema";

export class MemoryObjects implements MediaObjects {
  readonly objects = new Map<string, Uint8Array>();
  readonly tags = new Map<string, string>();
  readonly reads: string[] = [];
  readonly removed: string[] = [];

  put(key: string, bytes: Uint8Array): void {
    this.objects.set(key, bytes);
  }

  async get(key: string, maxBytes: number): Promise<Uint8Array | "TOO_LARGE" | undefined> {
    this.reads.push(key);
    const bytes = this.objects.get(key);
    if (bytes === undefined) return undefined;
    return bytes.length > maxBytes ? "TOO_LARGE" : bytes;
  }

  async scanTag(key: string): Promise<string | undefined> {
    this.reads.push(`tag:${key}`);
    return this.tags.get(key);
  }

  async quarantine(key: string): Promise<void> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) return;
    this.objects.set(`quarantine/${key}`, bytes);
    this.objects.delete(key);
  }

  async remove(key: string): Promise<void> {
    this.removed.push(key);
    this.objects.delete(key);
  }
}

export const REAL_NOW = new Date("2026-10-07T13:10:00.000Z");
export const WORLD = "g07";
export const CUSTOMER = "cus-0004";
export const SIM_NOW = "2026-10-07T10:10:00-03:00";

export interface IntakeKit {
  readonly mc: ReturnType<typeof testConnector>;
  readonly objects: MemoryObjects;
  readonly events: MediaEventMessage[];
  readonly deadlines: ScanDeadlineMessage[];
  readonly deps: BindDeps;
  readonly lines: () => Record<string, unknown>[];
  /** Advances the real clock (stamps of the registry and the audit). */
  tick(ms: number): void;
  /** Announces an object as its writer does, before it exists; `bytes` lands it in `Media`. */
  announce(input: { announceKey: string; s3Key?: string; source: ScanSource; bytes?: Uint8Array; objectKey?: string }): Promise<void>;
  /** Stores the inbound message the image came with. */
  storeMessage(messageId: string): Promise<void>;
}

export async function intakeKit(worldId = WORLD): Promise<IntakeKit> {
  let now = new Date(REAL_NOW.getTime());
  const mc = testConnector({ now: () => new Date(now.getTime()) });
  await mc.connector.runtime.putClock({ worldId, mode: "PAUSED", pausedSimNow: SIM_NOW, worldEpoch: 1 });
  const objects = new MemoryObjects();
  const events: MediaEventMessage[] = [];
  const deadlines: ScanDeadlineMessage[] = [];
  const { log, lines } = testLog();
  const deps: BindDeps = {
    connector: mc.connector,
    objects,
    enqueue: async (event) => void events.push(event),
    enqueueDeadline: async (deadline) => void deadlines.push(deadline),
    now: () => new Date(now.getTime()),
    log,
  };
  return {
    mc,
    objects,
    events,
    deadlines,
    deps,
    lines,
    tick(ms) {
      now = new Date(now.getTime() + ms);
    },
    async announce(input) {
      await mc.connector.scans.announce({ worldId, announceKey: input.announceKey, source: input.source, createdAtReal: now.toISOString(), ...(input.s3Key ? { s3Key: input.s3Key } : {}) });
      if (input.bytes) objects.put(input.objectKey ?? input.s3Key ?? input.announceKey, input.bytes);
    },
    async storeMessage(messageId) {
      await mc.connector.conversations.putMessage(message(worldId, { customerId: CUSTOMER, messageId, body: "[imagen]", atSim: SIM_NOW, media: { contentType: "image/png" } }));
    },
  };
}

/** A clean synthetic receipt (900 × 1400 PNG with its chunk). */
export function cleanReceipt(): Uint8Array {
  return receiptPng(SUR_FIELDS);
}
