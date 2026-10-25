// The network mock as a transport-neutral app: one request in, one response out. Order of checks
// (each with the contract's error body, networks.openapi.yaml):
//
//   route → path params (400) → caller and world class (403) → health → X-Sim-Now (400)
//   → world exists (404 WORLD_NOT_FOUND) → `ERROR_503` fault (503) → query and body (400) → operation
//
// The caller is checked before the world's existence, so a role learns nothing about a world it may
// not reach. Every answer is parsed with the route's `ok` schema before it leaves.
import {
  CONTRACT_VERSION,
  CORRELATION_HEADER,
  type ContractErrorCode,
  type ErrorBody,
  type RouteSpec,
  WorldHeaders,
  errorResponse,
  findRoute,
  networksRoutes,
} from "@reclamo/core-contract";
import type { z } from "zod";
import { NetworkError, NetworkUnavailableError } from "../errors";
import { failsWith503 } from "../faults";
import { type NetworkLogLine, type NetworkLogSink, correlationIdOf, stdoutSink } from "../log";
import { createSettlements } from "../settlements";
import type { NetworkStore, SettlementObjects } from "../store/port";
import { createTransfers } from "../transfers";
import type { WorldContext } from "../world-context";
import { type CallerRoleArns, type NetworkOperation, authorizeCaller } from "./caller";

/** Largest JSON body the mock reads (its bodies are a few hundred bytes). */
export const MAX_BODY_BYTES = 16_384;

export interface NetworkRequest {
  readonly method: string;
  readonly path: string;
  /** Raw query string without `?`. */
  readonly query?: string;
  /** Header names in lower case, as Function URLs deliver them. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  /** `requestContext.authorizer.iam.userArn` of the Function URL; absent means nobody. */
  readonly userArn?: string;
  readonly requestId?: string;
}

export interface NetworkResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface NetworkAppDeps {
  readonly store: NetworkStore;
  readonly objects: SettlementObjects;
  /** Role ARNs linked into the mock (`MockCallers`). */
  readonly callers: CallerRoleArns;
  readonly log?: NetworkLogSink;
  /** Real time, only for the log lines. */
  readonly realNow?: () => Date;
}

function json(statusCode: number, payload: unknown): NetworkResponse {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(payload) };
}

function failure(code: ContractErrorCode, message: string, actionId?: string): NetworkResponse {
  const { statusCode, body }: { statusCode: number; body: ErrorBody } = errorResponse(code, message, actionId);
  return json(statusCode, body);
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new NetworkError("INVALID", `invalid ${what}`);
  return result.data;
}

function queryObject(query: string | undefined): Record<string, string> {
  const params = new URLSearchParams(query ?? "");
  const out: Record<string, string> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    if (values.length !== 1 || values[0] === undefined) throw new NetworkError("INVALID", "every query parameter goes once");
    out[name] = values[0];
  }
  return out;
}

function jsonBody(body: string | undefined): unknown {
  const text = body ?? "";
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new NetworkError("INVALID", "body too large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NetworkError("INVALID", "the body is not JSON");
  }
}

function lowerCaseHeaders(headers: NetworkRequest["headers"]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).flatMap(([name, value]) => (value === undefined ? [] : [[name.toLowerCase(), value]])));
}

export function createNetworkApp(deps: NetworkAppDeps) {
  const settlements = createSettlements(deps);
  const transfers = createTransfers(deps);
  const sink = deps.log ?? stdoutSink;
  const realNow = deps.realNow ?? (() => new Date());

  function log(line: NetworkLogLine): void {
    sink({ ...line, time: realNow().toISOString(), service: "network-mock" });
  }

  async function run(operation: NetworkOperation, context: WorldContext, params: Record<string, string>, request: NetworkRequest): Promise<unknown> {
    const body = () => jsonBody(request.body);
    const routes = networksRoutes;
    switch (operation) {
      case "registerCollection":
        return settlements.registerCollection(context, parsed(routes.registerCollection.body, body(), "body"));
      case "publishSettlement": {
        const { network, businessDate } = parsed(routes.publishSettlement.params, params, "path");
        return settlements.publishSettlement(context, network, businessDate);
      }
      case "listSettlements":
        return settlements.listSettlements(context, parsed(routes.listSettlements.params, params, "path").network, parsed(routes.listSettlements.query, queryObject(request.query), "query"));
      case "getTransfer":
        return transfers.getTransfer(context, parsed(routes.getTransfer.params, params, "path").transferId);
      case "requestTransferReversal":
        return transfers.requestTransferReversal(context, parsed(routes.requestTransferReversal.params, params, "path").transferId, parsed(routes.requestTransferReversal.body, body(), "body"));
      case "transitionTransfer":
        return transfers.transitionTransfer(context, parsed(routes.transitionTransfer.params, params, "path").transferId, parsed(routes.transitionTransfer.body, body(), "body"));
      case "getNetworksHealth":
        throw new NetworkError("NOT_FOUND", "health is not a world route");
    }
  }

  async function handle(request: NetworkRequest): Promise<NetworkResponse> {
    const headers = lowerCaseHeaders(request.headers);
    const correlationId = correlationIdOf(headers[CORRELATION_HEADER], request.requestId);
    const match = findRoute(networksRoutes, request.method, request.path);
    if (match === undefined) {
      log({ level: "warn", message: "no such route", correlationId, status: 404, code: "NOT_FOUND" });
      return failure("NOT_FOUND", "no such route");
    }
    const operation = match.operationId as NetworkOperation;
    const route: RouteSpec = match.route;
    const base = { correlationId, operation };
    try {
      const params = parsed(route.params, match.params, "path") as Record<string, string>;
      const worldId = params.worldId;
      const decision = authorizeCaller({ userArn: request.userArn, linked: deps.callers, operation, ...(worldId === undefined ? {} : { worldId }) });
      if (!decision.allowed) {
        const audit = decision.code === "CALLER_WORLD_DENIED" ? { audit: "CALLER_WORLD_DENIED" } : {};
        log({ level: "warn", message: "caller refused", ...base, worldId, role: decision.role, status: 403, code: decision.code, ...audit });
        return failure(decision.code, decision.code === "CALLER_WORLD_DENIED" ? "this caller may not reach this world" : "this caller may not use this route");
      }
      if (worldId === undefined) return json(200, route.ok.parse({ status: "ok", service: "networks", contractVersion: CONTRACT_VERSION }));

      const simNow = parsed(WorldHeaders, headers, "headers")["x-sim-now"];
      const world = await deps.store.getWorld(worldId);
      if (world === undefined) throw new NetworkError("WORLD_NOT_FOUND", "the world does not exist in the networks");
      const faults = await deps.store.getFaults(worldId);
      if (failsWith503(worldId, faults)) throw new NetworkError("UNAVAILABLE", "the network is not answering");

      const answer = route.ok.parse(await run(operation, { worldId, simNow, world, faults }, params, request));
      log({ level: "info", message: "ok", ...base, worldId, role: decision.role, status: 200 });
      return json(200, answer);
    } catch (error) {
      if (error instanceof NetworkError) {
        const response = failure(error.code, error.message, error.actionId);
        log({ level: response.statusCode >= 500 ? "error" : "warn", message: "refused", ...base, status: response.statusCode, code: error.code });
        return response;
      }
      const unavailable = error instanceof NetworkUnavailableError;
      log({ level: "error", message: unavailable ? "dependency unavailable" : "unexpected failure", ...base, status: 503, code: "UNAVAILABLE", errorName: error instanceof Error ? error.name : "unknown" });
      return failure("UNAVAILABLE", "temporarily unavailable, retry later");
    }
  }

  return { handle };
}

export type NetworkApp = ReturnType<typeof createNetworkApp>;
