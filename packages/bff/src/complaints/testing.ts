// Test kit of complaints/: the memory connector with a world at epoch 1, a chain key, a recording
// anchor requester, an in-memory anchor log (with CloudWatch's `ingestionTime` semantics) that the
// real `writeAnchors` of handlers/anchor-writer.ts can fill, a captured logger and deterministic ids.
import type { AnchorEvent, AnchorReader, AnchorRequest } from "./anchors";
import type { ComplaintsDeps, MilestoneScheduler } from "./deps";
import type { AnchorSink } from "../handlers/anchor-writer";
import type { MemoryStoreOptions } from "../connector/memory/engine";
import { TEST_NOW, testConnector, worldSettings } from "../connector/testing";
import { type Logger, createLogger } from "../lib/log";

/** A published-style key of the tests (never a stage secret). */
export const TEST_CHAIN_KEY = "test-chain-key-not-a-secret-0123456789abcdef";

/** The holidays of FL-076 (Monday 12/10 is not a business day). */
export const TEST_HOLIDAYS = ["2026-10-12", "2026-11-09", "2026-11-23", "2026-12-07", "2026-12-08", "2026-12-25"];

/** A log group in memory: every event gets an increasing `ingestionTime`, whatever its `timestamp`. */
export class MemoryAnchorLog implements AnchorReader {
  readonly events: AnchorEvent[] = [];
  private clock = 1_000;

  /** Appends one event as CloudWatch would ingest it now. */
  add(stream: string, message: string, timestamp?: number): AnchorEvent {
    this.clock += 1;
    const event: AnchorEvent = { stream, message, ingestionTime: this.clock, ...(timestamp !== undefined ? { timestamp } : {}) };
    this.events.push(event);
    return event;
  }

  async read(worldId: string, epoch: number): Promise<AnchorEvent[]> {
    return this.events.filter((event) => event.stream.startsWith(`${worldId}-e${epoch}-`));
  }

  sink(): AnchorSink {
    return {
      ensureStream: async () => undefined,
      put: async (stream, events) => {
        for (const event of events) this.add(stream, event.message, event.timestamp);
      },
    };
  }
}

export interface KitOptions extends MemoryStoreOptions {
  readonly worldId?: string;
  /** Called with every anchor request after the commit (the stage invokes `AnchorWriter`). */
  readonly onAnchor?: (request: AnchorRequest) => Promise<void> | void;
  readonly milestones?: MilestoneScheduler;
}

export function complaintsKit(options: KitOptions = {}) {
  const worldId = options.worldId ?? "demo";
  const { connector, store } = testConnector(options.beforeWrite ? { beforeWrite: options.beforeWrite } : {});
  const anchorRequests: AnchorRequest[] = [];
  const lines: Record<string, unknown>[] = [];
  const log: Logger = createLogger({ sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), level: "debug", now: () => TEST_NOW });
  let counter = 0;
  const deps: ComplaintsDeps = {
    connector,
    chainKey: TEST_CHAIN_KEY,
    anchors: {
      request: async (request) => {
        anchorRequests.push(request);
        await options.onAnchor?.(request);
      },
    },
    log,
    realNow: () => new Date(TEST_NOW.getTime()),
    newId: (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`,
    retry: { sleep: async () => undefined, random: () => 0 },
    ...(options.milestones ? { milestones: options.milestones } : {}),
  };
  /** Epoch 1 and the default settings of the world. */
  const seedWorld = async (id = worldId): Promise<void> => {
    await connector.transact([connector.counters.initEpochOp(id, 1)]);
    await connector.worlds.putSettings(worldSettings(id));
  };
  return { worldId, deps, connector, store, anchorRequests, lines, log, seedWorld };
}

/** Log lines with this message. */
export function linesNamed(lines: readonly Record<string, unknown>[], message: string): Record<string, unknown>[] {
  return lines.filter((line) => line.message === message);
}
