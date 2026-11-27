// The access line of the Bff (docs/architecture.md §12): one JSON line per request, also for the ones
// refused before tRPC or that throw, with the eight fields and nothing a person typed or carries.
import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createMemoryAudit, createMemoryDirectory, createTestIssuer, staffRow } from "../auth/testing";
import type { ContextDeps } from "../routers/deps";
import { accessIpOf, withEdgeGuard } from "../routers/edge-guard";
import { createHandler } from "../routers/handler";
import { createContextFactory, router, worldProcedure } from "../routers/trpc";
import { passedSecondFactor } from "../second-factor/doubles";
import { ACCESS_MESSAGE, AGENT_MAX, ROUTE_MAX, clean, withAccessLog } from "./access-log";
import { createLogger } from "./log";

const KEY = "edge-key-of-the-tests-0123456789abcdef";
const SUB = "3b7c1d2e-0000-4000-8000-00000000a001";
const context = { awsRequestId: "req-access-0001", getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

function event(rawPath: string, options: { method?: string; headers?: Record<string, string>; query?: string; body?: string } = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: options.query ?? "",
    headers: options.headers ?? {},
    isBase64Encoded: false,
    ...(options.body === undefined ? {} : { body: options.body }),
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method: options.method ?? "GET", path: rawPath, protocol: "HTTP/1.1", sourceIp: "198.51.100.99", userAgent: "vitest" },
      requestId: "req-access-0001",
      routeKey: "$default",
      stage: "$default",
      time: "07/Oct/2026:13:10:00 +0000",
      timeEpoch: 1_791_378_600_000,
    },
  };
}

function rig() {
  const lines: string[] = [];
  const issuer = createTestIssuer();
  const directory = createMemoryDirectory();
  directory.setWorld("demo", "READY");
  directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR", SUB));
  const deps: ContextDeps = {
    verifier: issuer.verifier(),
    directory,
    audit: createMemoryAudit(),
    wallClock: () => new Date(),
    loggerFor: (correlationId) => createLogger({ correlationId, sink: () => undefined }),
    secondFactor: passedSecondFactor(),
  };
  const testRouter = router({
    session: router({
      whoami: worldProcedure.query(({ ctx }) => ({ staffId: ctx.principal.staffId })),
      boom: worldProcedure.query(() => {
        throw new Error("boom");
      }),
    }),
  });
  const inner = createHandler(testRouter, createContextFactory(() => deps));
  let now = 1_000;
  const handler = withAccessLog(withEdgeGuard(inner, { key: () => KEY }), {
    ipOf: (request) => accessIpOf(request, () => KEY),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "info", sink: (line) => void lines.push(line) }),
    elapsedMs: () => (now += 7),
  });
  const accessLines = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.message === ACCESS_MESSAGE);
  return { handler, issuer, accessLines, lines };
}

const edge = { "x-reclamo-edge": KEY, "x-reclamo-viewer-ip": "203.0.113.7" };

describe("the access line of the Bff", () => {
  it("writes one line per request with the eight fields, the verified sub and the IP the caps count", async () => {
    const r = rig();
    const token = r.issuer.idToken({ sub: SUB, staffId: "stf-operator-01", worldId: "demo", role: "OPERATOR" });
    const response = await r.handler(event("/api/session.whoami", { headers: { ...edge, authorization: `Bearer ${token}`, "user-agent": "Mozilla/5.0 (test)", "x-forwarded-for": "10.9.9.9" } }), context);
    expect(response.statusCode).toBe(200);
    const [line] = r.accessLines();
    expect(r.accessLines()).toHaveLength(1);
    expect(line).toMatchObject({ message: "access", route: "/api/session.whoami", method: "GET", status: 200, ip: "203.0.113.7", agent: "Mozilla/5.0 (test)", sub: SUB, ms: 7 });
    expect(JSON.stringify(line)).not.toContain("10.9.9.9");
  });

  it("logs a request refused before tRPC: no edge header (the Function URL's own address, never a header), no token, an unknown route", async () => {
    const r = rig();
    expect((await r.handler(event("/api/session.whoami", { headers: { "x-reclamo-viewer-ip": "192.0.2.66" } }), context)).statusCode).toBe(403);
    expect((await r.handler(event("/api/session.whoami", { headers: edge }), context)).statusCode).toBe(401);
    expect((await r.handler(event("/api/nope.none", { headers: edge }), context)).statusCode).toBe(404);
    const lines = r.accessLines();
    expect(lines.map((line) => [line.status, line.ip])).toEqual([
      [403, "198.51.100.99"],
      [401, "203.0.113.7"],
      [404, "203.0.113.7"],
    ]);
    for (const line of lines) expect(line).not.toHaveProperty("sub");
  });

  it("logs a failed request as 500 and still answers it, and a throwing handler as 500 and rethrows", async () => {
    const r = rig();
    const token = r.issuer.idToken({ sub: SUB, staffId: "stf-operator-01", worldId: "demo", role: "OPERATOR" });
    expect((await r.handler(event("/api/session.boom", { headers: { ...edge, authorization: `Bearer ${token}` } }), context)).statusCode).toBe(500);
    const lines: string[] = [];
    const throwing = withAccessLog(async () => Promise.reject(new Error("down")), { ipOf: () => "203.0.113.8", loggerFor: () => createLogger({ level: "info", sink: (line) => void lines.push(line) }) });
    await expect(throwing(event("/api/x"))).rejects.toThrow("down");
    expect(r.accessLines().map((line) => line.status)).toEqual([500]);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ message: "access", status: 500, ip: "203.0.113.8" });
  });

  it("never carries the body, the query string, the token, the authorization header, an email or a phone", async () => {
    const r = rig();
    const token = r.issuer.idToken({ sub: SUB, staffId: "stf-operator-01", worldId: "demo", role: "OPERATOR" });
    await r.handler(
      event("/api/public/signup.start", {
        method: "POST",
        headers: { ...edge, authorization: `Bearer ${token}`, "content-type": "application/json" },
        query: "email=ana%40empresa-ficticia.ar&phone=%2B5491155550100",
        body: JSON.stringify({ email: "ana@empresa-ficticia.ar", phone: "+5491155550100", password: "UnaClaveLarga2026" }),
      }),
      context,
    );
    await r.handler(event("/api/ana@empresa-ficticia.ar/+5491155550100", { headers: edge }), context);
    const text = JSON.stringify(r.accessLines());
    for (const secret of [token, "Bearer", "ana@empresa-ficticia.ar", "+5491155550100", "5491155550100", "UnaClaveLarga2026", "email=", KEY]) expect(text, secret).not.toContain(secret);
    expect(r.accessLines()).toHaveLength(2);
  });

  it("strips control characters and line separators, and cuts the route and the agent", async () => {
    const lines: string[] = [];
    const handler = withAccessLog(async () => ({ statusCode: 204 }), { ipOf: () => "203.0.113.9", loggerFor: () => createLogger({ level: "info", sink: (line) => void lines.push(line) }) });
    await handler(event(`/api/${"a".repeat(300)}%0A{"message":"forged"}`, { headers: { "user-agent": `bot\r\n${"x".repeat(200)}\u2028` } }));
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(String(line.route)).toHaveLength(ROUTE_MAX);
    expect(String(line.agent)).toHaveLength(AGENT_MAX);
    expect(String(line.agent)).not.toMatch(/[\r\n\u2028]/);
    expect(line.status).toBe(204);
    expect(clean("a\u0000b\u001fc\u007fd\u2029e", 10)).toBe("abcde");
    expect(clean(`/api/x%0A`.replace("%0A", "\n"), 20)).toBe("/api/x");
    expect(lines).toHaveLength(1);
  });
});
