// Test kit of timers/ and clock/: the memory connector, a recording queue sink, a recording Scheduler
// (what exists, what was put and deleted), a fake of the networks, a captured logger, a movable real
// clock and deterministic ids. Nothing here touches AWS.
import type { PublishResult, TransferStatus } from "@reclamo/core-contract";
import type { NewOf } from "../connector/codec";
import { TEST_NOW, testConnector, timer as timerFixture } from "../connector/testing";
import type { MemoryStoreOptions } from "../connector/memory/engine";
import type { Timer } from "../domain/timer";
import { type Logger, createLogger } from "../lib/log";
import type { NetworkClient } from "../networks/client";
import { TEST_CHAIN_KEY } from "../complaints/testing";
import type { GateOutcome, OutboundCall, OutboundRequest } from "../outbound/types";
import type { TimerDeps } from "./deps";
import type { SupervisorAlert, TimerEffectDeps, TimerQueueEvent as TimerEvent } from "./effects";
import type { TimerQueueEvent } from "./events";
import type { ScheduleSpec, SchedulerPort } from "./scheduler-client";

/** Wednesday 07/10/2026 10:10 in Argentina: where every template world starts. */
export const START_SIM = "2026-10-07T10:10:00-03:00";

export class RecordingScheduler implements SchedulerPort {
  readonly live = new Map<string, ScheduleSpec>();
  readonly puts: ScheduleSpec[] = [];
  readonly deletes: string[] = [];

  async put(spec: ScheduleSpec): Promise<void> {
    this.puts.push(spec);
    this.live.set(spec.name, spec);
  }

  async delete(name: string): Promise<void> {
    this.deletes.push(name);
    this.live.delete(name);
  }
}

export interface FakeNetworks extends Pick<NetworkClient, "publishSettlement" | "transitionTransfer"> {
  readonly calls: { op: string; worldId: string; simNow: string; args: unknown[] }[];
}

/** Networks that publish (or defer once) and move transfers; `fail` makes every call throw. */
export function fakeNetworks(options: { deferTo?: string; fail?: Error; transition?: (transferId: string) => TransferStatus | Error } = {}): FakeNetworks {
  const calls: FakeNetworks["calls"] = [];
  let deferred = false;
  const simOf = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);
  return {
    calls,
    async publishSettlement(call, network, businessDate) {
      calls.push({ op: "publish", worldId: call.worldId, simNow: simOf(call.simNow), args: [network, businessDate] });
      if (options.fail) throw options.fail;
      const batch = { network, businessDate, status: "PUBLISHED", publishAtSim: simOf(call.simNow), publishedAtSim: simOf(call.simNow), lineCount: 2, sha256: "a".repeat(64) };
      if (options.deferTo && !deferred) {
        deferred = true;
        return { outcome: "DEFERRED", batch: { ...batch, status: "PENDING", publishAtSim: options.deferTo } } as unknown as PublishResult;
      }
      return { outcome: "PUBLISHED", batch } as unknown as PublishResult;
    },
    async transitionTransfer(call, transferId, transition) {
      calls.push({ op: "transition", worldId: call.worldId, simNow: simOf(call.simNow), args: [transferId, transition] });
      const answer = options.transition?.(transferId) ?? { transferId, status: transition.to };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

export interface KitOptions extends MemoryStoreOptions {
  readonly networks?: FakeNetworks;
  /** Without a Scheduler (a role without TIMERS). */
  readonly noScheduler?: boolean;
  /** Makes the queue fail. */
  readonly sinkFails?: boolean;
}

export function timersKit(options: KitOptions = {}) {
  const { connector, store } = testConnector(options.beforeWrite ? { beforeWrite: options.beforeWrite } : {});
  const events: TimerQueueEvent[] = [];
  const lines: Record<string, unknown>[] = [];
  const scheduler = new RecordingScheduler();
  const networks = options.networks ?? fakeNetworks();
  const clock = { now: new Date(TEST_NOW.getTime()) };
  const log: Logger = createLogger({ sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), level: "debug", now: () => clock.now });
  let counter = 0;
  const deps: TimerDeps = {
    connector,
    sink: {
      enqueue: async (event) => {
        if (options.sinkFails) throw new Error("queue down");
        events.push(event);
      },
    },
    networks,
    ...(options.noScheduler ? {} : { scheduler }),
    log,
    realNow: () => new Date(clock.now.getTime()),
    newId: (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`,
  };

  /** A world with its clock paused at `simNow` (epoch 1). */
  const seedWorld = async (worldId = "demo", simNow = START_SIM): Promise<void> => {
    await connector.transact([connector.counters.initEpochOp(worldId, 1)]);
    await connector.runtime.putClock({ worldId, mode: "PAUSED", pausedSimNow: simNow, worldEpoch: 1 });
  };

  /** Puts timers (fixture defaults: an SLA milestone of `cmp-0001`). */
  const putTimers = async (worldId: string, ...overrides: Partial<NewOf<typeof Timer>>[]): Promise<void> => {
    await connector.transact(overrides.map((override) => connector.timers.putOp(timerFixture(worldId, override))));
  };

  const getTimer = (worldId: string, kind: Timer["kind"], timerId: string) => connector.timers.get({ worldId, kind, timerId }, { consistent: true });

  /** Moves the real clock forward. */
  const passReal = (ms: number): void => {
    clock.now = new Date(clock.now.getTime() + ms);
  };

  /** The worker's deps over the same connector: a recording gate and supervisor alert. */
  const gateCalls: { request: OutboundRequest; call: OutboundCall }[] = [];
  const alerts: SupervisorAlert[] = [];
  const effectDeps = (gateOutcome?: GateOutcome): TimerEffectDeps => ({
    connector,
    complaints: {
      connector,
      chainKey: TEST_CHAIN_KEY,
      anchors: { request: async () => undefined },
      log,
      realNow: () => new Date(clock.now.getTime()),
      newId: (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`,
      retry: { sleep: async () => undefined, random: () => 0 },
    },
    gate: async (request, call) => {
      gateCalls.push({ request, call });
      return gateOutcome ?? { ok: true, decision: "ALLOWED", messageId: "msg-0001", ruleIds: [] };
    },
    log,
    realNow: () => new Date(clock.now.getTime()),
    newId: (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`,
    supervisorAlert: async (alert) => {
      alerts.push(alert);
    },
  });

  /** The `TIMER` events enqueued so far. */
  const timerEvents = (): TimerEvent[] => events.filter((event): event is TimerEvent => event.type === "TIMER") as TimerEvent[];

  return { connector, store, deps, events, lines, scheduler, networks, clock, log, seedWorld, putTimers, getTimer, passReal, effectDeps, gateCalls, alerts, timerEvents };
}

