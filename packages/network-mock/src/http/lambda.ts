// Function URL adapter (payload 2.0) of the network mock. Only an event with the shape of a Function
// URL request is served: anything else (a direct invocation with a made-up payload) answers 400
// without touching a table. The caller's role is the IAM authorizer's `userArn`; the app decides.
// Dependencies are resolved on the first request and kept for the container; if they cannot be
// resolved (a resource not linked), every request answers 503 and the next one tries again.
import { errorResponse } from "@reclamo/core-contract";
import { z } from "zod";
import { type NetworkLogSink, correlationIdOf, stdoutSink } from "../log";
import { type NetworkApp, type NetworkAppDeps, type NetworkResponse, createNetworkApp } from "./app";

export const FunctionUrlEvent = z.object({
  rawPath: z.string().startsWith("/"),
  rawQueryString: z.string().default(""),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  isBase64Encoded: z.boolean().default(false),
  requestContext: z.object({
    requestId: z.string().optional(),
    http: z.object({ method: z.string().min(1), path: z.string().optional() }),
    authorizer: z.object({ iam: z.object({ userArn: z.string().optional() }) }).optional(),
  }),
});
export type FunctionUrlEvent = z.input<typeof FunctionUrlEvent>;

export type FunctionUrlHandler = (event: unknown) => Promise<NetworkResponse>;

function contractError(code: "INVALID" | "UNAVAILABLE", message: string): NetworkResponse {
  const { statusCode, body } = errorResponse(code, message);
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

export function createFunctionUrlHandler(resolveDeps: () => NetworkAppDeps, options: { readonly log?: NetworkLogSink; readonly realNow?: () => Date } = {}): FunctionUrlHandler {
  const log = options.log ?? stdoutSink;
  const realNow = options.realNow ?? (() => new Date());
  let app: NetworkApp | undefined;

  return async (raw) => {
    const parsed = FunctionUrlEvent.safeParse(raw);
    if (!parsed.success) {
      log({ level: "warn", message: "not a Function URL event", correlationId: "none", status: 400, code: "INVALID", time: realNow().toISOString(), service: "network-mock" });
      return contractError("INVALID", "unexpected event shape");
    }
    const event = parsed.data;
    if (app === undefined) {
      try {
        app = createNetworkApp(resolveDeps());
      } catch (error) {
        const correlationId = correlationIdOf(undefined, event.requestContext.requestId);
        log({ level: "error", message: "dependencies unavailable", correlationId, status: 503, code: "UNAVAILABLE", errorName: error instanceof Error ? error.name : "unknown", time: realNow().toISOString(), service: "network-mock" });
        return contractError("UNAVAILABLE", "the networks are not configured");
      }
    }
    const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    return app.handle({
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: event.rawQueryString,
      headers: event.headers,
      ...(body === undefined ? {} : { body }),
      ...(event.requestContext.authorizer?.iam.userArn === undefined ? {} : { userArn: event.requestContext.authorizer.iam.userArn }),
      ...(event.requestContext.requestId === undefined ? {} : { requestId: event.requestContext.requestId }),
    });
  };
}
