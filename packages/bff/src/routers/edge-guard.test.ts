// The edge header (docs/architecture-guests.md §4, FL-119): every route of the Bff answers only
// requests that came through the Router with the current key, compared in constant time; the viewer IP
// is taken only from the Router's header. Tested on the guard and on the Bff as the Lambda composes it
// (edge guard → public procedures or the console's root router).
import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { createMemoryAudit, createMemoryDirectory, createTestIssuer } from "../auth/testing";
import { passwordService } from "../guests/password";
import { signupService } from "../guests/signup";
import { createSignupHarness } from "../guests/testing/harness";
import * as crypto from "../lib/crypto";
import { createLogger } from "../lib/log";
import type { ContextDeps } from "./deps";
import { EDGE_REQUIRED, edgeVerified, viewerIpOf, withEdgeGuard } from "./edge-guard";
import { createHandler } from "./handler";
import { appRouter } from "./index";
import { createPublicHandler, routeRequest } from "./public-handler";
import { createContextFactory } from "./trpc";

const KEY = "0123456789abcdef0123456789abcdef0123456789ab";
const context = { awsRequestId: "req-edge-0001", getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

function event(headers: Record<string, string>, rawPath = "/api/public/signup.start", method = "POST", rawQueryString = ""): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString,
    headers: { "content-type": "application/json", ...headers },
    isBase64Encoded: false,
    ...(method === "POST" ? { body: "{}" } : {}),
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "198.51.100.9", userAgent: "vitest" },
      requestId: "req-edge-0001",
      routeKey: "$default",
      stage: "$default",
      time: "07/Oct/2026:13:10:00 +0000",
      timeEpoch: 1791378600000,
    },
  } as APIGatewayProxyEventV2;
}

/** The Bff as routers/handler.ts composes it, over in-memory adapters. */
async function bff() {
  const harness = await createSignupHarness().ready();
  const deps: ContextDeps = {
    verifier: createTestIssuer().verifier(),
    directory: createMemoryDirectory(),
    audit: createMemoryAudit(),
    wallClock: () => new Date(),
    loggerFor: (correlationId) => createLogger({ correlationId, sink: () => undefined }),
  };
  const services = vi.fn(() => ({ signup: signupService(harness.deps), password: passwordService(harness.deps) }));
  const refused = vi.fn(async () => undefined);
  const inner = routeRequest(createHandler(appRouter, createContextFactory(() => deps)), createPublicHandler({ services }));
  return { harness, services, refused, handler: withEdgeGuard(inner, { key: () => KEY, onRefused: refused }) };
}

describe("edge guard [FL-119]", () => {
  it("[FL-119] passes only the exact key on every route, and refuses everything else with 403 EDGE_REQUIRED", async () => {
    const inner = vi.fn(async () => ({ statusCode: 200 }));
    const refused = vi.fn(async () => undefined);
    const guarded = withEdgeGuard(inner, { key: () => KEY, onRefused: refused });
    for (const path of ["/api/public/signup.start", "/api/inbox.list", "/api/health", "/inbox.list"]) {
      expect((await guarded(event({ "x-reclamo-edge": KEY }, path), context)).statusCode, path).toBe(200);
      const bypass = await guarded(event({ authorization: "Bearer valid-jwt" }, path), context);
      expect(bypass.statusCode, path).toBe(403);
      expect(bypass.body).toContain(EDGE_REQUIRED);
    }
    expect((await guarded(event({ "X-Reclamo-Edge": `${KEY}0` }), context)).statusCode).toBe(403);
    expect((await guarded(event({ "x-reclamo-edge": KEY.slice(0, -1) }), context)).statusCode).toBe(403);
    expect(refused).toHaveBeenCalledTimes(6);
    expect(inner).toHaveBeenCalledTimes(4);
  });

  it("[FL-119] compares the key in constant time, also when the lengths differ", () => {
    const spy = vi.spyOn(crypto, "safeEqual");
    expect(edgeVerified({ "x-reclamo-edge": "short" }, KEY)).toBe(false);
    expect(edgeVerified({ "x-reclamo-edge": KEY }, KEY)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    expect(crypto.safeEqual("short", KEY)).toBe(false);
  });

  it("[FL-119] refuses everything when the key cannot be read (fail closed)", async () => {
    const guarded = withEdgeGuard(async () => ({ statusCode: 200 }), {
      key: () => {
        throw new Error("not linked");
      },
    });
    expect((await guarded(event({ "x-reclamo-edge": "" }), context)).statusCode).toBe(403);
    expect(edgeVerified({ "x-reclamo-edge": "" }, "")).toBe(false);
  });

  it("[FL-119] reads the viewer IP only in address form", () => {
    expect(viewerIpOf({ "x-reclamo-viewer-ip": "203.0.113.7" })).toBe("203.0.113.7");
    expect(viewerIpOf({ "x-reclamo-viewer-ip": "2001:db8::1" })).toBe("2001:db8::1");
    expect(viewerIpOf({ "x-reclamo-viewer-ip": "1.2.3.4, 5.6.7.8" })).toBeUndefined();
    expect(viewerIpOf({})).toBeUndefined();
  });
});

describe("the Bff behind the edge guard [FL-119]", () => {
  it("[FL-119] answers no route reached without the Router: public, console, health and a hidden batch", async () => {
    const { handler, services, refused, harness } = await bff();
    const routes: [string, string, string][] = [
      ["POST", "/api/public/signup.start", ""],
      ["GET", "/api/public/signup.availability", ""],
      ["POST", "/api/public/password.forgot", ""],
      ["GET", "/api/health", ""],
      ["GET", "/api/inbox.list", ""],
      ["GET", "/api/guest.status,signup.start", "batch=1"],
    ];
    for (const [method, path, query] of routes) {
      const response = await handler(event({ authorization: "Bearer any", "x-reclamo-viewer-ip": "203.0.113.7" }, path, method, query), context);
      expect(response.statusCode, path).toBe(403);
      expect(JSON.parse(response.body ?? "{}")).toEqual({ error: EDGE_REQUIRED });
    }
    expect(refused).toHaveBeenCalledTimes(routes.length);
    expect(services).not.toHaveBeenCalled();
    expect(harness.cognito.calls).toEqual([]);
  });

  it("[FL-119] with the key, each route reaches its own handler and a hidden batch still answers 404", async () => {
    const { handler, services } = await bff();
    const edge = { "x-reclamo-edge": KEY, "x-reclamo-viewer-ip": "203.0.113.7" };
    expect((await handler(event(edge, "/api/health", "GET"), context)).statusCode).toBe(200);
    expect((await handler(event(edge, "/api/public/signup.availability", "GET"), context)).statusCode).toBe(200);
    expect((await handler(event(edge, "/api/inbox.list", "GET"), context)).statusCode).toBe(401);
    expect((await handler(event(edge, "/api/guest.status,signup.start", "GET", "batch=1"), context)).statusCode).toBe(404);
    expect(services).toHaveBeenCalledTimes(1);
  });
});
