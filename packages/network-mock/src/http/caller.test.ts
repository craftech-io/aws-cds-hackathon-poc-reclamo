import { describe, expect, it } from "vitest";
import { TEST_CALLERS, assumedRoleArn, createInProcessNetworkMock, testRoleArn } from "../testing";
import { CALLER_ROLES, type CallerRole, CallerRoleArns, authorizeCaller, callerRoleOf } from "./caller";
import { createFunctionUrlHandler } from "./lambda";
import { createMemoryNetworkStore, createMemorySettlementObjects } from "../store/memory";

const WORLDS = ["demo", "g01", "gtest", "gprobe", "gs-abcdefghij", "qa-812345-1-sc18", "qamin", "sim-batch1"] as const;

/** docs/architecture.md §14, "Autorización por mundo en los mocks". */
const REACHES: Readonly<Record<CallerRole, readonly string[]>> = {
  QaDriver: ["qa-812345-1-sc18", "qamin", "sim-batch1"],
  QaEventWorker: ["qa-812345-1-sc18", "qamin", "sim-batch1"],
  EventWorker: ["demo", "g01", "gtest", "gprobe"],
  SignupEventWorker: ["gs-abcdefghij"],
  Bff: ["demo", "g01", "gtest", "gs-abcdefghij", "qa-812345-1-sc18"],
  ToolInvestigation: [...WORLDS],
  ToolActions: [...WORLDS],
  ScheduleDispatch: [...WORLDS],
};

describe("[FL-099] caller role from the Function URL's IAM authorizer", () => {
  it("[FL-099] recognises the linked roles by account and role name, and nobody else", () => {
    for (const role of CALLER_ROLES) expect(callerRoleOf(assumedRoleArn(role), TEST_CALLERS)).toBe(role);
    expect(callerRoleOf(testRoleArn("EventWorker"), TEST_CALLERS)).toBe("EventWorker");
    expect(callerRoleOf("arn:aws:sts::111122223333:assumed-role/reclamo-poc-EventWorkerRole/x", TEST_CALLERS)).toBeUndefined();
    expect(callerRoleOf("arn:aws:sts::776805327629:assumed-role/reclamo-poc-ToolIdentityRole/reclamo-poc-ToolIdentity", TEST_CALLERS)).toBeUndefined();
    expect(callerRoleOf("arn:aws:iam::776805327629:user/someone", TEST_CALLERS)).toBeUndefined();
    expect(callerRoleOf(undefined, TEST_CALLERS)).toBeUndefined();
    expect(CallerRoleArns.safeParse({ roles: { EventWorker: "not-an-arn" } }).success).toBe(false);
    // The link is shared with the core mock: a role that only calls the core is nobody here.
    const shared = CallerRoleArns.parse({ roles: { ...TEST_CALLERS.roles, PolicyAudit: "arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-reclamo/reclamo-poc-PolicyAuditRole" } });
    expect(callerRoleOf("arn:aws:sts::776805327629:assumed-role/reclamo-poc-PolicyAuditRole/reclamo-poc-PolicyAudit", shared)).toBeUndefined();
  });

  it("[FL-099] lets each role reach only its classes of world (CALLER_WORLD_DENIED otherwise)", () => {
    for (const role of CALLER_ROLES) {
      for (const worldId of WORLDS) {
        const decision = authorizeCaller({ userArn: assumedRoleArn(role), linked: TEST_CALLERS, operation: "getTransfer", worldId });
        if (REACHES[role].includes(worldId)) expect(decision, `${role} → ${worldId}`).toEqual({ allowed: true, role });
        else expect(decision, `${role} → ${worldId}`).toEqual({ allowed: false, code: "CALLER_WORLD_DENIED", role });
      }
    }
  });

  it("[FL-099] keeps each role to its operations, and an unknown caller out of everything", () => {
    const decide = (role: CallerRole, operation: Parameters<typeof authorizeCaller>[0]["operation"]) =>
      authorizeCaller({ userArn: assumedRoleArn(role), linked: TEST_CALLERS, operation, worldId: "qa-812345-1-sc18" }).allowed;
    expect(decide("ToolInvestigation", "requestTransferReversal")).toBe(false);
    expect(decide("ToolActions", "requestTransferReversal")).toBe(true);
    expect(decide("EventWorker", "publishSettlement")).toBe(false);
    expect(decide("ScheduleDispatch", "publishSettlement")).toBe(true);
    expect(decide("ScheduleDispatch", "transitionTransfer")).toBe(true);
    expect(decide("ScheduleDispatch", "registerCollection")).toBe(false);
    expect(decide("Bff", "transitionTransfer")).toBe(true);
    expect(authorizeCaller({ userArn: assumedRoleArn("Bff"), linked: TEST_CALLERS, operation: "publishSettlement", worldId: "demo" }).allowed).toBe(true);
    expect(authorizeCaller({ userArn: assumedRoleArn("Bff"), linked: TEST_CALLERS, operation: "requestTransferReversal", worldId: "demo" }).allowed).toBe(false);
    expect(decide("QaDriver", "registerCollection")).toBe(true);
    expect(authorizeCaller({ userArn: undefined, linked: TEST_CALLERS, operation: "getNetworksHealth" })).toEqual({ allowed: false, code: "CALLER_NOT_ALLOWED" });
  });
});

describe("[FL-099] the app refuses before it reads anything of another world", () => {
  it("[FL-099] QaDriver on a guest world → 403 CALLER_WORLD_DENIED, logged as an audit line, the world untouched", async () => {
    const mock = createInProcessNetworkMock();
    mock.seedWorld("g01");
    mock.seedTransfer({ worldId: "g01", transferId: "trf-c28", customerId: "cus-0028", direction: "IN", amount: 100, status: "PENDING" });
    const before = JSON.stringify(mock.store.dump());
    const denied = await mock.call("QaDriver", { method: "POST", path: "/v1/g01/transfers/trf-c28/transition", simNow: "2026-10-08T12:00:00-03:00", body: { to: "COMPLETED" }, correlationId: "sc18-10-c" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json).toEqual({ code: "CALLER_WORLD_DENIED", message: "this caller may not reach this world" });
    expect(JSON.stringify(mock.store.dump())).toBe(before);
    expect(mock.logs.at(-1)).toMatchObject({ level: "warn", audit: "CALLER_WORLD_DENIED", code: "CALLER_WORLD_DENIED", worldId: "g01", role: "QaDriver", correlationId: "sc18-10-c", service: "network-mock" });
    // The same answer for a world that does not exist: the refusal says nothing about the world.
    expect((await mock.call("QaDriver", { method: "GET", path: "/v1/g77/transfers/x", simNow: "2026-10-08T12:00:00-03:00" })).json).toMatchObject({ code: "CALLER_WORLD_DENIED" });
  });

  it("[FL-099] takes the role only from the authorizer, never from a header or the body", async () => {
    const mock = createInProcessNetworkMock();
    mock.seedWorld("demo");
    const response = await mock.app.handle({
      method: "GET",
      path: "/v1/demo/transfers/trf-c27",
      headers: { "x-sim-now": "2026-10-07T10:10:00-03:00", "x-caller-role": "EventWorker", "x-amz-user-arn": assumedRoleArn("EventWorker") },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ code: "CALLER_NOT_ALLOWED" });
  });

  it("answers the contract's errors: no route, no X-Sim-Now, world not found; health for every role", async () => {
    const mock = createInProcessNetworkMock();
    mock.seedWorld("demo");
    expect((await mock.call("EventWorker", { method: "GET", path: "/v1/demo/nothing", simNow: "2026-10-07T10:10:00-03:00" })).statusCode).toBe(404);
    expect((await mock.call("EventWorker", { method: "GET", path: "/v1/demo/transfers/trf-1" })).json).toMatchObject({ code: "INVALID" });
    expect((await mock.call("EventWorker", { method: "GET", path: "/v1/g02/transfers/trf-1", simNow: "2026-10-07T10:10:00-03:00" })).json).toMatchObject({ code: "WORLD_NOT_FOUND" });
    expect((await mock.call("EventWorker", { method: "GET", path: "/v1/DEMO/transfers/trf-1", simNow: "2026-10-07T10:10:00-03:00" })).statusCode).toBe(400);
    for (const role of CALLER_ROLES) {
      expect((await mock.call(role, { method: "GET", path: "/v1/health" })).json).toEqual({ status: "ok", service: "networks", contractVersion: "1.0.0" });
    }
  });
});

describe("[FL-099] Function URL adapter", () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    version: "2.0",
    rawPath: "/v1/health",
    rawQueryString: "",
    headers: {},
    isBase64Encoded: false,
    requestContext: { requestId: "req-1", http: { method: "GET", path: "/v1/health" }, authorizer: { iam: { userArn: assumedRoleArn("ScheduleDispatch") } } },
    ...overrides,
  });
  const deps = () => ({ store: createMemoryNetworkStore(), objects: createMemorySettlementObjects(), callers: TEST_CALLERS, log: () => undefined });

  it("[FL-099] refuses an event without the shape of a Function URL request (a direct invocation)", async () => {
    const handler = createFunctionUrlHandler(deps, { log: () => undefined });
    expect((await handler({ worldId: "demo", action: "publish" })).statusCode).toBe(400);
    expect((await handler(event())).statusCode).toBe(200);
  });

  it("[FL-099] without the IAM authorizer nobody is allowed", async () => {
    const handler = createFunctionUrlHandler(deps, { log: () => undefined });
    const response = await handler(event({ requestContext: { http: { method: "GET" } } }));
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ code: "CALLER_NOT_ALLOWED" });
  });

  it("answers 503 while its links cannot be resolved, and recovers on the next request", async () => {
    let calls = 0;
    const handler = createFunctionUrlHandler(
      () => {
        calls += 1;
        if (calls === 1) throw new Error("not linked");
        return deps();
      },
      { log: () => undefined },
    );
    expect((await handler(event())).statusCode).toBe(503);
    expect((await handler(event())).statusCode).toBe(200);
  });

  it("decodes a base64 body", async () => {
    const mock = createInProcessNetworkMock();
    mock.seedWorld("qamin");
    mock.seedTransfer({ worldId: "qamin", transferId: "trf-1", customerId: "cus-qa-1", direction: "OUT", amount: 100, status: "PENDING" });
    const handler = createFunctionUrlHandler(() => ({ store: mock.store, objects: createMemorySettlementObjects(), callers: TEST_CALLERS, log: () => undefined }));
    const response = await handler(
      event({
        rawPath: "/v1/qamin/transfers/trf-1/transition",
        headers: { "x-sim-now": "2026-10-08T12:00:00-03:00", "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ to: "COMPLETED" })).toString("base64"),
        isBase64Encoded: true,
        requestContext: { http: { method: "POST" }, authorizer: { iam: { userArn: assumedRoleArn("QaDriver") } } },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: "COMPLETED" });
  });
});
