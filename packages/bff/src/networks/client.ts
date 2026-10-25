// The one client of the simulated networks (docs/architecture-integrations.md §6): every caller (the
// investigation and action tools, the worker, ScheduleDispatch, the QA driver) talks to `NetworkMock`
// through it.
//
//   - Requests and answers are validated with the contract's zod schemas (@reclamo/core-contract);
//     an answer outside the contract is `INVALID_RESPONSE`, never data.
//   - Every world route carries `X-Sim-Now` (the world's simulated instant the caller read from its
//     clock, ADR-0011) and `X-Correlation-Id` when the caller has one.
//   - Signed with SigV4 (core/signer.ts) for the Function URL with AWS_IAM.
//   - 5 s per attempt; 3 retries with exponential backoff and full jitter on 429, 502, 503, 504,
//     timeouts and network errors. Every operation is idempotent on the mock's side (a retried
//     collection or reversal answers its first answer; a publication or a transition is replayed),
//     so a retry never moves anything twice.
import {
  CORRELATION_HEADER,
  type CollectionNetwork,
  type CollectionRequest,
  type CollectionResult,
  CorrelationId,
  ErrorBody,
  type Health,
  type PublishResult,
  type RouteSpec,
  SIM_NOW_HEADER,
  type SettlementBatchList,
  SimInstant,
  type TransferReversalRequest,
  type TransferReversalResult,
  type TransferStatus,
  type TransitionRequest,
  fillPath,
  networksRoutes,
} from "@reclamo/core-contract";
import type { z } from "zod";
import { DeadlineError, withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { backoffDelayMs } from "../lib/retry";
import { NetworkClientError } from "./errors";
import type { RequestSigner } from "../core/signer";

export const NETWORK_CLIENT_DEFAULTS = { timeoutMs: 5_000, maxRetries: 3, baseDelayMs: 200, maxDelayMs: 2_000 } as const;

export type NetworkFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: "error" }) => Promise<Response>;

export interface NetworkClientDeps {
  /** Base URL of `NetworkMock` (its Function URL in the stage). */
  readonly endpoint: string;
  readonly sign: RequestSigner;
  readonly fetch?: NetworkFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** Who asks and when: the world, its simulated instant and the caller's correlation id. */
export interface WorldCall {
  readonly worldId: string;
  /** The world's simulated "now" (`clock.now()`), never the machine's. */
  readonly simNow: Date | string;
  readonly correlationId?: string;
}

export interface NetworkClient {
  registerCollection(call: WorldCall, collection: CollectionRequest): Promise<CollectionResult>;
  publishSettlement(call: WorldCall, network: CollectionNetwork, businessDate: string): Promise<PublishResult>;
  listSettlements(call: WorldCall, network: CollectionNetwork, range: { from: string; to: string }): Promise<SettlementBatchList>;
  getTransfer(call: WorldCall, transferId: string): Promise<TransferStatus>;
  requestTransferReversal(call: WorldCall, transferId: string, reversal: TransferReversalRequest): Promise<TransferReversalResult>;
  transitionTransfer(call: WorldCall, transferId: string, transition: TransitionRequest): Promise<TransferStatus>;
  health(): Promise<Health>;
}

type Operation = keyof typeof networksRoutes;
type Attempt = { readonly kind: "response"; readonly status: number; readonly text: string } | { readonly kind: "transport"; readonly reason: "TIMEOUT" | "NETWORK" };

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function simInstant(value: Date | string): string {
  return SimInstant.parse(value instanceof Date ? value.toISOString() : value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createNetworkClient(deps: NetworkClientDeps): NetworkClient {
  const settings = {
    timeoutMs: deps.timeoutMs ?? NETWORK_CLIENT_DEFAULTS.timeoutMs,
    maxRetries: deps.maxRetries ?? NETWORK_CLIENT_DEFAULTS.maxRetries,
    baseDelayMs: deps.baseDelayMs ?? NETWORK_CLIENT_DEFAULTS.baseDelayMs,
    maxDelayMs: deps.maxDelayMs ?? NETWORK_CLIENT_DEFAULTS.maxDelayMs,
  };
  const doFetch: NetworkFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger = deps.logger ?? createLogger({ bindings: { component: "network-client" } });

  async function attempt(operation: Operation, url: URL, headers: Record<string, string>, body: string | undefined): Promise<Attempt> {
    const route: RouteSpec = networksRoutes[operation];
    let signed: Record<string, string>;
    try {
      signed = await deps.sign({ method: route.method, url, headers, ...(body === undefined ? {} : { body }) });
    } catch (error) {
      throw new NetworkClientError("UNAVAILABLE", "could not sign the network request", { attempts: 0 }, { cause: error });
    }
    // The host header is the URL's own; fetch sets it and refuses to take it from the caller.
    const sendHeaders = Object.fromEntries(Object.entries(signed).filter(([name]) => name.toLowerCase() !== "host"));
    try {
      return await withDeadline(`networks.${operation}`, settings.timeoutMs, async (signal) => {
        const response = await doFetch(url.toString(), { method: route.method.toUpperCase(), headers: sendHeaders, ...(body === undefined ? {} : { body }), signal, redirect: "error" });
        return { kind: "response", status: response.status, text: await response.text() };
      });
    } catch (error) {
      return { kind: "transport", reason: error instanceof DeadlineError ? "TIMEOUT" : "NETWORK" };
    }
  }

  async function call<T>(operation: Operation, schema: z.ZodType<T>, request: { call?: WorldCall; params: Record<string, string>; query?: Record<string, string>; body?: unknown }): Promise<T> {
    const route: RouteSpec = networksRoutes[operation];
    const url = new URL(fillPath(route.path, request.params), deps.endpoint);
    for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
    const headers: Record<string, string> = { accept: "application/json" };
    if (request.call !== undefined) {
      headers[SIM_NOW_HEADER] = simInstant(request.call.simNow);
      if (request.call.correlationId !== undefined && CorrelationId.safeParse(request.call.correlationId).success) headers[CORRELATION_HEADER] = request.call.correlationId;
    }
    const body = request.body === undefined ? undefined : JSON.stringify(route.body?.parse(request.body) ?? request.body);
    if (body !== undefined) headers["content-type"] = "application/json";
    const log = logger.child({ operation, worldId: request.call?.worldId });

    let attempts = 0;
    let lastStatus: number | undefined;
    while (attempts <= settings.maxRetries) {
      const outcome = await attempt(operation, url, headers, body);
      attempts += 1;
      if (outcome.kind === "response" && outcome.status === 200) {
        const parsed = schema.safeParse(parseJson(outcome.text));
        if (parsed.success) return parsed.data;
        log.error("network answered outside its contract", { metric: "NetworkErrors", attempts, reason: "INVALID_RESPONSE" });
        throw new NetworkClientError("INVALID_RESPONSE", "the network answered outside its contract", { attempts, status: 200 }, { cause: parsed.error });
      }
      if (outcome.kind === "response" && !RETRYABLE_STATUS.has(outcome.status)) {
        const error = ErrorBody.safeParse(parseJson(outcome.text));
        const code = error.success ? error.data.code : "INVALID_RESPONSE";
        log.warn("network refused", { attempts, status: outcome.status, code });
        throw new NetworkClientError(code, error.success ? error.data.message : `the network answered HTTP ${outcome.status}`, {
          attempts,
          status: outcome.status,
          ...(error.success && error.data.actionId !== undefined ? { actionId: error.data.actionId } : {}),
        });
      }
      lastStatus = outcome.kind === "response" ? outcome.status : undefined;
      log.warn("network attempt failed", { attempt: attempts, status: lastStatus, reason: outcome.kind === "transport" ? outcome.reason : `HTTP_${outcome.status}` });
      if (attempts > settings.maxRetries) break;
      await sleep(backoffDelayMs(attempts - 1, { baseDelayMs: settings.baseDelayMs, maxDelayMs: settings.maxDelayMs, ...(deps.random === undefined ? {} : { random: deps.random }) }));
    }
    log.error("network unavailable", { metric: "NetworkErrors", attempts, status: lastStatus });
    throw new NetworkClientError("UNAVAILABLE", "the network did not answer after retries", { attempts, ...(lastStatus === undefined ? {} : { status: lastStatus }) });
  }

  // Every method is async so that an input outside the contract rejects (zod) before anything is sent.
  const routes = networksRoutes;
  const world = (worldCall: WorldCall, extra: Record<string, string> = {}) => ({ worldId: worldCall.worldId, ...extra });
  return {
    registerCollection: async (worldCall, collection) =>
      call("registerCollection", routes.registerCollection.ok, { call: worldCall, params: routes.registerCollection.params.parse(world(worldCall)), body: collection }),
    publishSettlement: async (worldCall, network, businessDate) =>
      call("publishSettlement", routes.publishSettlement.ok, { call: worldCall, params: routes.publishSettlement.params.parse(world(worldCall, { network, businessDate })) }),
    listSettlements: async (worldCall, network, range) =>
      call("listSettlements", routes.listSettlements.ok, { call: worldCall, params: routes.listSettlements.params.parse(world(worldCall, { network })), query: routes.listSettlements.query.parse(range) }),
    getTransfer: async (worldCall, transferId) => call("getTransfer", routes.getTransfer.ok, { call: worldCall, params: routes.getTransfer.params.parse(world(worldCall, { transferId })) }),
    requestTransferReversal: async (worldCall, transferId, reversal) =>
      call("requestTransferReversal", routes.requestTransferReversal.ok, { call: worldCall, params: routes.requestTransferReversal.params.parse(world(worldCall, { transferId })), body: reversal }),
    transitionTransfer: async (worldCall, transferId, transition) =>
      call("transitionTransfer", routes.transitionTransfer.ok, { call: worldCall, params: routes.transitionTransfer.params.parse(world(worldCall, { transferId })), body: transition }),
    health: async () => call("getNetworksHealth", routes.getNetworksHealth.ok, { params: {} }),
  };
}
