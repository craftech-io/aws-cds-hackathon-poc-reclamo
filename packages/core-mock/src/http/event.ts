// The Function URL event (payload format 2.0) → the request the core's app answers. Anything that
// does not have that shape (a direct invocation with a fabricated payload) is refused before the
// app runs: the core is reachable only through its `AWS_IAM` Function URL (docs/architecture.md §14),
// and the invoking role is read only from `requestContext.authorizer.iam.userArn`.
import { z } from "zod";

const FunctionUrlEvent = z.object({
  version: z.literal("2.0"),
  rawPath: z.string().startsWith("/"),
  rawQueryString: z.string().default(""),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  isBase64Encoded: z.boolean().default(false),
  requestContext: z.object({
    requestId: z.string().min(1),
    http: z.object({ method: z.string().min(1) }),
    authorizer: z.object({ iam: z.object({ userArn: z.string().min(1) }) }).optional(),
  }),
});

export interface CoreHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** Lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Session ARN of the invoking role, from the IAM authorizer of the Function URL. */
  readonly callerArn?: string;
  readonly requestId: string;
}

export interface CoreHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Largest body any route accepts; the contract's bodies are a few hundred bytes. */
export const MAX_BODY_BYTES = 16_384;

function parseQuery(raw: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(raw)) query[name] = value;
  return query;
}

/** The request of a Function URL event, or `undefined` when the event does not have that shape. */
export function toCoreRequest(raw: unknown): CoreHttpRequest | undefined {
  const parsed = FunctionUrlEvent.safeParse(raw);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  const headers = Object.fromEntries(Object.entries(event.headers).map(([name, value]) => [name.toLowerCase(), value]));
  const userArn = event.requestContext.authorizer?.iam.userArn;
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: parseQuery(event.rawQueryString),
    headers,
    ...(body === undefined ? {} : { body }),
    ...(userArn === undefined ? {} : { callerArn: userArn }),
    requestId: event.requestContext.requestId,
  };
}
