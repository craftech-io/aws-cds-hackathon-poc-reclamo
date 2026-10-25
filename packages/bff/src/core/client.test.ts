import { createCoreApp } from "@reclamo/core-mock/app";
import { callerDirectory } from "@reclamo/core-mock/http/caller";
import { SIM_NOW, WORLD, coreWorld } from "@reclamo/core-mock/ledger/testing";
import { toToolFailure } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { createLogger } from "../lib/log";
import { CORE_CLIENT_DEFAULTS, type CoreTransport, type WireRequest, createCoreClient } from "./client";
import { CoreError } from "./errors";
import { functionUrlRegion, sigV4Signer } from "./signer";

const ENDPOINT = "https://abc123.lambda-url.us-east-1.on.aws/";
const ROLE = "arn:aws:iam::776805327629:role/reclamo-poc-ToolActionsRole";
const SESSION = "arn:aws:sts::776805327629:assumed-role/reclamo-poc-ToolActionsRole/fn";
const ctx = { worldId: WORLD, simNow: SIM_NOW, correlationId: "turn-01J9" };
const silent = createLogger({ sink: () => undefined });
const noSleep = async () => undefined;

function world() {
  return coreWorld([
    {
      customerId: "cus-0004",
      balance: 500_000,
      loans: [{ loanId: "L-0004", principal: 3_000_000, instalments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-${9 + number}-02`, amount: 1_100_000 })) }],
      movements: [{ movementId: "mov-1", kind: "TRANSFER_IN", atSim: "2026-10-01T10:00:00-03:00", amount: 300_000 }],
    },
  ]);
}

/** The real core app in process, behind the same wire the Lambda answers. */
function inProcess(store = world(), seen: WireRequest[] = []): CoreTransport {
  const app = createCoreApp({ store, callers: callerDirectory({ roles: { ToolActions: ROLE } }) });
  return async (request) => {
    seen.push(request);
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const response = await app({ method: request.method, path: request.url.pathname, query: Object.fromEntries(request.url.searchParams), headers, ...(request.body === undefined ? {} : { body: request.body }), callerArn: SESSION, requestId: "r" });
    return { status: response.statusCode, text: response.body };
  };
}

const payment = {
  customerId: "cus-0004",
  complaintId: "cmp-4",
  reconciliationId: "rec-4",
  network: "SUR" as const,
  operationCode: "SUR-20261002-000123-4",
  amount: 1_100_000,
  paidAtSim: "2026-10-02T12:00:00-03:00",
  source: "SETTLEMENT" as const,
  idempotencyKey: "cmp-4:rec-4",
  cap: 25_000_000,
};

describe("core client over the contract", () => {
  it("calls the core with the world, X-Sim-Now and the correlation id, and returns the parsed answer", async () => {
    const seen: WireRequest[] = [];
    const client = createCoreClient({ endpoint: ENDPOINT, transport: inProcess(world(), seen), logger: silent, sleep: noSleep });
    const customer = await client.call("getCustomer", ctx, { params: { customerId: "cus-0004" } });
    expect(customer).toMatchObject({ customerId: "cus-0004", wallet: { balance: 500_000, cvuMasked: "•••• 0004" } });
    expect(seen[0]?.url.href).toBe(`${ENDPOINT}v1/${WORLD}/customers/cus-0004`);
    expect(seen[0]?.headers).toMatchObject({ "x-sim-now": SIM_NOW, "x-correlation-id": "turn-01J9" });

    const operations = await client.call("listOperations", ctx, { params: { customerId: "cus-0004" }, query: { to: "2026-10-07", from: "2026-09-08", kind: "ALL" } });
    expect(seen[1]?.url.search).toBe("?from=2026-09-08&kind=ALL&to=2026-10-07");
    expect(operations.operations).toHaveLength(1);
  });

  it("moves money once: a retry after a lost answer gets the first answer back, not a second imputation", async () => {
    const store = world();
    const real = inProcess(store);
    let calls = 0;
    const losesFirstAnswer: CoreTransport = async (request) => {
      calls += 1;
      const response = await real(request);
      if (calls === 1) throw new Error("socket hang up");
      return response;
    };
    const client = createCoreClient({ endpoint: ENDPOINT, transport: losesFirstAnswer, logger: silent, sleep: noSleep });
    const result = await client.call("applyPayment", ctx, { params: { loanId: "L-0004" }, body: payment });
    expect(result).toMatchObject({ applied: 1_100_000, allocations: [{ instalment: 1, statusAfter: "PAID" }] });
    expect(calls).toBe(2);
    expect(store.commits).toBe(1);

    const other = createCoreClient({ endpoint: ENDPOINT, transport: real, logger: silent, sleep: noSleep });
    const conflict = await other.call("applyPayment", ctx, { params: { loanId: "L-0004" }, body: { ...payment, complaintId: "cmp-5", idempotencyKey: "cmp-5:rec-9" } }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(CoreError);
    expect(conflict).toMatchObject({ contractCode: "CONFLICT", code: "CONFLICT", actionId: result.actionId, status: 409, attempts: 1 });
    expect(toToolFailure(conflict)).toEqual({ ok: false, error: { code: "CONFLICT", message: "core.applyPayment: CONFLICT", reason: "CONFLICT" } });
  });

  it("validates the call with the contract before sending anything", async () => {
    const seen: WireRequest[] = [];
    const client = createCoreClient({ endpoint: ENDPOINT, transport: inProcess(world(), seen), logger: silent, sleep: noSleep });
    const extraKey = { ...payment, capOverride: "x" } as typeof payment;
    await expect(client.call("applyPayment", ctx, { params: { loanId: "L-0004" }, body: extraKey })).rejects.toMatchObject({ contractCode: "INVALID", attempts: 0 });
    await expect(client.call("getCustomer", { ...ctx, simNow: "yesterday" }, { params: { customerId: "cus-0004" } })).rejects.toMatchObject({ contractCode: "INVALID" });
    await expect(client.call("getCustomer", { ...ctx, worldId: "W#demo#" }, { params: { customerId: "cus-0004" } })).rejects.toMatchObject({ contractCode: "INVALID" });
    expect(seen).toHaveLength(0);
  });

  it("retries a 503 with backoff and gives up after 3 retries with a retryable UNAVAILABLE", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const flaky: CoreTransport = async () => {
      calls += 1;
      return calls < 3 ? { status: 503, text: JSON.stringify({ code: "UNAVAILABLE", message: "try again" }) } : { status: 200, text: JSON.stringify({ customerId: "cus-0004" }) };
    };
    const client = createCoreClient({ endpoint: ENDPOINT, transport: flaky, logger: silent, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    expect(await client.call("getCustomerByPhone", ctx, { params: { phoneHash: "a".repeat(64) } })).toEqual({ customerId: "cus-0004" });
    expect(sleeps).toEqual([50, 100]);

    const down = createCoreClient({ endpoint: ENDPOINT, transport: async () => ({ status: 503, text: "" }), logger: silent, sleep: noSleep });
    await expect(down.call("getCustomerByPhone", ctx, { params: { phoneHash: "a".repeat(64) } })).rejects.toMatchObject({ contractCode: "UNAVAILABLE", retryable: true, attempts: 4 });
  });

  it("cuts an attempt at 5 s and treats the timeout like a network error", async () => {
    expect(CORE_CLIENT_DEFAULTS).toMatchObject({ timeoutMs: 5_000, maxRetries: 3 });
    let calls = 0;
    const hangs: CoreTransport = (request) => {
      calls += 1;
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    const client = createCoreClient({ endpoint: ENDPOINT, transport: hangs, timeoutMs: 10, maxRetries: 1, logger: silent, sleep: noSleep });
    await expect(client.health()).rejects.toMatchObject({ contractCode: "UNAVAILABLE", message: "core.getCoreHealth: TIMEOUT", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("never lets an answer outside the contract reach a tool, and does not retry a refusal", async () => {
    let calls = 0;
    const leaky: CoreTransport = async () => {
      calls += 1;
      return { status: 200, text: JSON.stringify({ customerId: "cus-0004", liveE164: "+5491100001004" }) };
    };
    const client = createCoreClient({ endpoint: ENDPOINT, transport: leaky, logger: silent, sleep: noSleep });
    await expect(client.call("getCustomerByPhone", ctx, { params: { phoneHash: "a".repeat(64) } })).rejects.toMatchObject({ contractCode: "UNAVAILABLE", retryable: true });
    expect(calls).toBe(1);

    const forbidden = createCoreClient({ endpoint: ENDPOINT, transport: inProcess(), logger: silent, sleep: noSleep });
    await expect(forbidden.call("applyPayment", ctx, { params: { loanId: "L-0004" }, body: { ...payment, customerId: "cus-0099" } })).rejects.toMatchObject({ contractCode: "FORBIDDEN", code: "FORBIDDEN", attempts: 1 });
  });

  it("signs for the Function URL's region with SigV4", async () => {
    const url = new URL(`${ENDPOINT}v1/health`);
    expect(functionUrlRegion(url)).toBe("us-east-1");
    const sign = sigV4Signer({ credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-example" }, signingDate: () => new Date("2026-10-07T13:10:00Z") });
    const headers = await sign({ method: "GET", url, headers: { "x-sim-now": SIM_NOW } });
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261007\/us-east-1\/lambda\/aws4_request, SignedHeaders=host;[a-z0-9;-]*x-sim-now, Signature=[0-9a-f]{64}$/);
    await expect(sigV4Signer({ credentials: { accessKeyId: "a", secretAccessKey: "b" } })({ method: "GET", url: new URL("https://example.test/"), headers: {} })).rejects.toThrow(RangeError);
  });
});
