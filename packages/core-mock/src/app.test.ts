import { CONTRACT_VERSION, Customer, ErrorBody, LiveRecipient } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { createCoreApp } from "./app";
import { callerDirectory } from "./http/caller";
import type { CoreHttpRequest } from "./http/event";
import { PHONE_HASH, SIM_NOW, WORLD, coreWorld } from "./ledger/testing";
import { StoreUnavailableError } from "./store/port";

const BFF_ROLE = "arn:aws:iam::776805327629:role/reclamo-poc-BffRole";
const callers = callerDirectory({ roles: { Bff: BFF_ROLE, ToolActions: "arn:aws:iam::776805327629:role/reclamo-poc-ToolActionsRole" } });
const asBff = "arn:aws:sts::776805327629:assumed-role/reclamo-poc-BffRole/fn";
const asActions = "arn:aws:sts::776805327629:assumed-role/reclamo-poc-ToolActionsRole/fn";

function request(path: string, overrides: Partial<CoreHttpRequest> = {}): CoreHttpRequest {
  return { method: "GET", path, query: {}, headers: { "x-sim-now": SIM_NOW, "x-correlation-id": "turn-1" }, callerArn: asBff, requestId: "r1", ...overrides };
}

function app(store = coreWorld([{ customerId: "cus-0001", loans: [{ loanId: "L-0001", principal: 1_000_000, instalments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-${9 + number}-15`, amount: 400_000 })) }] }])) {
  return createCoreApp({ store, callers });
}

const parse = (body: string) => JSON.parse(body) as unknown;

describe("core app over the contract", () => {
  it("answers health and the customer file within the contract, without the live phone or the hashes", async () => {
    const health = await app()(request("/v1/health"));
    expect(parse(health.body)).toEqual({ status: "ok", service: "core", contractVersion: CONTRACT_VERSION });

    const response = await app()(request(`/v1/${WORLD}/customers/cus-0001`));
    expect(response.statusCode).toBe(200);
    const customer = Customer.parse(parse(response.body));
    expect(customer.wallet.cvuMasked).toBe("•••• 0001");
    expect(customer.loans).toEqual([{ loanId: "L-0001", label: "Préstamo L-0001", status: "ACTIVE", outstanding: 1_200_000 }]);
    expect(response.body).not.toMatch(/liveE164|5491100001001|phoneHash|emailHash|syntheticCvu|99900000/);
  });

  it("resolves a phone hash to a customer and 404s an unknown one", async () => {
    const core = app();
    expect(parse((await core(request(`/v1/${WORLD}/customers/by-phone/${PHONE_HASH}`))).body)).toEqual({ customerId: "cus-0001" });
    const missing = await core(request(`/v1/${WORLD}/customers/by-phone/${"0".repeat(64)}`));
    expect(missing.statusCode).toBe(404);
    expect(ErrorBody.parse(parse(missing.body)).code).toBe("NOT_FOUND");
    const noWorld = await core(request("/v1/qa-nothing-here/customers/by-phone/" + PHONE_HASH));
    expect(ErrorBody.parse(parse(noWorld.body)).code).toBe("WORLD_NOT_FOUND");
  });

  it("requires X-Sim-Now and validates path, query and body with the contract", async () => {
    const core = app();
    expect((await core(request(`/v1/${WORLD}/customers/cus-0001`, { headers: {} }))).statusCode).toBe(400);
    expect((await core(request(`/v1/${WORLD}/customers/NOT-AN-ID`))).statusCode).toBe(400);
    expect((await core(request(`/v1/${WORLD}/customers/cus-0001/operations`, { query: { from: "2026-01-01", to: "2026-10-07" } }))).statusCode).toBe(400);
    const ops = await core(request(`/v1/${WORLD}/customers/cus-0001/operations`, { query: { from: "2026-09-08", to: "2026-10-07" } }));
    expect(parse(ops.body)).toEqual({ customerId: "cus-0001", from: "2026-09-08", to: "2026-10-07", operations: [], truncated: false });
    const badBody = await core(request(`/v1/${WORLD}/customers/cus-0001/challenge-check`, { method: "POST", callerArn: asActions, body: JSON.stringify({ kind: "LAST_DUE_DATE", answer: "5/10", expected: "x" }) }));
    expect(badBody.statusCode).toBe(400);
    expect((await core(request("/v1/elsewhere"))).statusCode).toBe(404);
  });

  it("maps the ledger's refusals to the contract's statuses, with the actionId of a CONFLICT", async () => {
    const core = app();
    const body = { customerId: "cus-0001", complaintId: "cmp-1", reconciliationId: "rec-1", network: "SUR", operationCode: "SUR-1", amount: 400_000, paidAtSim: SIM_NOW, source: "SETTLEMENT", idempotencyKey: "k1", cap: 1_000_000 };
    const pay = (overrides: Record<string, unknown>) => core(request(`/v1/${WORLD}/loans/L-0001/payments`, { method: "POST", callerArn: asActions, body: JSON.stringify({ ...body, ...overrides }) }));
    const first = await pay({});
    expect(first.statusCode).toBe(200);
    const conflict = await pay({ idempotencyKey: "k2", complaintId: "cmp-2" });
    expect(conflict.statusCode).toBe(409);
    expect(parse(conflict.body)).toMatchObject({ code: "CONFLICT", actionId: (parse(first.body) as { actionId: string }).actionId });
    expect((await pay({ operationCode: "SUR-2", amount: 2_000_000, cap: 3_000_000 })).statusCode).toBe(422);
    expect((await pay({ operationCode: "SUR-3", customerId: "cus-0002" })).statusCode).toBe(403);
  });

  it("answers 503 when the store fails, so the client retries", async () => {
    const store = coreWorld([{ customerId: "cus-0001" }]);
    const failing = { ...store, query: async () => Promise.reject(new StoreUnavailableError("throttled")) };
    const response = await createCoreApp({ store: failing, callers })(request(`/v1/${WORLD}/customers/cus-0001`));
    expect(response.statusCode).toBe(503);
    expect(ErrorBody.parse(parse(response.body)).code).toBe("UNAVAILABLE");
  });
});

describe("the live WhatsApp number", () => {
  const WORKER_ROLE = "arn:aws:iam::776805327629:role/reclamo-poc-EventWorkerRole";
  const QA_WORKER_ROLE = "arn:aws:iam::776805327629:role/reclamo-poc-QaEventWorkerRole";
  const withWorkers = callerDirectory({ roles: { Bff: BFF_ROLE, EventWorker: WORKER_ROLE, QaEventWorker: QA_WORKER_ROLE } });
  const asWorker = "arn:aws:sts::776805327629:assumed-role/reclamo-poc-EventWorkerRole/fn";
  const asQaWorker = "arn:aws:sts::776805327629:assumed-role/reclamo-poc-QaEventWorkerRole/fn";
  const customers = [{ customerId: "cus-0001", loans: [] }];

  it("answers the functions that run the outbound gate, and only in a world that may run live", async () => {
    const demo = createCoreApp({ store: coreWorld(customers, "demo"), callers: withWorkers });
    const live = await demo(request("/v1/demo/customers/cus-0001/live-recipient", { callerArn: asWorker }));
    expect(LiveRecipient.parse(parse(live.body))).toEqual({ customerId: "cus-0001", e164: "+5491100001001" });
    const qa = createCoreApp({ store: coreWorld(customers), callers: withWorkers });
    expect(parse((await qa(request(`/v1/${WORLD}/customers/cus-0001/live-recipient`, { callerArn: asQaWorker }))).body)).toEqual({ customerId: "cus-0001" });
  });

  it("refuses every other role with CALLER_NOT_ALLOWED, the console's included", async () => {
    const demo = createCoreApp({ store: coreWorld(customers, "demo"), callers: withWorkers });
    const refused = await demo(request("/v1/demo/customers/cus-0001/live-recipient", { callerArn: asBff }));
    expect(refused.statusCode).toBe(403);
    expect(ErrorBody.parse(parse(refused.body)).code).toBe("CALLER_NOT_ALLOWED");
    expect(refused.body).not.toContain("5491100001001");
  });
});
