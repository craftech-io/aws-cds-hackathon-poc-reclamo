import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTH_REASON } from "../auth/errors";
import { TEST_POOL, createMemoryAudit, createMemoryDirectory, createTestIssuer, staffRow } from "../auth/testing";
import { createLogger } from "../lib/log";
import type { ContextDeps } from "./deps";
import { createHandler, stripApiPrefix } from "./handler";
import { appRouter } from "./index";
import { acceptedAsync, createContextFactory, recentLoginProcedure, roleProcedure, router, worldProcedure } from "./trpc";

const issuer = createTestIssuer();
const lines: string[] = [];
const directory = createMemoryDirectory();
directory.setWorld("demo", "READY");
directory.setWorld("g04", "RESETTING");
directory.setWorld("qa-r1-sc18", "READY");
for (const [worldId, staffId, role] of [
  ["demo", "stf-operator-01", "OPERATOR"],
  ["demo", "stf-supervisor-01", "SUPERVISOR"],
  ["demo", "stf-compliance-01", "COMPLIANCE"],
  ["g04", "stf-guest-04", "GUEST"],
  ["qa-r1-sc18", "stf-qa-operator", "OPERATOR"],
] as const) {
  directory.putStaff(staffRow(worldId, staffId, role));
}
directory.putStaff(staffRow("demo", "stf-operator-gone", "OPERATOR", undefined, { active: false }));

const deps: ContextDeps = {
  verifier: issuer.verifier(),
  directory,
  audit: createMemoryAudit(),
  wallClock: () => new Date(),
  loggerFor: (correlationId) => createLogger({ correlationId, sink: (line) => void lines.push(line) }),
};

const testRouter = router({
  session: router({
    whoami: worldProcedure.query(({ ctx }) => ({ worldId: ctx.principal.worldId, role: ctx.principal.role, staffId: ctx.principal.staffId })),
    supervisorOnly: roleProcedure(["SUPERVISOR"]).query(() => "ok"),
    note: roleProcedure(["OPERATOR", "SUPERVISOR", "COMPLIANCE", "GUEST"]).mutation(() => "noted"),
    approve: recentLoginProcedure.mutation(() => "approved"),
    startReset: worldProcedure.mutation(({ ctx }) => {
      acceptedAsync(ctx);
      return { status: "RESETTING" as const };
    }),
    boom: worldProcedure.query(() => {
      throw new Error("connection string leaked here");
    }),
  }),
});

const ResponseBody = z.looseObject({
  result: z.object({ data: z.unknown() }).optional(),
  error: z.looseObject({ message: z.string(), data: z.looseObject({ code: z.string(), reason: z.string().nullable(), correlationId: z.string().nullable() }) }).optional(),
});

function functionUrlEvent(rawPath: string, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers,
    isBase64Encoded: false,
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method: "GET", path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
      requestId: "req-handler-0001",
      routeKey: "$default",
      stage: "$default",
      time: "18/Sep/2026:15:00:00 +0000",
      timeEpoch: 1789743600000,
    },
  };
}

const lambdaContext: LambdaContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "bff-test",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:bff-test",
  memoryLimitInMB: "512",
  awsRequestId: "lambda-req-0001",
  logGroupName: "/aws/lambda/bff-test",
  logStreamName: "2026/09/18/[$LATEST]test",
  getRemainingTimeInMillis: () => 10_000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined,
};

const handler = createHandler(testRouter, createContextFactory(() => deps));

async function call(rawPath: string, headers?: Record<string, string>) {
  const response = await handler(functionUrlEvent(rawPath, headers), lambdaContext);
  return { status: response.statusCode, headers: response.headers ?? {}, body: ResponseBody.parse(JSON.parse(response.body ?? "{}")) };
}

async function post(rawPath: string, token: string) {
  const event = functionUrlEvent(rawPath, { authorization: `Bearer ${token}`, "content-type": "application/json" });
  const response = await handler({ ...event, body: "{}", requestContext: { ...event.requestContext, http: { ...event.requestContext.http, method: "POST" } } }, lambdaContext);
  return { status: response.statusCode, body: ResponseBody.parse(JSON.parse(response.body ?? "{}")) };
}

describe("BFF Lambda handler", () => {
  it("serves /api/<procedure> behind the Router and /<procedure> on the Function URL", async () => {
    const authorization = `Bearer ${issuer.idToken()}`;
    for (const path of ["/api/session.whoami", "/session.whoami"]) {
      const response = await call(path, { authorization });
      expect(response.status).toBe(200);
      expect(response.body.result?.data).toEqual({ worldId: "demo", role: "OPERATOR", staffId: "stf-operator-01" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("answers HTTP 401 with the reason and the correlation id when the token has no world", async () => {
    const response = await call("/api/session.whoami", { authorization: `Bearer ${issuer.idToken({ worldId: undefined })}` });
    expect(response.status).toBe(401);
    expect(response.body.error?.data).toMatchObject({ code: "UNAUTHORIZED", reason: AUTH_REASON.PRINCIPAL_INCOMPLETE, correlationId: "req-handler-0001" });
  });

  it("answers HTTP 401 without a token and takes a well-formed x-correlation-id", async () => {
    const response = await call("/api/session.whoami", { "x-correlation-id": "console-7f1c9d2e" });
    expect(response.status).toBe(401);
    expect(response.body.error?.data).toMatchObject({ reason: AUTH_REASON.TOKEN_MISSING, correlationId: "console-7f1c9d2e" });
  });

  it("refuses an inactive staff account, a role outside the list and an old sign-in on approvals [FL-094]", async () => {
    const inactive = await call("/api/session.whoami", { authorization: `Bearer ${issuer.idToken({ staffId: "stf-operator-gone" })}` });
    expect(inactive.status).toBe(403);
    expect(inactive.body.error?.data).toMatchObject({ reason: AUTH_REASON.STAFF_INACTIVE });
    const operator = await call("/api/session.supervisorOnly", { authorization: `Bearer ${issuer.idToken()}` });
    expect(operator.status).toBe(403);
    expect(operator.body.error?.data).toMatchObject({ reason: AUTH_REASON.ROLE_NOT_ALLOWED });
    const supervisor = await call("/api/session.supervisorOnly", { authorization: `Bearer ${issuer.idToken({ role: "SUPERVISOR", "cognito:groups": ["SUPERVISOR"], staffId: "stf-supervisor-01" })}` });
    expect(supervisor.status).toBe(200);
    const old = Math.floor(Date.now() / 1000) - 16 * 60;
    const stale = await post("/api/session.approve", issuer.idToken({ auth_time: old }));
    expect(stale.status).toBe(403);
    expect(stale.body.error?.data).toMatchObject({ reason: AUTH_REASON.LOGIN_NOT_RECENT });
  });

  it("refuses every mutation to COMPLIANCE [FL-095]", async () => {
    const compliance = await post("/api/session.note", issuer.idToken({ role: "COMPLIANCE", "cognito:groups": ["COMPLIANCE"], staffId: "stf-compliance-01" }));
    expect(compliance.status).toBe(403);
    expect(compliance.body.error?.data).toMatchObject({ reason: AUTH_REASON.READ_ONLY_ROLE });
    expect((await post("/api/session.note", issuer.idToken())).status).toBe(200);
  });

  it("accepts the ServerClient audience only for qa-* users in qa-* worlds", async () => {
    const server = { aud: TEST_POOL.serverClientId };
    const qa = await call("/api/session.whoami", { authorization: `Bearer ${issuer.idToken({ ...server, "cognito:username": "qa-r1-sc18-operator", worldId: "qa-r1-sc18", staffId: "stf-qa-operator" })}` });
    expect(qa.status).toBe(200);
    const person = await call("/api/session.whoami", { authorization: `Bearer ${issuer.idToken(server)}` });
    expect(person.status).toBe(401);
    expect(person.body.error?.data).toMatchObject({ reason: AUTH_REASON.SERVER_CLIENT_AUDIENCE });
    const qaInDemo = await call("/api/session.whoami", { authorization: `Bearer ${issuer.idToken({ ...server, "cognito:username": "qa-r1-sc18-operator" })}` });
    expect(qaInDemo.status).toBe(401);
  });

  it("answers HTTP 202 when the procedure only started asynchronous work", async () => {
    const accepted = await post("/api/session.startReset", issuer.idToken());
    expect(accepted.status).toBe(202);
    expect(accepted.body.result?.data).toEqual({ status: "RESETTING" });
    expect((await post("/api/session.note", issuer.idToken())).status).toBe(200);
  });

  it("answers WORLD_RESETTING while the world is being reset", async () => {
    const response = await call("/api/session.whoami", { authorization: `Bearer ${issuer.idToken({ worldId: "g04", "cognito:groups": ["GUEST"], role: "GUEST", staffId: "stf-guest-04" })}` });
    expect(response.status).toBe(409);
    expect(response.body.error?.data).toMatchObject({ reason: AUTH_REASON.WORLD_RESETTING });
  });

  it("never sends a stack trace and logs unexpected failures with the correlation id", async () => {
    lines.length = 0;
    const response = await handler(functionUrlEvent("/api/session.boom", { authorization: `Bearer ${issuer.idToken()}` }), lambdaContext);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("stack");
    expect(lines.map((line) => z.looseObject({ message: z.string(), correlationId: z.string() }).parse(JSON.parse(line)))).toContainEqual(
      expect.objectContaining({ message: "console.procedure.failed", correlationId: "req-handler-0001", path: "session.boom" }),
    );
  });

  it("the console router answers the public health probe and 404 for an unknown procedure", async () => {
    const bff = createHandler(appRouter, createContextFactory(() => deps));
    const health = await bff(functionUrlEvent("/api/health"), lambdaContext);
    expect(health.statusCode).toBe(200);
    expect(ResponseBody.parse(JSON.parse(health.body ?? "{}")).result?.data).toEqual({ ok: true, service: "bff" });
    const unknown = await bff(functionUrlEvent("/api/nothing.here"), lambdaContext);
    expect(unknown.statusCode).toBe(404);
  });
});

describe("stripApiPrefix", () => {
  it.each([
    ["/api/inbox.list", "/inbox.list"],
    ["/api/inbox.list,complaints.get", "/inbox.list,complaints.get"],
    ["/api", "/"],
    ["/inbox.list", "/inbox.list"],
    ["/apiary.list", "/apiary.list"],
  ])("%s → %s", (rawPath, expected) => {
    const event = stripApiPrefix(functionUrlEvent(rawPath));
    expect(event.rawPath).toBe(expected);
    expect(event.requestContext.http.path).toBe(expected);
  });
});
