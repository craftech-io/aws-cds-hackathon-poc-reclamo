// Lambda entry point of the console BFF (Function URL behind the Router, payload format 2.0).
// infra/bff.ts points at `packages/bff/src/routers/handler.handler`.
import type { AnyTRPCRouter } from "@trpc/server";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context as LambdaContext } from "aws-lambda";
import { API_PREFIX } from "./api-prefix";
import { EDGE_REQUIRED, withEdgeGuard } from "./edge-guard";
import { describeError } from "../auth/errors";
import { passwordService } from "../guests/password";
import { stageSignupDeps } from "../guests/runtime";
import { auditEdge } from "../guests/service-deps";
import { signupService } from "../guests/signup";
import { createLogger } from "../lib/log";
import { keySecret } from "../lib/secrets";
import { appRouter } from "./index";
import { createPublicHandler, routeRequest } from "./public-handler";
import { type Context, type CreateContextOptions, createContext } from "./trpc";

export { API_PREFIX };

// The adapter takes the procedure name from `rawPath`. Behind the Router it arrives as
// `/api/inbox.list`; called on the Function URL directly (smoke tests) it is `/inbox.list`.
export function stripApiPrefix(event: APIGatewayProxyEventV2): APIGatewayProxyEventV2 {
  const { rawPath } = event;
  if (rawPath !== API_PREFIX && !rawPath.startsWith(`${API_PREFIX}/`)) return event;
  const stripped = rawPath.slice(API_PREFIX.length) || "/";
  return { ...event, rawPath: stripped, requestContext: { ...event.requestContext, http: { ...event.requestContext.http, path: stripped } } };
}

// A GET or HEAD carries its input in the query string; a body on one would make the adapter throw
// (a 502 instead of an answer), so it is dropped before tRPC sees the request.
function withoutReadBody(event: APIGatewayProxyEventV2): APIGatewayProxyEventV2 {
  const method = event.requestContext.http.method.toUpperCase();
  if ((method !== "GET" && method !== "HEAD") || event.body === undefined) return event;
  const { body: _body, ...rest } = event;
  return rest;
}

// Failures that are the caller's doing are logged where they are refused (routers/trpc.ts).
const EXPECTED = new Set(["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND", "CONFLICT", "PRECONDITION_FAILED"]);

export type BffHandler = (event: APIGatewayProxyEventV2, context: LambdaContext) => Promise<APIGatewayProxyStructuredResultV2>;

export function createHandler(router: AnyTRPCRouter, contextOf: (options: CreateContextOptions) => Promise<Context>): BffHandler {
  const trpcHandler = awsLambdaRequestHandler<AnyTRPCRouter, APIGatewayProxyEventV2>({
    router,
    createContext: ({ event }) => contextOf({ event }),
    // Responses carry data of one world: neither CloudFront nor the browser may keep them. A call
    // that only started asynchronous work (`acceptedAsync`, e.g. `clock.reset`) answers 202.
    responseMeta: ({ ctx, errors }) => {
      const context: Context | undefined = ctx;
      const accepted = context?.response.accepted === true && errors.length === 0;
      return { headers: { "cache-control": "no-store" }, ...(accepted ? { status: 202 } : {}) };
    },
    onError({ error, path, ctx }) {
      if (EXPECTED.has(error.code)) return;
      // The input is never logged: it may carry names, contacts or free text of a customer.
      // Untyped for a generic router; it is whatever `contextOf` returned, or nothing if that failed.
      const context: Context | undefined = ctx;
      const log = context?.log ?? createLogger({ bindings: { service: "bff" } });
      log.error("console.procedure.failed", { path: path ?? "unknown", code: error.code, ...describeError(error.cause ?? error) });
    },
  });
  return (event, context) => trpcHandler(withoutReadBody(stripApiPrefix(event)), context);
}

const publicHandler = createPublicHandler({
  services: (log) => {
    const deps = stageSignupDeps(log);
    return { signup: signupService(deps), password: passwordService(deps) };
  },
});

/**
 * Lambda entry: the edge header on every route (routers/edge-guard.ts), then the public procedures under
 * `/api/public/*` or the console's root router (routers/public-handler.ts).
 */
export const handler: BffHandler = withEdgeGuard(routeRequest(createHandler(appRouter, createContext), publicHandler), {
  key: () => keySecret("EdgeOriginKey"),
  onKeyUnavailable: (error) => createLogger({ bindings: { service: "bff" } }).error("edge.key_unavailable", describeError(error)),
  onRefused: async () => {
    const log = createLogger({ bindings: { service: "bff" } });
    log.warn("edge.refused", { reason: EDGE_REQUIRED });
    await auditEdge(stageSignupDeps(log), { action: "EDGE_REQUIRED", outcome: EDGE_REQUIRED, refs: {} });
  },
});
