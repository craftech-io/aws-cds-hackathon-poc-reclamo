import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDeps } from "../auth/testing";
import { createLogger } from "../lib/log";
import type { ContextDeps } from "./deps";
import { createHandler, handler as productionHandler } from "./handler";
import { appRouter } from "./index";
import { createContextFactory } from "./trpc";

// The deployed entry reads one link before anything else: the edge key (routers/edge-guard.ts).
const EDGE_KEY = vi.hoisted(() => "edge-key-of-the-test-0123456789abcdef");
vi.mock("sst", () => ({ Resource: { EdgeOriginKey: { value: EDGE_KEY } } }));

const lambdaContext = { awsRequestId: "req-health-0001", getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

function event(method: "GET" | "POST", headers: Record<string, string> = {}, rawPath = "/api/health"): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers,
    isBase64Encoded: false,
    ...(method === "POST" ? { body: "{}" } : {}),
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
      requestId: "req-health-0001",
      routeKey: "$default",
      stage: "$default",
      time: "26/Sep/2026:12:00:00 +0000",
      timeEpoch: 1790424000000,
    },
  };
}

const Body = z.object({ result: z.object({ data: z.unknown() }) });

// Every dependency counts its calls and fails: the probe must not need any of them.
function trappedDeps() {
  const calls: string[] = [];
  const trap = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error(`${name} is down`));
  };
  const deps: ContextDeps = {
    verifier: { verify: trap("verifier") },
    directory: { staff: trap("staff"), meta: trap("meta") },
    audit: { record: trap("audit") },
    wallClock: () => new Date(),
    loggerFor: (correlationId) => createLogger({ correlationId, sink: () => undefined }),
  };
  return { deps, calls };
}

describe("GET /api/health", () => {
  it("answers 200 statically, without a token and without calling any dependency", async () => {
    const { deps, calls } = trappedDeps();
    const bff = createHandler(appRouter, createContextFactory(() => deps));
    const headerSets: Record<string, string>[] = [{}, { authorization: "Bearer not-a-jwt" }, { authorization: `Bearer ${createTestDeps().issuer.idToken()}` }];
    for (const headers of headerSets) {
      const response = await bff(event("GET", headers), lambdaContext);
      expect(response.statusCode).toBe(200);
      expect(Body.parse(JSON.parse(response.body ?? "{}")).result.data).toEqual({ ok: true, service: "bff" });
      expect(response.headers?.["cache-control"]).toBe("no-store");
    }
    expect(calls).toEqual([]);
  });

  it("says nothing about any world, whoever asks", async () => {
    const { deps } = trappedDeps();
    const bff = createHandler(appRouter, createContextFactory(() => deps));
    const response = await bff(event("GET", { authorization: `Bearer ${createTestDeps().issuer.idToken({ worldId: "g07" })}` }), lambdaContext);
    expect(response.body).not.toMatch(/g07|demo|worldId|staff/);
  });

  it("is served by the deployed entry only through the edge: no Cognito or table is read [FL-119]", async () => {
    const edge = { "x-reclamo-edge": EDGE_KEY };
    expect((await productionHandler(event("GET", edge), lambdaContext)).statusCode).toBe(200);
    expect((await productionHandler(event("GET", edge, "/health"), lambdaContext)).statusCode).toBe(200);
    const bypass = await productionHandler(event("GET"), lambdaContext);
    expect(bypass.statusCode).toBe(403);
    expect(bypass.body).toContain("EDGE_REQUIRED");
    expect((await productionHandler(event("GET", { "x-reclamo-edge": `${EDGE_KEY}x` }), lambdaContext)).statusCode).toBe(403);
  });

  it("is a query only: a POST does not run it", async () => {
    const { deps } = trappedDeps();
    const bff = createHandler(appRouter, createContextFactory(() => deps));
    const response = await bff(event("POST", { "content-type": "application/json" }), lambdaContext);
    expect(response.statusCode).not.toBe(200);
  });

  it("does not crash on a GET that carries a body", async () => {
    const { deps } = trappedDeps();
    const bff = createHandler(appRouter, createContextFactory(() => deps));
    const response = await bff({ ...event("GET"), body: "{\"x\":1}" }, lambdaContext);
    expect(response.statusCode).toBe(200);
  });
});
