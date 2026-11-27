// The access line of the Bff (docs/architecture.md §12): one JSON line per HTTP request, written when it
// ends, also when it is refused before tRPC (no edge header, an unknown route, a method it does not
// take, a cap) or when the handler throws. Field names follow this repository's English convention;
// the shared observability guide of the demos calls them `msg: "acceso"`, `ruta`, `metodo`, `estado`,
// `ip`, `agente`, `sub` and `ms`:
//
//   { "message": "access", "route", "method", "status", "ip", "agent", "sub"?, "ms" }
//
// Never a body, a query string, a token, an authorization header, an email or a phone: the route is the
// path only (the procedure names of a tRPC batch), and it and the agent are cut short and stripped of
// control characters; the logger's masker runs over every string as on any other line. `sub` is there
// only when `worldProcedure` already verified the id token of the request (`noteVerifiedSub`): nothing
// here decodes a token. The IP is the one the caps count (`x-reclamo-viewer-ip`, written by the Router's
// edge function), never the first value of `x-forwarded-for`.
import { AsyncLocalStorage } from "node:async_hooks";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { type Logger, correlationIdFrom, createLogger } from "./log";

export const ACCESS_MESSAGE = "access";
export const ROUTE_MAX = 120;
export const AGENT_MAX = 80;
const METHOD_MAX = 10;
const IP_MAX = 45;
const SUB_MAX = 64;

interface RequestInFlight {
  sub?: string;
}

const inFlight = new AsyncLocalStorage<RequestInFlight>();

/** The `sub` of the id token `worldProcedure` verified for the request in flight (outside one, nothing). */
export function noteVerifiedSub(sub: string | undefined): void {
  const request = inFlight.getStore();
  if (request && sub) request.sub = sub;
}

/** No control characters or line separators, and cut to `max`. */
export function clean(value: string | undefined, max: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, max);
}

function routeOf(event: APIGatewayProxyEventV2): string {
  const raw = (event.rawPath || event.requestContext?.http?.path || "/").split("?")[0] ?? "/";
  let route = raw;
  try {
    route = decodeURIComponent(raw);
  } catch {
    route = raw;
  }
  return clean(route, ROUTE_MAX);
}

function headerOf(event: APIGatewayProxyEventV2, name: string): string | undefined {
  return Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

export interface AccessLogOptions {
  /** The viewer's address, as the caps read it. */
  readonly ipOf: (event: APIGatewayProxyEventV2) => string | undefined;
  /** A logger per request (tests pass one with a sink). */
  readonly loggerFor?: (correlationId: string) => Pick<Logger, "info">;
  readonly elapsedMs?: () => number;
}

type Handler<A extends unknown[]> = (event: APIGatewayProxyEventV2, ...rest: A) => Promise<APIGatewayProxyStructuredResultV2>;

/** Wraps an HTTP handler without changing any answer: logs the access when it ends and rethrows errors. */
export function withAccessLog<A extends unknown[]>(handler: Handler<A>, options: AccessLogOptions): Handler<A> {
  const loggerFor = options.loggerFor ?? ((correlationId: string) => createLogger({ correlationId, bindings: { service: "bff" } }));
  const clock = options.elapsedMs ?? (() => performance.now());
  return (event, ...rest) => {
    const request: RequestInFlight = {};
    const started = clock();
    const write = (status: number) => {
      try {
        const correlationId = correlationIdFrom(headerOf(event, "x-correlation-id") ?? event.requestContext?.requestId);
        loggerFor(correlationId).info(ACCESS_MESSAGE, {
          route: routeOf(event),
          method: clean(event.requestContext?.http?.method, METHOD_MAX).toUpperCase(),
          status,
          ip: clean(options.ipOf(event), IP_MAX),
          agent: clean(headerOf(event, "user-agent"), AGENT_MAX),
          ...(request.sub ? { sub: clean(request.sub, SUB_MAX) } : {}),
          ms: Math.round(clock() - started),
        });
      } catch {
        // The access line never changes the answer.
      }
    };
    return inFlight.run(request, async () => {
      try {
        const response = await handler(event, ...rest);
        write(response.statusCode ?? 200);
        return response;
      } catch (error) {
        write(500);
        throw error;
      }
    });
  };
}
