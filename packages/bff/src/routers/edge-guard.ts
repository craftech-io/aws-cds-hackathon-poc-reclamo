// The edge header (docs/architecture-guests.md §4): the Router's viewer-request function drops every
// `x-reclamo-*` header a client sends and adds `x-reclamo-edge` (the `EdgeOriginKey` value it reads
// from its key-value store) and `x-reclamo-viewer-ip` (the address CloudFront saw). The Bff compares
// the first in constant time before tRPC, on EVERY route: without it, 403 `EDGE_REQUIRED`. So the
// Function URL reached without CloudFront bypasses neither the WAF nor the rate rules, cannot drain
// the Bff's reserved concurrency, and the IP the caps count is CloudFront's, never a header a client
// made up.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context as LambdaContext } from "aws-lambda";
import { safeEqual } from "../lib/crypto";

export const EDGE_HEADER = "x-reclamo-edge";
export const VIEWER_IP_HEADER = "x-reclamo-viewer-ip";

/** The reason a request without the edge header is refused (also the audit action). */
export const EDGE_REQUIRED = "EDGE_REQUIRED";

type Headers = APIGatewayProxyEventV2["headers"] | undefined;

export function headerOf(headers: Headers, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

/** True when the request came through the Router with the current key. */
export function edgeVerified(headers: Headers, key: string): boolean {
  const presented = headerOf(headers, EDGE_HEADER);
  if (!presented || key.length === 0) return false;
  return safeEqual(presented, key);
}

/** The viewer IP the Router saw; only trusted after `edgeVerified`. */
export function viewerIpOf(headers: Headers): string | undefined {
  const value = headerOf(headers, VIEWER_IP_HEADER)?.trim();
  return value && /^[0-9a-f:.]{2,45}$/i.test(value) ? value : undefined;
}

export type EdgeHandler = (event: APIGatewayProxyEventV2, context: LambdaContext) => Promise<APIGatewayProxyStructuredResultV2>;

export interface EdgeGuardOptions {
  /** `EdgeOriginKey`; throws when it is not linked (the guard then refuses everything). */
  readonly key: () => string;
  /** Audit of a refusal (never awaited for the answer's sake: a failed audit changes nothing). */
  readonly onRefused?: (event: APIGatewayProxyEventV2) => Promise<void>;
  readonly onKeyUnavailable?: (error: unknown) => void;
}

const REFUSED: APIGatewayProxyStructuredResultV2 = {
  statusCode: 403,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify({ error: EDGE_REQUIRED }),
};

/** Wraps a handler: nothing reaches it without the edge header. */
export function withEdgeGuard(inner: EdgeHandler, options: EdgeGuardOptions): EdgeHandler {
  return async (event, context) => {
    let key = "";
    try {
      key = options.key();
    } catch (error) {
      options.onKeyUnavailable?.(error);
    }
    if (edgeVerified(event.headers, key)) return inner(event, context);
    await options.onRefused?.(event).catch(() => undefined);
    return REFUSED;
  };
}
