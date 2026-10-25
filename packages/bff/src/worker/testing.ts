// Test kit of the event workers: a world in the memory connector (META `READY`, epoch 1, settings,
// the customer's conversation), the complaints/ dependencies over the same connector, a gate that records
// what it is asked, a scripted Harness, a scripted G1, the real producer (worker/enqueue.ts) over a
// recording `SendMessage`, recording handlers of the other modules, and a logger whose lines the test
// reads. Synthetic data only: no phone, no email, no name of a real person.
import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import type { HarnessClient, HarnessTurnRequest, HarnessTurnResult } from "../agent/harness-client";
import { type MemoryRetriever, NO_MEMORY } from "../agent/memory";
import type { ComplaintsDeps } from "../complaints/deps";
import { TEST_CHAIN_KEY } from "../complaints/testing";
import type { NewOf } from "../connector/codec";
import type { MemoryConnector } from "../connector/memory/connector";
import type { Key } from "../connector/store";
import { SIM_NOW, TEST_NOW, complaint as complaintRow, conversation, message, testConnector, worldMeta, worldSettings } from "../connector/testing";
import type { Complaint } from "../domain/complaint";
import type { Message } from "../domain/conversation";
import { type Logger, createLogger } from "../lib/log";
import type { RerouteRequest } from "../outbound/reroute";
import type { GateOutcome, OperatorReroute, OutboundGate, OutboundRequest } from "../outbound/types";
import type { TurnReads } from "../turns/preload";
import type { G1Prefilter, G1Verdict } from "../turns/prefilter";
import { createEnqueuer } from "./enqueue";
import type { CustomerEventInput } from "./events";
import type { EventHandlers, MoneyExecution, MoneyQuote, ReconcileOutcome, WorkerDeps } from "./ports";
import { type SqsRecordLike } from "./worker";

export { SIM_NOW, TEST_NOW };
export const CUSTOMER = "cus-0001";
/** A test key of `SessionKey`; never a stage secret. */
export const TEST_SESSION_KEY = "test-session-key-0123456789abcdef0123456789abcdef";
export const QUEUE_ARNS = {
  CustomerEvents: "arn:aws:sqs:us-east-1:000000000000:reclamo-poc-CustomerEvents.fifo",
  SignupCustomerEvents: "arn:aws:sqs:us-east-1:000000000000:reclamo-poc-SignupCustomerEvents.fifo",
  QaCustomerEvents: "arn:aws:sqs:us-east-1:000000000000:reclamo-poc-QaCustomerEvents.fifo",
} as const;

export interface RecordedGate {
  readonly requests: OutboundRequest[];
  readonly gate: OutboundGate;
  answer: (request: OutboundRequest) => GateOutcome;
  /** Every reroute the worker asked for, answered `REROUTED`. */
  readonly reroutes: RerouteRequest[];
  readonly reroute: OperatorReroute;
}

/** A gate that records every request and answers `ALLOWED` (or what `answer` says). */
export function recordedGate(): RecordedGate {
  const requests: OutboundRequest[] = [];
  const reroutes: RerouteRequest[] = [];
  const recorded: RecordedGate = {
    requests,
    answer: (request) => ({ ok: true, decision: "ALLOWED", messageId: request.messageId ?? `msg-out-${requests.length}`, ruleIds: [] }),
    gate: async (request) => {
      requests.push(request);
      return recorded.answer(request);
    },
    reroutes,
    reroute: async (input) => {
      reroutes.push(input);
      return { ok: true, decision: "REROUTED", reroutedTo: input.route, messageId: input.messageId ?? `msg-rr-${reroutes.length}`, ruleIds: [] };
    },
  };
  return recorded;
}

export type HarnessScript = (request: HarnessTurnRequest, call: number) => Promise<HarnessTurnResult> | HarnessTurnResult;

export interface ScriptedHarness extends HarnessClient {
  readonly requests: HarnessTurnRequest[];
  script: HarnessScript;
}

export function completed(overrides: Partial<HarnessTurnResult> = {}): HarnessTurnResult {
  return { outcome: "COMPLETED", stopReason: "end_turn", note: "Respondí al cliente.", usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, toolUses: 1, attempts: 1, ...overrides };
}

export function scriptedHarness(script: HarnessScript = () => completed()): ScriptedHarness {
  const requests: HarnessTurnRequest[] = [];
  const harness: ScriptedHarness = {
    requests,
    script,
    async invoke(request) {
      requests.push(request);
      return harness.script(request, requests.length);
    },
  };
  return harness;
}

/** The turn id inside the envelope's `<session token="<world>.<session>.<turn>.<exp>.<mac>"/>`. */
export function turnIdOf(request: Pick<HarnessTurnRequest, "envelope">): string {
  const token = /<session token="([^"]+)"\/>/.exec(request.envelope)?.[1];
  const turnId = token?.split(".")[2];
  if (turnId === undefined) throw new Error("the envelope carries no session token");
  return turnId;
}

export interface ScriptedG1 extends G1Prefilter {
  readonly texts: string[];
  verdict: (text: string) => G1Verdict;
}

export function scriptedG1(verdict: (text: string) => G1Verdict = () => ({ action: "NONE" })): ScriptedG1 {
  const texts: string[] = [];
  const g1: ScriptedG1 = {
    texts,
    verdict,
    async check(text) {
      texts.push(text);
      return g1.verdict(text);
    },
  };
  return g1;
}

export interface RecordedHandlers extends EventHandlers {
  readonly calls: { readonly name: string; readonly args: unknown }[];
  reconcileOutcome: ReconcileOutcome;
  quote: MoneyQuote | undefined;
  execution: MoneyExecution;
}

/** The deterministic handlers of the other modules, recording what the worker asks of them. */
export function recordedHandlers(): RecordedHandlers {
  const calls: { name: string; args: unknown }[] = [];
  const handlers: RecordedHandlers = {
    calls,
    reconcileOutcome: { result: "PENDING_BATCH" },
    quote: undefined,
    execution: { status: "EXECUTED", actionId: "act-0001" },
    fireTimer: async (event) => void calls.push({ name: "fireTimer", args: event }),
    reconcile: async (request) => {
      calls.push({ name: "reconcile", args: request });
      return handlers.reconcileOutcome;
    },
    writtenAnswer: async (request) => void calls.push({ name: "writtenAnswer", args: request }),
    confirmAction: async (request) => void calls.push({ name: "confirmAction", args: { kind: request.action.kind, actionId: request.action.actionId } }),
    money: {
      quote: async (approval) => {
        calls.push({ name: "money.quote", args: approval.approvalId });
        return handlers.quote ?? { action: approval.action, amountCents: approval.amountCents };
      },
      execute: async (approval, _complaint, ctx) => {
        calls.push({ name: "money.execute", args: { approvalId: approval.approvalId, idempotencyKey: ctx.idempotencyKey } });
        return handlers.execution;
      },
    },
    emailEffects: () => ({
      appendDeliveryProof: async (input) => void calls.push({ name: "appendDeliveryProof", args: input }),
      handOffUndeliverable: async (input) => void calls.push({ name: "handOffUndeliverable", args: input }),
      suppressEmail: async (input) => void calls.push({ name: "suppressEmail", args: input }),
      scheduleRetry: async (input) => void calls.push({ name: "scheduleRetry", args: input }),
    }),
    healthProbe: async (event) => {
      calls.push({ name: "healthProbe", args: event.payload.probeId });
      return { core: "ok", networks: "ok" };
    },
  };
  return handlers;
}

export interface WorkerKit {
  readonly worldId: string;
  readonly connector: MemoryConnector["connector"];
  readonly deps: WorkerDeps;
  readonly complaints: ComplaintsDeps;
  readonly gate: RecordedGate;
  readonly harness: ScriptedHarness;
  readonly g1: ScriptedG1;
  readonly handlers: RecordedHandlers;
  /** Every `SendMessage` the producer made. */
  readonly sent: SendMessageCommandInput[];
  readonly released: string[];
  /** Every JSON log line written during the test. */
  readonly lines: Record<string, unknown>[];
  /** Moves the real clock (caps' windows, identification). */
  advanceReal(ms: number): void;
  addComplaint(overrides?: Partial<NewOf<typeof Complaint>>): Promise<Complaint>;
  addInbound(messageId: string, body: string, overrides?: Partial<NewOf<typeof Message>>): Promise<void>;
  /** The `count` of a `Runtime` cap counter (0 when it does not exist). */
  counter(key: Key): Promise<number>;
  /** What the worker audited with `action`, in the world's current epoch. */
  audited(action: string): Promise<Awaited<ReturnType<MemoryConnector["connector"]["audit"]["listByAction"]>>>;
}

export interface KitOptions {
  readonly worldId?: string;
  readonly reads?: TurnReads;
  readonly memory?: MemoryRetriever;
}

/** A world `READY` at epoch 1 with the customer's conversation, and a worker over it. */
export async function workerKit(options: KitOptions = {}): Promise<WorkerKit> {
  const worldId = options.worldId ?? "demo";
  let realMs = TEST_NOW.getTime();
  const now = () => new Date(realMs);
  const { connector, store } = testConnector({ now });
  await connector.worlds.register(worldMeta(worldId, { status: "READY" }));
  await connector.transact([connector.counters.initEpochOp(worldId, 1)]);
  await connector.worlds.putSettings(worldSettings(worldId));
  await connector.conversations.create(conversation(worldId, { customerId: CUSTOMER }));
  const lines: Record<string, unknown>[] = [];
  const loggerFor = (correlationId: string): Logger => createLogger({ correlationId, level: "debug", now, sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const log = loggerFor("test-worker-kit");
  let ids = 0;
  const complaints: ComplaintsDeps = {
    connector,
    chainKey: TEST_CHAIN_KEY,
    anchors: { request: async () => undefined },
    log,
    realNow: now,
    newId: (prefix) => `${prefix}-${String(++ids).padStart(4, "0")}`,
    retry: { sleep: async () => undefined, random: () => 0 },
  };
  const gate = recordedGate();
  const harness = scriptedHarness();
  const g1 = scriptedG1();
  const handlers = recordedHandlers();
  const sent: SendMessageCommandInput[] = [];
  const released: string[] = [];
  const enqueuer = createEnqueuer({
    data: connector,
    send: async (input) => void sent.push(input),
    queueUrl: (queue) => `https://sqs.us-east-1.amazonaws.com/000000000000/reclamo-poc-${queue}${queue === "ScanDeadlines" ? "" : ".fifo"}`,
    now,
    log,
    sleep: async () => undefined,
  });
  let counter = 0;
  const random = (size: number): Uint8Array => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 31 + index * 7) % 256);
  };
  const deps: WorkerDeps = {
    data: connector,
    complaints,
    gate: gate.gate,
    reroute: gate.reroute,
    turn: { harness, prefilter: g1, memory: options.memory ?? NO_MEMORY, ...(options.reads === undefined ? {} : { reads: options.reads }), sessionKey: () => TEST_SESSION_KEY, agentMode: "SCRIPTED", random },
    handlers,
    enqueuer,
    queue: { releaseNow: async (receiptHandle) => void released.push(receiptHandle) },
    now,
    loggerFor,
  };
  let complaintCount = 0;
  return {
    worldId,
    connector,
    deps,
    complaints,
    gate,
    harness,
    g1,
    handlers,
    sent,
    released,
    lines,
    advanceReal(ms) {
      realMs += ms;
    },
    async addComplaint(overrides = {}) {
      complaintCount += 1;
      const value = complaintRow(worldId, { complaintId: `cmp-${String(complaintCount).padStart(4, "0")}`, complaintNumber: `R-2026-${String(complaintCount).padStart(6, "0")}`, customerId: CUSTOMER, ...overrides });
      await connector.write(connector.complaints.createOp(value));
      const stored = await connector.complaints.get(worldId, value.complaintId, { consistent: true });
      if (stored === undefined) throw new Error("complaint not stored");
      return stored;
    },
    async addInbound(messageId, body, overrides = {}) {
      await connector.conversations.putMessage(message(worldId, { messageId, customerId: CUSTOMER, body, ...overrides }));
    },
    async counter(key) {
      const item = await store.get("Runtime", key, { consistent: true });
      return typeof item?.["count"] === "number" ? item["count"] : 0;
    },
    async audited(action) {
      return connector.audit.listByAction(worldId, action);
    },
  };
}

/** An event of the kit's customer, epoch 1, at the story's simulated "now". */
export function eventOf<T extends CustomerEventInput["type"]>(type: T, payload: Extract<CustomerEventInput, { type: T }>["payload"], overrides: { worldId?: string; eventId?: string; customerId?: string; epoch?: number; eventAtSim?: string } = {}): Extract<CustomerEventInput, { type: T }> {
  return {
    type,
    eventId: overrides.eventId ?? `evt-${type.toLowerCase().replace(/_/g, "-")}`,
    worldId: overrides.worldId ?? "demo",
    customerId: overrides.customerId ?? CUSTOMER,
    epoch: overrides.epoch ?? 1,
    eventAtSim: overrides.eventAtSim ?? SIM_NOW,
    correlationId: "corr-test-0001",
    payload,
  } as Extract<CustomerEventInput, { type: T }>;
}

/** The SQS record of an event, as the event source mapping delivers it. */
export function recordOf(event: unknown, options: { receiveCount?: number; queue?: keyof typeof QUEUE_ARNS } = {}): SqsRecordLike {
  return {
    body: typeof event === "string" ? event : JSON.stringify(event),
    receiptHandle: "rh-test-0001",
    eventSourceARN: QUEUE_ARNS[options.queue ?? "CustomerEvents"],
    attributes: { ApproximateReceiveCount: String(options.receiveCount ?? 1) },
  };
}

/** The model "sent" a reply in this turn: the `Message OUT` the gate would have stored. */
export async function replyInTurn(kit: Pick<WorkerKit, "connector" | "worldId">, turnId: string, messageId = `m-reply-${turnId}`): Promise<void> {
  await kit.connector.conversations.putMessage(message(kit.worldId, { messageId, customerId: CUSTOMER, direction: "OUT", body: "Respuesta del asistente", status: "SENT", kind: "REPLY", turnId, sender: "AGENT" }));
}

/** Log lines with this message. */
export function linesNamed(lines: readonly Record<string, unknown>[], name: string): Record<string, unknown>[] {
  return lines.filter((line) => line.message === name);
}
