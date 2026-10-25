// The one client of the lender core (`CoreMock`, docs/architecture-integrations.md §5): every tool,
// worker step and console procedure that reads or moves something in the core goes through it.
//
//   - Requests and answers are validated with the contract's zod schemas (@reclamo/core-contract):
//     a malformed call never leaves, and an answer outside the contract never reaches a tool.
//   - Every world route carries `X-Sim-Now` (the world's simulated instant, read by the caller from
//     its clock: the core never reads one, ADR-0011) and `X-Correlation-Id`.
//   - Signed with SigV4 for the Function URL (core/signer.ts).
//   - 5 s per attempt; 3 retries with exponential backoff and full jitter on 503 (and 429, 502,
//     504), timeouts and network errors. Retrying a money route is safe: the core replays the first
//     answer to the same idempotency key and never moves money twice.
//   - Exhausted retries or any refusal → `CoreError` with the contract's code (and the `actionId`
//     of a `CONFLICT`). Bodies are never logged.
import { CORRELATION_HEADER, CorrelationId, ErrorBody, type Health, SIM_NOW_HEADER, SimInstant, coreRoutes, fillPath, type ContractErrorCode } from "@reclamo/core-contract";
import type { z } from "zod";
import { DeadlineError, withDeadline } from "../lib/deadline";
import { createLogger, type Logger } from "../lib/log";
import { backoffDelayMs } from "../lib/retry";
import { CoreError } from "./errors";
import { type RequestSigner, sigV4Signer } from "./signer";

export const CORE_CLIENT_DEFAULTS = {
  timeoutMs: 5_000,
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
} as const;

type Routes = typeof coreRoutes;
export type CoreOperation = Exclude<keyof Routes, "getCoreHealth">;

type QueryInput<R> = R extends { query: infer Q extends z.ZodType } ? { readonly query: z.input<Q> } : { readonly query?: undefined };
type BodyInput<R> = R extends { body: infer B extends z.ZodType } ? { readonly body: z.input<B> } : { readonly body?: undefined };

/** What a call names: path parameters except the world (it comes from the context), query and body. */
export type CoreInput<O extends CoreOperation> = { readonly params: Omit<z.input<Routes[O]["params"]>, "worldId"> } & QueryInput<Routes[O]> & BodyInput<Routes[O]>;
export type CoreOutput<O extends CoreOperation> = z.infer<Routes[O]["ok"]>;

export interface CoreCallContext {
  readonly worldId: string;
  /** The world's simulated instant (`lib/clock.ts`), sent as `X-Sim-Now`. */
  readonly simNow: string;
  readonly correlationId?: string;
}

export interface WireRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

/** Sends one attempt and returns the status and raw body; throws on a transport failure. */
export type CoreTransport = (request: WireRequest) => Promise<{ readonly status: number; readonly text: string }>;

export interface CoreClientDeps {
  /** Base URL of the core (the Function URL of `CoreMock`). */
  readonly endpoint: string;
  /** Default: SigV4-signed `fetch`. Local flows pass an in-process transport. */
  readonly transport?: CoreTransport;
  readonly sign?: RequestSigner;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly logger?: Logger;
}

export interface CoreClient {
  call<O extends CoreOperation>(operation: O, ctx: CoreCallContext, input: CoreInput<O>): Promise<CoreOutput<O>>;
  health(correlationId?: string): Promise<Health>;
}

/** `fetch` with the request signed for the Function URL; redirects are errors. */
export function signedFetchTransport(sign: RequestSigner): CoreTransport {
  return async ({ method, url, headers, body, signal }) => {
    const signed = await sign({ method, url, headers, ...(body === undefined ? {} : { body }) });
    const response = await fetch(url, { method, headers: signed, signal, redirect: "error", ...(body === undefined ? {} : { body }) });
    return { status: response.status, text: await response.text() };
  };
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function codeOfStatus(status: number): ContractErrorCode {
  if (RETRYABLE_STATUS.has(status) || status >= 500) return "UNAVAILABLE";
  if (status === 404) return "NOT_FOUND";
  if (status === 403) return "FORBIDDEN";
  if (status === 409) return "CONFLICT";
  return "INVALID";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface RouteLike {
  readonly method: string;
  readonly path: string;
  readonly params: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly ok: z.ZodType;
}

export function createCoreClient(deps: CoreClientDeps): CoreClient {
  const settings = {
    timeoutMs: deps.timeoutMs ?? CORE_CLIENT_DEFAULTS.timeoutMs,
    maxRetries: deps.maxRetries ?? CORE_CLIENT_DEFAULTS.maxRetries,
    baseDelayMs: deps.baseDelayMs ?? CORE_CLIENT_DEFAULTS.baseDelayMs,
    maxDelayMs: deps.maxDelayMs ?? CORE_CLIENT_DEFAULTS.maxDelayMs,
  };
  const transport = deps.transport ?? signedFetchTransport(deps.sign ?? sigV4Signer());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger = deps.logger ?? createLogger({ bindings: { component: "core-client" } });

  function invalid(operation: string, error: z.ZodError | undefined, what: string): CoreError {
    const field = error?.issues[0]?.path.join(".");
    return new CoreError("INVALID", `core.${operation}: invalid ${field === undefined || field === "" ? what : field}`, { attempts: 0 });
  }

  async function send(operation: string, route: RouteLike, url: URL, headers: Record<string, string>, body: string | undefined, log: Logger): Promise<unknown> {
    let last: CoreError | undefined;
    for (let attempt = 1; attempt <= settings.maxRetries + 1; attempt += 1) {
      let outcome: { status: number; text: string } | { failure: "TIMEOUT" | "NETWORK" };
      let attemptSignal: AbortSignal | undefined;
      try {
        outcome = await withDeadline(`core.${operation}`, settings.timeoutMs, (signal) => {
          attemptSignal = signal;
          return transport({ method: route.method.toUpperCase(), url, headers, ...(body === undefined ? {} : { body }), signal });
        });
      } catch (error) {
        // An aborted fetch rejects with its own error, sometimes before the deadline's: the signal tells.
        const timedOut = error instanceof DeadlineError || attemptSignal?.reason instanceof DeadlineError;
        outcome = { failure: timedOut ? "TIMEOUT" : "NETWORK" };
      }
      if ("status" in outcome && outcome.status === 200) {
        const parsed = route.ok.safeParse(safeJson(outcome.text));
        if (parsed.success) return parsed.data;
        log.error("core answered outside its contract", { operation, attempt, metric: "CoreContractErrors" });
        throw new CoreError("UNAVAILABLE", `core.${operation}: answer outside the contract`, { status: 200, attempts: attempt });
      }
      if ("status" in outcome) {
        const error = ErrorBody.safeParse(safeJson(outcome.text));
        const code = error.success ? error.data.code : codeOfStatus(outcome.status);
        last = new CoreError(code, `core.${operation}: ${code}`, { status: outcome.status, attempts: attempt, ...(error.success && error.data.actionId !== undefined ? { actionId: error.data.actionId } : {}) });
        const retryable = RETRYABLE_STATUS.has(outcome.status);
        log.warn("core attempt failed", { operation, attempt, statusCode: outcome.status, code, retryable });
        if (!retryable) throw last;
      } else {
        last = new CoreError("UNAVAILABLE", `core.${operation}: ${outcome.failure}`, { attempts: attempt });
        log.warn("core attempt failed", { operation, attempt, reason: outcome.failure, retryable: true });
      }
      if (attempt <= settings.maxRetries) await sleep(backoffDelayMs(attempt - 1, { baseDelayMs: settings.baseDelayMs, maxDelayMs: settings.maxDelayMs, ...(deps.random === undefined ? {} : { random: deps.random }) }));
    }
    log.error("core unavailable after retries", { operation, attempts: settings.maxRetries + 1, metric: "CoreUnavailable" });
    throw last ?? new CoreError("UNAVAILABLE", `core.${operation}: unavailable`, { attempts: settings.maxRetries + 1 });
  }

  function baseHeaders(correlationId: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (correlationId !== undefined && CorrelationId.safeParse(correlationId).success) headers[CORRELATION_HEADER] = correlationId;
    return headers;
  }

  return {
    async call(operation, ctx, input) {
      const route = coreRoutes[operation] as unknown as RouteLike;
      const raw = input as { params: Record<string, unknown>; query?: unknown; body?: unknown };
      const params = route.params.safeParse({ ...raw.params, worldId: ctx.worldId });
      if (!params.success) throw invalid(operation, params.error, "path");
      if (!SimInstant.safeParse(ctx.simNow).success) throw invalid(operation, undefined, SIM_NOW_HEADER);
      const query = route.query?.safeParse(raw.query ?? {});
      if (query !== undefined && !query.success) throw invalid(operation, query.error, "query");
      const body = route.body?.safeParse(raw.body);
      if (body !== undefined && !body.success) throw invalid(operation, body.error, "body");

      const url = new URL(fillPath(route.path, params.data as Record<string, string>), deps.endpoint);
      for (const [name, value] of Object.entries((query?.data ?? {}) as Record<string, string | undefined>).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (value !== undefined) url.searchParams.set(name, value);
      }
      const headers: Record<string, string> = { ...baseHeaders(ctx.correlationId), [SIM_NOW_HEADER]: ctx.simNow };
      if (body !== undefined) headers["content-type"] = "application/json";
      const log = logger.child({ worldId: ctx.worldId });
      return (await send(operation, route, url, headers, body === undefined ? undefined : JSON.stringify(body.data), log)) as CoreOutput<typeof operation>;
    },

    async health(correlationId) {
      const route = coreRoutes.getCoreHealth as unknown as RouteLike;
      return (await send("getCoreHealth", route, new URL(route.path, deps.endpoint), baseHeaders(correlationId), undefined, logger)) as Health;
    },
  };
}
