// The core as a plain request → response function over its ports (store, caller directory, email
// hash), so the Lambda handler, the unit tests and the local flows run the same code. For every
// request, in order (docs/architecture-integrations.md §5, docs/architecture.md §14):
//
//   1. the route of the contract (`coreRoutes`), else 404;
//   2. the invoking role from the IAM authorizer, and the operation open to that role (the live number
//      only to the functions that run the outbound gate), else 403 `CALLER_NOT_ALLOWED`;
//   3. path parameters, then the world against the role, else 403 `CALLER_WORLD_DENIED` (logged as
//      an audit line: the mock holds no table but `Core`);
//   4. `X-Sim-Now` (the world's simulated instant; the core never reads a clock), query and body
//      with the contract's zod schemas, else 400 `INVALID`;
//   5. the ledger; its answer is parsed with the contract before it leaves (never more than the
//      contract names), its refusals become the contract's error codes.
import {
  CONTRACT_VERSION,
  type ContractErrorCode,
  ErrorBody,
  SIM_NOW_HEADER,
  CORRELATION_HEADER,
  coreRoutes,
  errorResponse,
  findRoute,
  type RouteTable,
} from "@reclamo/core-contract";
import type { z } from "zod";
import { type CallerDirectory, type CoreCaller, authorizeOperation, authorizeWorld } from "./http/caller";
import { type CoreHttpRequest, type CoreHttpResponse, MAX_BODY_BYTES } from "./http/event";
import { type LedgerContext, LedgerError } from "./ledger/context";
import { CORE_HANDLERS } from "./routes";
import { CorruptItemError } from "./store/codec";
import type { CoreStore } from "./store/port";
import { StoreUnavailableError } from "./store/port";

/** Schemas the mock validates with; `npm run core:contract` compares the same ones with the YAML. */
export const CORE_MOCK_ROUTES = coreRoutes;

export type CoreOperation = keyof typeof coreRoutes;

/** One line per request for the handler's log: ids and outcomes only, never a body. */
export interface CoreEvent {
  readonly operation: CoreOperation | "unknown";
  readonly status: number;
  readonly code?: ContractErrorCode;
  readonly caller?: CoreCaller;
  readonly worldId?: string;
  readonly correlationId?: string;
  /** `true` on `CALLER_WORLD_DENIED`: the audit trail of a denied cross-world call. */
  readonly audit?: boolean;
  readonly detail?: string;
}

export interface CoreAppDeps {
  readonly store: CoreStore;
  readonly callers: CallerDirectory;
  readonly hashEmail?: (email: string) => string;
  readonly onEvent?: (event: CoreEvent) => void;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(statusCode: number, body: unknown): CoreHttpResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function failure(code: ContractErrorCode, message: string, actionId?: string): CoreHttpResponse {
  const { statusCode, body } = errorResponse(code, message.slice(0, 300), actionId);
  return json(statusCode, body);
}

function parseJson(body: string | undefined): unknown {
  if (body === undefined || body === "" || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function invalidField(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? "invalid request" : `invalid ${issue.path.join(".") || "request"}`;
}

export function createCoreApp(deps: CoreAppDeps): (request: CoreHttpRequest) => Promise<CoreHttpResponse> {
  const emit = deps.onEvent ?? (() => undefined);

  return async (request) => {
    const match = findRoute<RouteTable>(coreRoutes, request.method, request.path);
    const correlationId = request.headers[CORRELATION_HEADER];
    const base = { ...(correlationId === undefined ? {} : { correlationId: correlationId.slice(0, 128) }) };
    const done = (response: CoreHttpResponse, event: Omit<CoreEvent, "status">): CoreHttpResponse => {
      const code = response.statusCode === 200 ? undefined : ErrorBody.safeParse(JSON.parse(response.body)).data?.code;
      emit({ ...base, ...event, status: response.statusCode, ...(code === undefined ? {} : { code }) });
      return response;
    };
    if (match === undefined) return done(failure("NOT_FOUND", "unknown route"), { operation: "unknown" });
    const operation = match.operationId as CoreOperation;
    const route = match.route;

    const caller = deps.callers.resolve(request.callerArn);
    if (caller === undefined) return done(failure("CALLER_NOT_ALLOWED", "the invoking role may not call the core"), { operation });
    if (!authorizeOperation(caller, operation)) return done(failure("CALLER_NOT_ALLOWED", "the invoking role may not ask for this"), { operation, caller, audit: true });

    const params = route.params.safeParse(match.params);
    if (!params.success) return done(failure("INVALID", invalidField(params.error)), { operation, caller });
    if (operation === "getCoreHealth") return done(json(200, { status: "ok", service: "core", contractVersion: CONTRACT_VERSION }), { operation, caller });

    const worldId = (params.data as { worldId: string }).worldId;
    if (!authorizeWorld(caller, worldId).allowed) {
      return done(failure("CALLER_WORLD_DENIED", "the invoking role may not reach this world"), { operation, caller, worldId, audit: true });
    }

    const headers = route.headers?.safeParse(request.headers);
    if (headers !== undefined && !headers.success) return done(failure("INVALID", `missing or invalid ${SIM_NOW_HEADER}`), { operation, caller, worldId });
    const query = route.query?.safeParse(request.query);
    if (query !== undefined && !query.success) return done(failure("INVALID", invalidField(query.error)), { operation, caller, worldId });
    const body = route.body?.safeParse(parseJson(request.body));
    if (body !== undefined && !body.success) return done(failure("INVALID", invalidField(body.error)), { operation, caller, worldId });

    const ctx: LedgerContext = {
      store: deps.store,
      worldId,
      simNow: request.headers[SIM_NOW_HEADER] ?? "",
      ...(deps.hashEmail === undefined ? {} : { hashEmail: deps.hashEmail }),
    };
    try {
      const handler = CORE_HANDLERS[operation as Exclude<CoreOperation, "getCoreHealth">] as (ctx: LedgerContext, input: { params: unknown; query: unknown; body: unknown }) => Promise<unknown>;
      const result = await handler(ctx, { params: params.data, query: query?.data, body: body?.data });
      const output = route.ok.safeParse(result);
      if (!output.success) return done(failure("UNAVAILABLE", "the core could not answer within its contract"), { operation, caller, worldId, detail: "OUTPUT_OUTSIDE_CONTRACT" });
      return done(json(200, output.data), { operation, caller, worldId });
    } catch (error) {
      if (error instanceof LedgerError) return done(failure(error.code, error.message, error.actionId), { operation, caller, worldId });
      const detail = error instanceof CorruptItemError ? `CORRUPT_${error.entity}` : error instanceof StoreUnavailableError ? "STORE_UNAVAILABLE" : "INTERNAL";
      return done(failure("UNAVAILABLE", "the core is not available, try again"), { operation, caller, worldId, detail });
    }
  };
}
