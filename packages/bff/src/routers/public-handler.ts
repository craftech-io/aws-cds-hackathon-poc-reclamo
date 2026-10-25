// How the Bff Lambda routes a request (docs/architecture-guests.md §4):
//
//   every route        the edge header first (routers/edge-guard.ts): without it, 403 EDGE_REQUIRED
//   /api/public/<p>    the public procedures, one per request: a `batch` query or two procedures
//                      in the path → 400, before tRPC; `allowBatching: false` in the adapter too
//   /api/<p>           the console's root router; a path that names a public procedure (alone or
//                      hidden in a batch) → 404 without running anything
//
// The public answers are `no-store`, except `signup.availability` (a GET every landing visit makes),
// which the edge may cache for a minute.
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { API_PREFIX } from "./api-prefix";
import { type EdgeHandler, viewerIpOf } from "./edge-guard";
import { describeError } from "../auth/errors";
import { type Logger, correlationIdFrom, createLogger } from "../lib/log";
import { PUBLIC_PROCEDURES, type PublicContext, type PublicServices, publicRouter } from "./signup";

/** The public prefix under `API_PREFIX`. */
export const PUBLIC_PREFIX = `${API_PREFIX}/public`;

const AVAILABILITY = "signup.availability";
// A request without the Router's header never gets here; this only covers the local servers.
const LOCAL_VIEWER_IP = "127.0.0.1";

function json(statusCode: number, error: string): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error }) };
}

/** Procedure names in an `/api/…` path (tRPC joins a batch with commas). */
function proceduresOf(path: string, prefix: string): string[] {
  const rest = path === prefix || path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
  return decodeURIComponent(rest.replace(/^\//, ""))
    .split(",")
    .filter((name) => name.length > 0);
}

/** True when an `/api/*` path names a public procedure, or anything that looks like one. */
export function namesPublicProcedure(rawPath: string): boolean {
  const names = proceduresOf(rawPath, API_PREFIX);
  return names.some((name) => PUBLIC_PROCEDURES.includes(name) || name.startsWith("signup.") || name.startsWith("password."));
}

export interface PublicHandlerOptions {
  readonly services: (log: Logger) => PublicServices;
}

export function createPublicHandler(options: PublicHandlerOptions): EdgeHandler {
  const trpc = awsLambdaRequestHandler({
    router: publicRouter,
    allowBatching: false,
    createContext: ({ event }): PublicContext => {
      const correlationId = correlationIdFrom(event.requestContext.requestId);
      const log = createLogger({ correlationId, bindings: { service: "bff-public" } });
      return { correlationId, log, viewerIp: viewerIpOf(event.headers) ?? LOCAL_VIEWER_IP, services: () => options.services(log) };
    },
    responseMeta: ({ paths, errors, type }) => {
      const cacheable = type === "query" && errors.length === 0 && paths?.length === 1 && paths[0] === AVAILABILITY;
      return { headers: { "cache-control": cacheable ? "public, max-age=60" : "no-store" } };
    },
    onError({ error, path }) {
      if (["BAD_REQUEST", "NOT_FOUND", "METHOD_NOT_SUPPORTED"].includes(error.code)) return;
      createLogger({ bindings: { service: "bff-public" } }).error("public.procedure.failed", { path: path ?? "unknown", code: error.code, ...describeError(error.cause ?? error) });
    },
  });

  return async (event, context) => {
    const names = proceduresOf(event.rawPath, PUBLIC_PREFIX);
    if (names.length !== 1 || /(^|&)batch=/.test(event.rawQueryString ?? "")) return json(400, "ONE_PROCEDURE_PER_REQUEST");
    if (!PUBLIC_PROCEDURES.includes(names[0] ?? "")) return json(404, "NOT_FOUND");
    const stripped = `/${names[0]}`;
    const inner: APIGatewayProxyEventV2 = { ...event, rawPath: stripped, requestContext: { ...event.requestContext, http: { ...event.requestContext.http, path: stripped } } };
    const method = inner.requestContext.http.method.toUpperCase();
    const { body: _body, ...withoutBody } = inner;
    return trpc(method === "GET" || method === "HEAD" ? withoutBody : inner, context);
  };
}

/** The Lambda's router: public procedures, the console, and nothing in between. */
export function routeRequest(console: EdgeHandler, publicHandler: EdgeHandler): EdgeHandler {
  return (event, context) => {
    const path = event.rawPath;
    if (path === PUBLIC_PREFIX || path.startsWith(`${PUBLIC_PREFIX}/`)) return publicHandler(event, context);
    if (namesPublicProcedure(path)) return Promise.resolve(json(404, "NOT_FOUND"));
    return console(event, context);
  };
}
