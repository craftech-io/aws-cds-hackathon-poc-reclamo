import { describe, expect, it } from "vitest";
import { type CoreEvent, createCoreApp } from "../app";
import { SIM_NOW, coreWorld } from "../ledger/testing";
import { CALLER_WORLDS, type CoreCaller, authorizeOperation, authorizeWorld, callerDirectory, roleIdentity, sessionIdentity } from "./caller";
import { toCoreRequest } from "./event";

const ACCOUNT = "776805327629";
const roleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/aws-cds-hackathon-poc-reclamo/${name}`;
const sessionArn = (name: string, account = ACCOUNT) => `arn:aws:sts::${account}:assumed-role/${name}/${name}-session`;

const ROLES: Record<CoreCaller, string> = {
  InboundWhatsApp: "reclamo-poc-InboundWhatsAppRole-a1",
  EventWorker: "reclamo-poc-EventWorkerRole-b2",
  SignupEventWorker: "reclamo-poc-SignupEventWorkerRole-c3",
  QaEventWorker: "reclamo-poc-QaEventWorkerRole-d4",
  ToolIdentity: "reclamo-poc-ToolIdentityRole-e5",
  ToolAccount: "reclamo-poc-ToolAccountRole-f6",
  ToolInvestigation: "reclamo-poc-ToolInvestigationRole-g7",
  ToolActions: "reclamo-poc-ToolActionsRole-h8",
  ToolComplaints: "reclamo-poc-ToolComplaintsRole-i9",
  ToolMessaging: "reclamo-poc-ToolMessagingRole-m3",
  ToolHandoff: "reclamo-poc-ToolHandoffRole-n4",
  Bff: "reclamo-poc-BffRole-j0",
  QaDriver: "aws-cds-hackathon-poc-reclamo-poc-qa-driver",
  PolicyAudit: "aws-cds-hackathon-poc-reclamo-poc-policy-audit",
};

const directory = callerDirectory({ roles: { ...Object.fromEntries(Object.entries(ROLES).map(([caller, name]) => [caller, roleArn(name)])), NetworkOnly: roleArn("reclamo-poc-ScheduleDispatchRole-k1") } });

function functionUrlEvent(path: string, callerArn: string | undefined, headers: Record<string, string> = { "x-sim-now": SIM_NOW }) {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    headers,
    isBase64Encoded: false,
    requestContext: { requestId: "req-1", http: { method: "GET" }, ...(callerArn === undefined ? {} : { authorizer: { iam: { userArn: callerArn } } }) },
  };
}

function appWithEvents() {
  const events: CoreEvent[] = [];
  const store = coreWorld([{ customerId: "cus-0001" }], "g01");
  store.seed(coreWorld([{ customerId: "cus-0001" }], "qa-run7-sc18").dump());
  return { app: createCoreApp({ store, callers: directory, onEvent: (event) => events.push(event) }), events };
}

async function call(path: string, caller: CoreCaller | undefined, userArn?: string) {
  const { app, events } = appWithEvents();
  const request = toCoreRequest(functionUrlEvent(path, userArn ?? (caller === undefined ? undefined : sessionArn(ROLES[caller]))));
  if (request === undefined) throw new Error("not a Function URL event");
  const response = await app(request);
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown>, events };
}

describe("world authorization of the invoking role [FL-099]", () => {
  it("[FL-099] resolves the role only from the IAM session ARN, by account and role name", () => {
    expect(sessionIdentity(sessionArn("reclamo-poc-BffRole-j0"))).toEqual({ account: ACCOUNT, roleName: "reclamo-poc-BffRole-j0" });
    expect(roleIdentity(roleArn("reclamo-poc-BffRole-j0"))).toEqual({ account: ACCOUNT, roleName: "reclamo-poc-BffRole-j0" });
    expect(directory.resolve(sessionArn(ROLES.Bff))).toBe("Bff");
    expect(directory.resolve(sessionArn(ROLES.Bff, "111111111111"))).toBeUndefined();
    expect(directory.resolve(`arn:aws:iam::${ACCOUNT}:user/admin`)).toBeUndefined();
    expect(directory.resolve(sessionArn("reclamo-poc-ScheduleDispatchRole-k1"))).toBeUndefined();
    expect(directory.resolve(undefined)).toBeUndefined();
  });

  it("[FL-099] keeps the QA roles out of every guest and demo world, and each worker in its own pool", () => {
    const table: ReadonlyArray<readonly [CoreCaller, readonly string[], readonly string[]]> = [
      ["QaDriver", ["qa-run7-sc18", "qamin", "sim-load1"], ["demo", "g01", "g99", "gtest", "gprobe", "gs-abcdefghij"]],
      ["QaEventWorker", ["qa-run7-sc18", "qamin", "sim-load1"], ["demo", "g07", "gprobe", "gs-abcdefghij"]],
      ["EventWorker", ["demo", "g01", "gtest", "gprobe"], ["gs-abcdefghij", "qa-run7-sc18", "qamin", "sim-load1"]],
      ["SignupEventWorker", ["gs-abcdefghij"], ["demo", "g01", "gtest", "qa-run7-sc18"]],
      ["Bff", ["demo", "g12", "gtest", "gs-abcdefghij", "qa-run7-sc18"], ["gprobe", "qamin", "sim-load1"]],
      ["ToolActions", ["demo", "g01", "gs-abcdefghij", "qa-run7-sc18", "gprobe"], ["not-a-world", "x"]],
      ["PolicyAudit", ["demo", "g01", "gtest", "gs-abcdefghij", "qa-run7-sc18", "qamin"], ["sim-load1", "not-a-world"]],
    ];
    for (const [caller, allowed, denied] of table) {
      for (const worldId of allowed) expect(authorizeWorld(caller, worldId), `${caller} → ${worldId}`).toEqual({ allowed: true });
      for (const worldId of denied) expect(authorizeWorld(caller, worldId), `${caller} → ${worldId}`).toEqual({ allowed: false, code: "CALLER_WORLD_DENIED" });
    }
    expect(Object.keys(CALLER_WORLDS).sort()).toEqual(Object.keys(ROLES).sort());
  });

  it("lets PolicyAudit only read a customer and the core's health", () => {
    expect(authorizeOperation("PolicyAudit", "getCustomer")).toBe(true);
    expect(authorizeOperation("PolicyAudit", "getCoreHealth")).toBe(true);
    for (const operation of ["applyPayment", "getLiveRecipient", "listOperations"]) expect(authorizeOperation("PolicyAudit", operation), operation).toBe(false);
    expect(authorizeOperation("Bff", "listOperations")).toBe(true);
  });

  it("[FL-099] answers 403 CALLER_WORLD_DENIED to the QaDriver on a guest world, with an audit line and nothing read", async () => {
    const { status, body, events } = await call("/v1/g01/customers/cus-0001", "QaDriver");
    expect(status).toBe(403);
    expect(body).toEqual({ code: "CALLER_WORLD_DENIED", message: expect.any(String) });
    expect(events).toEqual([expect.objectContaining({ operation: "getCustomer", status: 403, code: "CALLER_WORLD_DENIED", caller: "QaDriver", worldId: "g01", audit: true })]);
  });

  it("[FL-099] serves the same route to the QaDriver in its own QA world and to the guest's worker in the guest world", async () => {
    expect((await call("/v1/qa-run7-sc18/customers/cus-0001", "QaDriver")).status).toBe(200);
    expect((await call("/v1/g01/customers/cus-0001", "EventWorker")).status).toBe(200);
    expect((await call("/v1/g01/customers/cus-0001", "SignupEventWorker")).status).toBe(403);
  });

  it("[FL-099] answers 403 CALLER_NOT_ALLOWED to a role outside the table or a request without the IAM authorizer", async () => {
    expect((await call("/v1/g01/customers/cus-0001", undefined, sessionArn("someone-else"))).body).toMatchObject({ code: "CALLER_NOT_ALLOWED" });
    expect((await call("/v1/g01/customers/cus-0001", undefined)).body).toMatchObject({ code: "CALLER_NOT_ALLOWED" });
    expect((await call("/v1/health", undefined)).status).toBe(403);
  });

  it("[FL-099] refuses any event without the shape of a Function URL event", () => {
    expect(toCoreRequest({ worldId: "g01", customerId: "cus-0001" })).toBeUndefined();
    expect(toCoreRequest({ ...functionUrlEvent("/v1/health", sessionArn(ROLES.Bff)), version: "1.0" })).toBeUndefined();
    expect(toCoreRequest(null)).toBeUndefined();
    const ok = toCoreRequest({ ...functionUrlEvent("/v1/health", sessionArn(ROLES.Bff)), headers: { "X-Sim-Now": SIM_NOW } });
    expect(ok).toMatchObject({ method: "GET", path: "/v1/health", headers: { "x-sim-now": SIM_NOW }, callerArn: sessionArn(ROLES.Bff) });
  });
});
