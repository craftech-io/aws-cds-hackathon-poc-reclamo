// The back half of the local UI server (docs/test-plan.md §2-§3, level UI): one in-process world of the
// seed (flows/support/world.ts, on the machine's clock) behind the `Bff` handler as the stage composes it
// — the edge guard on every route, the public procedures under `/api/public/*`, the real `appRouter`
// with its services bound to the world — plus the S3 emulator under `/s3/` and a few switches only a
// spec can use under `/__e2e/`. It adds what the Router adds in `poc` (`x-reclamo-edge` from the edge
// key, `x-reclamo-viewer-ip`) after dropping any `x-reclamo-*` the browser sent. Id tokens are checked
// by the BFF's real verifier against the run's JWKS this entry pins, never a pool's.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context as LambdaContext } from "aws-lambda";
import type { Jwks } from "aws-jwt-verify/jwk";
import { z } from "zod";
import type { Logger } from "@reclamo/bff/lib/log";
import { EDGE_HEADER, VIEWER_IP_HEADER, type EdgeHandler, withEdgeGuard } from "@reclamo/bff/routers/edge-guard";
import { createHandler } from "@reclamo/bff/routers/handler";
import { appRouter } from "@reclamo/bff/routers/index";
import { createPublicHandler, routeRequest } from "@reclamo/bff/routers/public-handler";
import type { PublicServices } from "@reclamo/bff/routers/signup";
import { createContextFactory } from "@reclamo/bff/routers/trpc";
import { LOCAL_KEYS } from "../flows/support/keys";
import type { PlannedCall, TurnPlan } from "../flows/support/scripted-harness";
import type { SeedWorldInput } from "../flows/support/seed-world";
import { type FlowWorld, createFlowWorld } from "../flows/support/world";
import { functionUrlEvent, headersOf, readBody, writeResult } from "./lambda-bridge";
import { emulatorObjectUrl, emulatorUploadPresigner, handleS3 } from "./s3-emulator";

/**
 * The worlds a spec finds: the demo, a guest world, a second one for the isolation specs (nothing else
 * may change it: they read it quiet) and a third for the email viewer's formal notice.
 */
export const UI_WORLDS: readonly SeedWorldInput[] = [
  { worldId: "demo", template: "demo" },
  { worldId: "g03", template: "guest" },
  { worldId: "g04", template: "guest" },
  { worldId: "g05", template: "guest" },
];

/** Test-only: the viewer IP a spec wants the Router to report (specs side by side keep their own caps). */
export const E2E_VIEWER_HEADER = "x-e2e-viewer-ip";
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const LAMBDA_CONTEXT = { functionName: "ui-server", awsRequestId: "ui-server", getRemainingTimeInMillis: () => 20_000 } as unknown as LambdaContext;

export interface UiAppOptions {
  /** `http://127.0.0.1:<port>`: the page, the API and the emulator share it. */
  readonly origin: string;
  /** The Playwright run's public keys (`E2E_JWKS`), trusted besides the world's own. */
  readonly jwks?: Jwks;
  readonly worlds?: readonly SeedWorldInput[];
  /** `signup.*` and `password.*` over the world (the self-signup wiring of tests/ui-server/guest-signup.ts); closed otherwise. */
  readonly publicServices?: PublicServicesFactory;
}

/** What tests/ui-server/guest-signup.ts exports as `guestSignupServices`: the public services over the world. */
export type PublicServicesFactory = (world: FlowWorld) => (log: Logger) => PublicServices;

export interface UiApp {
  readonly world: FlowWorld;
  /** Answers `/api`, `/s3` and `/__e2e`; false for anything else (the caller hands it to Vite). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

const Plans = z.array(z.union([z.array(z.looseObject({ tool: z.string().min(1) })), z.looseObject({ calls: z.array(z.looseObject({ tool: z.string().min(1) })) })]));
const Scan = z.object({ key: z.string().min(1), verdict: z.enum(["NO_THREATS_FOUND", "THREATS_FOUND", "UNSUPPORTED", "ACCESS_DENIED", "FAILED"]) }).strict();

function json(response: ServerResponse, status: number, body: unknown): true {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  return true;
}

/** The public routes while no self-signup is wired: the fixed "not open" answer, never a 500. */
const signupClosed: EdgeHandler = async () => ({ statusCode: 503, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: "SIGNUP_UNAVAILABLE" }) });

/** What CloudFront's viewer-request function does: drop the client's `x-reclamo-*`, add its own. */
export function edgeHeaders(request: IncomingMessage): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(headersOf(request)).filter(([name]) => !name.startsWith("x-reclamo-") && name !== E2E_VIEWER_HEADER));
  const asked = request.headers[E2E_VIEWER_HEADER];
  const ip = typeof asked === "string" && IPV4.test(asked) ? asked : (request.socket.remoteAddress ?? "127.0.0.1").replace(/^::ffff:/, "");
  return { ...headers, [EDGE_HEADER]: LOCAL_KEYS.edgeOrigin, [VIEWER_IP_HEADER]: ip };
}

async function testRoute(request: IncomingMessage, response: ServerResponse, world: FlowWorld, path: string): Promise<boolean> {
  if (request.method !== "POST") return json(response, 405, { error: "METHOD" });
  const body = (await readBody(request)).toString("utf8");
  const parsed = body.length === 0 ? undefined : (JSON.parse(body) as unknown);
  if (path === "/__e2e/settle") return json(response, 200, { deliveries: await world.settle() });
  if (path === "/__e2e/plans") {
    world.harness.script(Plans.parse(parsed) as unknown as readonly (TurnPlan | readonly PlannedCall[])[]);
    return json(response, 200, { scripted: true });
  }
  if (path === "/__e2e/scan") {
    const scan = Scan.parse(parsed);
    return json(response, 200, await world.mediaScanned(scan.key, scan.verdict));
  }
  return json(response, 404, { error: "NOT_FOUND" });
}

export async function createUiApp(options: UiAppOptions): Promise<UiApp> {
  const world = await createFlowWorld({
    realNow: "machine",
    worlds: options.worlds ?? UI_WORLDS,
    plans: () => [],
    ...(options.jwks === undefined ? {} : { trustedJwks: options.jwks }),
    objectUrl: (bucket, key) => emulatorObjectUrl(options.origin, bucket, key),
    presignUpload: emulatorUploadPresigner(options.origin),
  });
  const consoleHandler = createHandler(appRouter, createContextFactory(() => world.localConsole.deps));
  const publicHandler = options.publicServices === undefined ? signupClosed : createPublicHandler({ services: options.publicServices(world) });
  const bff = withEdgeGuard(routeRequest(consoleHandler, publicHandler), { key: () => LOCAL_KEYS.edgeOrigin });
  return {
    world,
    async handle(request, response) {
      const path = new URL(request.url ?? "/", "http://ui-server.local").pathname;
      if (path === "/api" || path.startsWith("/api/")) {
        const event = functionUrlEvent(request, await readBody(request), edgeHeaders(request));
        writeResult(response, await bff(event, LAMBDA_CONTEXT));
        return true;
      }
      if (path.startsWith("/s3/")) {
        await handleS3(request, response, world.s3, world.realNow());
        return true;
      }
      if (path.startsWith("/__e2e/")) return testRoute(request, response, world, path);
      return false;
    },
  };
}
