// The public procedures over HTTP (docs/architecture-guests.md §4, FL-112 to FL-119): only under
// `/api/public/<procedure>`, one per request, never from `/api/*`, answers as data. The services'
// rules are tested in guests/; here, that each procedure reaches them with the visitor's input.
import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { passwordService } from "../guests/password";
import { signupService } from "../guests/signup";
import { createSignupHarness, startInput } from "../guests/testing/harness";
import { createPublicHandler, namesPublicProcedure, routeRequest } from "./public-handler";

const lambdaContext = { awsRequestId: "req-public-0001", getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

function request(method: "GET" | "POST", rawPath: string, body?: unknown, rawQueryString = ""): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString,
    headers: { "content-type": "application/json", "x-reclamo-viewer-ip": "203.0.113.7" },
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "reclamo.demo.craftech.io",
      domainPrefix: "reclamo",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.7", userAgent: "vitest" },
      requestId: "req-public-0001",
      routeKey: "$default",
      stage: "$default",
      time: "07/Oct/2026:13:10:00 +0000",
      timeEpoch: 1791378600000,
    },
  };
}

async function setup() {
  const harness = await createSignupHarness().ready();
  const services = vi.fn(() => ({ signup: signupService(harness.deps), password: passwordService(harness.deps) }));
  const console = vi.fn(async () => ({ statusCode: 200, body: "console" }));
  const handler = routeRequest(console, createPublicHandler({ services }));
  return { harness, services, console, handler };
}

function data(body: string | undefined): unknown {
  return (JSON.parse(body ?? "{}") as { result?: { data?: unknown } }).result?.data;
}

describe("public procedures over HTTP [FL-112] [FL-119]", () => {
  it("runs signup.start under /api/public and answers data", async () => {
    const { handler, harness } = await setup();
    const response = await handler(request("POST", "/api/public/signup.start", startInput()), lambdaContext);
    expect(response.statusCode).toBe(200);
    expect(data(response.body)).toMatchObject({ status: "CODE_SENT" });
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(harness.cognito.calls).toContain("SignUp");
  });

  it("answers availability as a cacheable GET", async () => {
    const { handler } = await setup();
    const response = await handler(request("GET", "/api/public/signup.availability"), lambdaContext);
    expect(data(response.body)).toEqual({ status: "open" });
    expect(response.headers?.["cache-control"]).toBe("public, max-age=60");
  });

  it("404s a public procedure named under /api/*, alone or hidden in a batch, without running anything", async () => {
    const { handler, services, console } = await setup();
    for (const path of ["/api/signup.start", "/api/guest.status,signup.start", "/api/password.forgot"]) {
      const response = await handler(request("POST", path, {}, "batch=1"), lambdaContext);
      expect(response.statusCode, path).toBe(404);
    }
    expect(services).not.toHaveBeenCalled();
    expect(console).not.toHaveBeenCalled();
    expect(namesPublicProcedure("/api/inbox.list")).toBe(false);
  });

  it("400s a batch or two procedures under /api/public, before tRPC", async () => {
    const { handler, services } = await setup();
    expect((await handler(request("POST", "/api/public/signup.start,password.forgot", {}, "batch=1"), lambdaContext)).statusCode).toBe(400);
    expect((await handler(request("POST", "/api/public/signup.start", {}, "batch=1"), lambdaContext)).statusCode).toBe(400);
    expect((await handler(request("POST", "/api/public/inbox.list", {}), lambdaContext)).statusCode).toBe(404);
    expect(services).not.toHaveBeenCalled();
  });

  it("refuses an input that is not strict, and never echoes it", async () => {
    const { handler } = await setup();
    const response = await handler(request("POST", "/api/public/signup.start", { ...startInput(), admin: true }), lambdaContext);
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("Una-Clave-Larga-2026");
    expect(response.body).not.toContain("ana.prospecto");
  });

  it("answers the neutral recovery status for any email [FL-122]", async () => {
    const { handler } = await setup();
    const response = await handler(request("POST", "/api/public/password.forgot", { email: "supervisor-01@empresa-ficticia.ar", locale: "es" }), lambdaContext);
    expect(data(response.body)).toEqual({ status: "CODE_SENT_IF_EXISTS" });
  });

  it("leaves every other /api path to the console", async () => {
    const { handler, console } = await setup();
    expect((await handler(request("GET", "/api/inbox.list"), lambdaContext)).body).toBe("console");
    expect(console).toHaveBeenCalledTimes(1);
  });
});

async function call(handler: Awaited<ReturnType<typeof setup>>["handler"], procedure: string, body: unknown, ip = "203.0.113.7"): Promise<unknown> {
  const event = request("POST", `/api/public/${procedure}`, body);
  const response = await handler({ ...event, headers: { ...event.headers, "x-reclamo-viewer-ip": ip } }, lambdaContext);
  return data(response.body);
}

const EMAIL = "ana.prospecto@empresa-ficticia.ar";

async function started(handler: Awaited<ReturnType<typeof setup>>["handler"], ip?: string): Promise<string> {
  const answer = (await call(handler, "signup.start", startInput(), ip)) as { status: string; signupId?: string };
  if (answer.status !== "CODE_SENT" || !answer.signupId) throw new Error(`signup.start answered ${answer.status}`);
  return answer.signupId;
}

describe("signup.confirm over HTTP [FL-113] [FL-115]", () => {
  it("confirms with the emailed code once, and a repeat changes nothing", async () => {
    const { handler, harness } = await setup();
    const signupId = await started(handler);
    const code = harness.cognito.lastCode(EMAIL) ?? "";
    expect(await call(handler, "signup.confirm", { signupId, code })).toEqual({ status: "CONFIRMED", worldStatus: "REGISTERED", email: EMAIL });
    expect(await call(handler, "signup.confirm", { signupId, code })).toMatchObject({ status: "CONFIRMED" });
    expect(harness.invoked.worlds).toHaveLength(1);
  });

  it("answers CODE_MISMATCH to a wrong code, and SIGNUP_RESTART to an unknown request without Cognito", async () => {
    const { handler, harness } = await setup();
    const signupId = await started(handler);
    expect(await call(handler, "signup.confirm", { signupId, code: "999999" })).toEqual({ status: "CODE_MISMATCH" });
    expect(harness.cognito.user(EMAIL)?.status).toBe("UNCONFIRMED");
    const calls = harness.cognito.calls.length;
    expect(await call(handler, "signup.confirm", { signupId: "abcdefghijklmnopqrstuvwxyz", code: "123456" })).toEqual({ status: "SIGNUP_RESTART" });
    expect(harness.cognito.calls.length).toBe(calls);
  });
});

describe("signup.resend over HTTP [FL-114]", () => {
  it("answers CODE_SENT within the caps and RATE_LIMITED above them, and CODE_SENT to an unknown request", async () => {
    const { handler, harness } = await setup();
    const signupId = await started(handler);
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await call(handler, "signup.resend", { signupId })).toEqual({ status: "CODE_SENT" });
    expect(await call(handler, "signup.resend", { signupId })).toEqual({ status: "RATE_LIMITED" });
    const calls = harness.cognito.calls.length;
    expect(await call(handler, "signup.resend", { signupId: "abcdefghijklmnopqrstuvwxyz" })).toEqual({ status: "CODE_SENT" });
    expect(harness.cognito.calls.length).toBe(calls);
  });
});

describe("signup.start for a registered email and over the caps [FL-116] [FL-118]", () => {
  it("answers EMAIL_TAKEN for a confirmed account, and the superseded request restarts", async () => {
    const { handler, harness } = await setup();
    const first = await started(handler);
    const second = await started(handler, "198.51.100.4");
    const code = harness.cognito.lastCode(EMAIL) ?? "";
    expect(await call(handler, "signup.confirm", { signupId: first, code })).toEqual({ status: "SIGNUP_RESTART" });
    expect(await call(handler, "signup.confirm", { signupId: second, code })).toMatchObject({ status: "CONFIRMED" });
    expect(await call(handler, "signup.start", startInput({ email: "ANA.Prospecto@empresa-ficticia.ar" }), "198.51.100.5")).toEqual({ status: "EMAIL_TAKEN" });
  });

  it("answers RATE_LIMITED to the fourth sign-up of an IP in a real day, before Cognito", async () => {
    const { handler, harness } = await setup();
    for (let n = 1; n <= 3; n += 1) expect(await call(handler, "signup.start", startInput({ email: `persona${n}@empresa-ficticia.ar` }))).toMatchObject({ status: "CODE_SENT" });
    const calls = harness.cognito.calls.length;
    expect(await call(handler, "signup.start", startInput({ email: "persona4@empresa-ficticia.ar" }))).toEqual({ status: "RATE_LIMITED" });
    expect(harness.cognito.calls.length).toBe(calls);
  });
});
