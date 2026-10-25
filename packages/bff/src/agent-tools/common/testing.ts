// Fixtures of the tool-wrapper tests: a world `qa-tools` in memory with customer `cus-0001` (and a
// second customer `cus-0002`), its conversation, complaints, evidence and messages built with the
// connector's own fixtures, turns opened the way the worker opens them (session + turn rows + signed
// token), a fake core that owns what the test says, and a logger whose lines the test can read.
import { type Caller, ok } from "@reclamo/shared";
import { SIM_NOW, TEST_NOW, complaint, conversation, evidence, message, testConnector, worldMeta } from "../../connector/testing";
import type { Connector } from "../../connector/port";
import type { Complaint } from "../../domain/complaint";
import type { Evidence } from "../../domain/case-items";
import { createLogger } from "../../lib/log";
import { issueSessionToken } from "../../services/session";
import { TOOL_DEFINITIONS } from "./catalog";
import type { ToolContext, ToolImplementation, ToolResponse } from "./context";
import { type GatewayTargetRuntime, type TargetTools, type ToolDeps, createToolHandler } from "./handler";
import type { CoreOwnership } from "./scope";
import { GATEWAY_TOOLS, type ToolTarget } from "./targets";

/** A test key; never a real one. */
export const TEST_SESSION_KEY = "test-session-key-0123456789abcdef0123456789abcdef";
export const WORLD = "qa-tools";
export const CUSTOMER = "cus-0001";
export const OTHER_CUSTOMER = "cus-0002";

type NewComplaint = Parameters<typeof complaint>[1];
type NewEvidence = Parameters<typeof evidence>[1];

export interface OpenedTurn {
  readonly token: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly triggerEventId: string;
}

export interface ToolWorld {
  readonly connector: Connector;
  readonly deps: ToolDeps;
  /** Every JSON log line written during the test. */
  readonly logs: string[];
  /** Ids the fake core says belong to `cus-0001`. */
  readonly owned: Set<string>;
  /** Moves the real clock (identification windows, token expiry). */
  advanceReal(ms: number): void;
  addComplaint(overrides?: NewComplaint): Promise<Complaint>;
  addEvidence(overrides?: NewEvidence): Promise<Evidence>;
  addInboundMessage(messageId: string, customerId?: string): Promise<void>;
  identify(untilMsFromNow?: number): Promise<void>;
  takeOver(): Promise<void>;
  openTurn(options?: { readonly complaintIds?: readonly string[]; readonly customerId?: string; readonly eventId?: string; readonly inboundMessageId?: string }): Promise<OpenedTurn>;
  closeTurn(turnId: string): Promise<void>;
  auditRows(): Promise<Awaited<ReturnType<Connector["audit"]["listMonth"]>>["entries"]>;
}

export async function toolWorld(): Promise<ToolWorld> {
  let realMs = TEST_NOW.getTime();
  // Stamps follow the real clock of the test: what the customer wrote orders after what was asked.
  const { connector } = testConnector({ now: () => new Date(realMs) });
  await connector.worlds.register(worldMeta(WORLD, { status: "READY" }));
  await connector.conversations.create(conversation(WORLD));
  await connector.conversations.create(conversation(WORLD, { customerId: OTHER_CUSTOMER }));
  const logs: string[] = [];
  const owned = new Set<string>();
  const ownership: CoreOwnership = { owns: async (_kind, ref) => ref.customerId === CUSTOMER && owned.has(ref.id) };
  const deps: ToolDeps = {
    connector,
    sessionKey: () => TEST_SESSION_KEY,
    wallClock: () => new Date(realMs),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => logs.push(line), now: () => new Date(realMs) }),
    ownership,
  };
  let turns = 0;
  let complaints = 0;
  return {
    connector,
    deps,
    logs,
    owned,
    advanceReal(ms) {
      realMs += ms;
    },
    async addComplaint(overrides = {}) {
      complaints += 1;
      const id = `cmp-${String(complaints).padStart(4, "0")}`;
      const value = complaint(WORLD, { complaintId: id, complaintNumber: `R-2026-${String(complaints).padStart(6, "0")}`, ...overrides });
      await connector.write(connector.complaints.createOp(value));
      return (await connector.complaints.get(WORLD, value.complaintId)) as Complaint;
    },
    async addEvidence(overrides = {}) {
      const value = evidence(WORLD, overrides);
      await connector.caseItems.putEvidence(value);
      return (await connector.caseItems.getEvidence(WORLD, value.complaintId, value.evidenceId)) as Evidence;
    },
    async addInboundMessage(messageId, customerId = CUSTOMER) {
      await connector.conversations.putMessage(message(WORLD, { messageId, customerId }));
    },
    async identify(untilMsFromNow = 30 * 60_000) {
      const meta = await connector.conversations.getMeta(WORLD, CUSTOMER);
      if (meta === undefined) throw new Error("no conversation");
      await connector.conversations.updateMeta(WORLD, CUSTOMER, meta.version, { identifiedUntilReal: new Date(realMs + untilMsFromNow).toISOString() });
    },
    async takeOver() {
      const meta = await connector.conversations.getMeta(WORLD, CUSTOMER);
      if (meta === undefined) throw new Error("no conversation");
      await connector.write(connector.conversations.setControlOp({ worldId: WORLD, customerId: CUSTOMER, version: meta.version, from: "AGENT", to: "OPERATOR", by: "OPERATOR:stf-operator", atSim: SIM_NOW, staffId: "stf-operator" }));
    },
    async openTurn(options = {}) {
      turns += 1;
      const id = `T${String(turns).padStart(8, "0")}`;
      const sessionId = `ses-${id}`;
      const turnId = `turn-${id}`;
      const triggerEventId = options.eventId ?? `evt-${id}`;
      await connector.sessions.putSession({
        worldId: WORLD,
        sessionId,
        customerId: options.customerId ?? CUSTOMER,
        complaintIds: [...(options.complaintIds ?? [])],
        identified: false,
        trigger: "CUSTOMER_MESSAGE",
        triggerEventId,
        ...(options.inboundMessageId === undefined ? {} : { inboundMessageId: options.inboundMessageId }),
        turnId,
        eventAtSim: SIM_NOW,
        createdAtReal: new Date(realMs).toISOString(),
      });
      await connector.sessions.openTurn({ worldId: WORLD, turnId, sessionId, openedAtReal: new Date(realMs).toISOString() });
      const token = issueSessionToken(TEST_SESSION_KEY, { worldId: WORLD, sessionId, turnId }, new Date(realMs));
      return { token, sessionId, turnId, triggerEventId };
    },
    async closeTurn(turnId) {
      await connector.sessions.closeTurn(WORLD, turnId);
    },
    async auditRows() {
      return (await connector.audit.listMonth(WORLD, 1, TEST_NOW.toISOString().slice(0, 7))).entries;
    },
  };
}

export interface Recording {
  readonly calls: ToolContext<unknown>[];
  readonly implementation: ToolImplementation<unknown>;
}

/** An implementation that records its context and answers `answer` (a small ok by default). */
export function recording(answer: (ctx: ToolContext<unknown>) => ToolResponse | Promise<ToolResponse> = (ctx) => ok({ tool: ctx.tool })): Recording {
  const calls: ToolContext<unknown>[] = [];
  return {
    calls,
    implementation: async (ctx) => {
      calls.push(ctx);
      return answer(ctx);
    },
  };
}

/**
 * A target built with `createToolHandler` over its real definitions, every tool answered by one
 * recording implementation unless `overrides` names it: what the 7 Lambda entries run.
 */
export function stubTarget(target: ToolTarget, deps: ToolDeps, overrides: Readonly<Record<string, ToolImplementation<unknown>>> = {}): { readonly runtime: GatewayTargetRuntime; readonly recorder: Recording } {
  const recorder = recording();
  const implementations = Object.fromEntries((GATEWAY_TOOLS[target] as readonly string[]).map((tool) => [tool, overrides[tool] ?? recorder.implementation]));
  const tools = TOOL_DEFINITIONS[target] as unknown as TargetTools<ToolTarget>;
  const runtime = createToolHandler({ target, tools, implementations: implementations as never }, deps);
  return { runtime, recorder };
}

/** A worker caller of the test world (preloaded reads). */
export function workerCaller(eventId = "evt-preload"): Caller {
  return { kind: "WORKER", worldId: WORLD, eventId };
}
