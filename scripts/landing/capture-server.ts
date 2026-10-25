// The local server the landing's captures are taken on (docs/landing-spec.md §7, WP-44): the production
// build of the real console (console-build.ts) served as files, with every unknown path answered by its
// `index.html` as the Router does, and the back half on the same 127.0.0.1 origin as the local UI server (tests/ui-server/app.ts) — the edge guard, the real `appRouter` over the in-process world
// and the S3 emulator — but over a world the caller brings: the deterministic guest world the guided
// tour's replay drives (scripts/landing/capture-world.ts), with its real time fixed. That world was built
// for Node, so its object links read `local-s3://<bucket>/<key>`; on their way to the browser they become
// the emulator's `/s3/<bucket>/<key>`, the same address the UI server's worlds hand out. The public
// self-signup routes answer the fixed "not open" reply: no capture needs them. Nothing leaves the machine.
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { normalize } from "node:path";
import type { APIGatewayProxyStructuredResultV2, Context as LambdaContext } from "aws-lambda";
import { type EdgeHandler, withEdgeGuard } from "@reclamo/bff/routers/edge-guard";
import { createHandler } from "@reclamo/bff/routers/handler";
import { bindOperations, operationsOf } from "@reclamo/bff/routers/inbox";
import { appRouter } from "@reclamo/bff/routers/index";
import { routeRequest } from "@reclamo/bff/routers/public-handler";
import { createContextFactory } from "@reclamo/bff/routers/trpc";
import { LOCAL_KEYS } from "../../tests/flows/support/keys";
import type { FlowWorld } from "../../tests/flows/support/world";
import { edgeHeaders } from "../../tests/ui-server/app";
import { functionUrlEvent, readBody, writeResult } from "../../tests/ui-server/lambda-bridge";
import { emulatorObjectUrl, handleS3 } from "../../tests/ui-server/s3-emulator";
import { serveStatic } from "./static-files";

const LAMBDA_CONTEXT = { functionName: "landing-captures", awsRequestId: "landing-captures", getRemainingTimeInMillis: () => 20_000 } as unknown as LambdaContext;
const LOCAL_LINK = /local-s3:\/\/([A-Za-z][A-Za-z0-9-]*)\/([^"\\]*)/g;

const signupClosed: EdgeHandler = async () => ({ statusCode: 503, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: "SIGNUP_UNAVAILABLE" }) });

/** A body with every `local-s3://` link of the in-process world turned into the emulator's address. */
export function rewriteLocalLinks(body: string, origin: string): string {
  return body.replace(LOCAL_LINK, (_whole, bucket: string, key: string) => emulatorObjectUrl(origin, bucket, key));
}

/** The Lambda's result with its links rewritten, decoded first when it came base64-encoded. */
export function withEmulatorLinks(result: APIGatewayProxyStructuredResultV2, origin: string): APIGatewayProxyStructuredResultV2 {
  if (result.body === undefined) return result;
  const text = result.isBase64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
  if (!text.includes("local-s3://")) return result;
  return { ...result, isBase64Encoded: false, body: rewriteLocalLinks(text, origin) };
}

export interface CaptureServer {
  /** `http://127.0.0.1:<port>`: the console, its API and the emulator share it. */
  readonly origin: string;
  close(): Promise<void>;
}

/** Starts the server on a free port of 127.0.0.1 over `world`, serving the console built in `staticDir`. */
export async function startCaptureServer(world: FlowWorld, staticDir: string): Promise<CaptureServer> {
  const root = normalize(staticDir);
  // The operations services bound to the world's deps are bound again to these.
  const local = world.localConsole.deps;
  const deps = bindOperations(local, operationsOf(local));
  const consoleHandler = createHandler(appRouter, createContextFactory(() => deps));
  const bff = withEdgeGuard(routeRequest(consoleHandler, signupClosed), { key: () => LOCAL_KEYS.edgeOrigin });
  let origin = "";
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://capture.local").pathname;
    if (path === "/api" || path.startsWith("/api/")) {
      const event = functionUrlEvent(request, await readBody(request), edgeHeaders(request));
      writeResult(response, withEmulatorLinks(await bff(event, LAMBDA_CONTEXT), origin));
      return;
    }
    if (path.startsWith("/s3/")) {
      await handleS3(request, response, world.s3, world.realNow());
      return;
    }
    serveStatic(root, request, response);
  };
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // The method and the error's name only: never a path or a body.
      process.stderr.write(`capture-server: ${error instanceof Error ? error.name : "error"} on a ${request.method ?? "?"} request\n`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
