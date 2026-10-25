// A Node request as the Function URL event the `Bff` Lambda receives (payload format 2.0), and the
// Lambda's structured result back onto the Node response. The UI server runs the same handler code as
// the stage (`/api` prefix stripping, the public routes, the headers it sets), so what the console
// gets locally is what it gets behind the Router.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/** A request body larger than this is refused before it is read (the Router's limit is far below). */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RangeError("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

let sequence = 0;

export function functionUrlEvent(request: IncomingMessage, body: Buffer, headers: Readonly<Record<string, string>>): APIGatewayProxyEventV2 {
  const url = new URL(request.url ?? "/", "http://ui-server.local");
  const method = request.method ?? "GET";
  sequence += 1;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: { ...headers },
    isBase64Encoded: body.length > 0,
    ...(body.length > 0 ? { body: body.toString("base64") } : {}),
    requestContext: {
      accountId: "anonymous",
      apiId: "ui-server",
      domainName: url.host,
      domainPrefix: "ui-server",
      http: { method, path: url.pathname, protocol: "HTTP/1.1", sourceIp: request.socket.remoteAddress ?? "127.0.0.1", userAgent: headers["user-agent"] ?? "" },
      requestId: `ui-server-${sequence.toString().padStart(8, "0")}`,
      routeKey: "$default",
      stage: "$default",
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
    },
  };
}

/** The request's headers, lower-cased and joined, as a Function URL delivers them. */
export function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return headers;
}

export function writeResult(response: ServerResponse, result: APIGatewayProxyStructuredResultV2): void {
  const headers = Object.fromEntries(Object.entries(result.headers ?? {}).map(([name, value]) => [name, String(value)]));
  response.writeHead(result.statusCode ?? 200, headers);
  if (result.body === undefined) {
    response.end();
    return;
  }
  response.end(result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body);
}
