import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { type CollectionRequest, formatSettlementCsv } from "@reclamo/core-contract";
import { createInProcessNetworkMock, inProcessNetworkFetch } from "@reclamo/network-mock/testing";
import type { NetworkRequest } from "@reclamo/network-mock";
import { describe, expect, it } from "vitest";
import { createLogger } from "../lib/log";
import { NETWORK_CLIENT_DEFAULTS, type NetworkClientDeps, type NetworkFetch, createNetworkClient } from "./client";
import { NetworkClientError } from "./errors";
import { SettlementFileError, createSettlementFileReader } from "./settlement-files";
import { functionUrlRegion, sigV4Signer } from "../core/signer";

const ENDPOINT = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";
const CREDENTIALS = { accessKeyId: "AKIDTESTONLY", secretAccessKey: "test-only-secret" };
const SIGNED_AT = new Date("2026-10-07T13:10:00.000Z");
const QA_WORLD = "qa-812345-1-sc07";
const SIM_NOW = new Date("2026-10-07T13:10:00.000Z");

const COLLECTION: CollectionRequest = {
  network: "NORTE",
  operationCode: "NTE-20261006-004817-2",
  paidAtSim: "2026-10-06T18:40:00-03:00",
  amount: 11_864_000,
  customerRef: "cus-qa-812345-1-sc07-c01",
  loanRef: "L-0001",
  instalment: 4,
  terminal: "T-0412",
};

function setup(role: "QaDriver" | "ToolActions" | "ToolInvestigation" = "QaDriver", overrides: Partial<NetworkClientDeps> = {}) {
  const mock = createInProcessNetworkMock();
  mock.seedWorld(QA_WORLD);
  const recorded: NetworkRequest[] = [];
  const sleeps: number[] = [];
  const logLines: string[] = [];
  const client = createNetworkClient({
    endpoint: ENDPOINT,
    sign: sigV4Signer({ credentials: CREDENTIALS, signingDate: () => SIGNED_AT }),
    fetch: inProcessNetworkFetch(mock.app, role, recorded),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    logger: createLogger({ level: "debug", sink: (line) => logLines.push(line) }),
    ...overrides,
  });
  return { mock, client, recorded, sleeps, logLines };
}

/** A fetch that answers from a script, one entry per call (the last one repeats). */
function scripted(responses: Array<() => Response | Promise<Response>>, calls: string[] = []): NetworkFetch {
  return async (url) => {
    calls.push(url);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next === undefined) throw new Error("empty script");
    return next();
  };
}

const unavailable = () => new Response('{"code":"UNAVAILABLE","message":"x"}', { status: 503 });

async function failure(promise: Promise<unknown>): Promise<NetworkClientError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(NetworkClientError);
  return error as NetworkClientError;
}

describe("networks client against the mock in process", () => {
  it("registers, lists and publishes with the world's simulated instant, signed with SigV4", async () => {
    const { client, recorded } = setup();
    const call = { worldId: QA_WORLD, simNow: SIM_NOW, correlationId: "turn-7f3a9c2e" };
    const collected = await client.registerCollection(call, COLLECTION);
    expect(collected).toMatchObject({ businessDate: "2026-10-07", batchCreated: true, batch: { status: "PENDING", publishAtSim: "2026-10-08T08:30:00-03:00" } });
    expect(await client.listSettlements(call, "NORTE", { from: "2026-10-07", to: "2026-10-07" })).toMatchObject({ batches: [{ status: "PENDING" }] });
    const published = await client.publishSettlement({ ...call, simNow: "2026-10-08T08:30:00-03:00" }, "NORTE", "2026-10-07");
    expect(published).toMatchObject({ outcome: "PUBLISHED", batch: { status: "PUBLISHED", lineCount: 4 } });

    const first = recorded[0];
    expect(first?.path).toBe(`/v1/${QA_WORLD}/collections`);
    expect(first?.headers).toMatchObject({ "x-sim-now": SIM_NOW.toISOString(), "x-correlation-id": "turn-7f3a9c2e", "content-type": "application/json" });
    expect(first?.headers?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTESTONLY\/20261007\/us-east-1\/lambda\/aws4_request/);
    expect(recorded[1]?.query).toBe("from=2026-10-07&to=2026-10-07");
    expect(functionUrlRegion(new URL(ENDPOINT))).toBe("us-east-1");
  });

  it("reads transfers and moves them through the contract", async () => {
    const { mock, client } = setup();
    mock.seedTransfer({ worldId: QA_WORLD, transferId: "trf-c30", customerId: "cus-0030", direction: "OUT", amount: 8_000_000, status: "REJECTED_NOT_REVERSED" });
    const call = { worldId: QA_WORLD, simNow: SIM_NOW };
    expect(await client.getTransfer(call, "trf-c31")).toEqual({ transferId: "trf-c31", status: "UNKNOWN" });
    const reversal = { customerId: "cus-0030", complaintId: "cmp-1", idempotencyKey: "cmp-1:TRANSFER_REVERSAL:1", cap: 20_000_000 };
    const reversed = await client.requestTransferReversal(call, "trf-c30", reversal);
    expect(reversed).toMatchObject({ transferId: "trf-c30", status: "REJECTED_REVERSED", amount: 8_000_000 });

    const conflict = await failure(client.requestTransferReversal(call, "trf-c30", { ...reversal, complaintId: "cmp-2", idempotencyKey: "cmp-2:TRANSFER_REVERSAL:1" }));
    expect(conflict).toMatchObject({ code: "CONFLICT", details: { attempts: 1, status: 409, actionId: reversed.actionId } });
    expect(await client.transitionTransfer(call, "trf-c30", { to: "REJECTED_REVERSED" })).toMatchObject({ status: "REJECTED_REVERSED" });
    expect(await client.health()).toEqual({ status: "ok", service: "networks", contractVersion: "1.0.0" });
  });

  it("surfaces the mock's refusals as final errors without retrying", async () => {
    const { client, sleeps } = setup("ToolInvestigation");
    const denied = await failure(client.registerCollection({ worldId: QA_WORLD, simNow: SIM_NOW }, COLLECTION));
    expect(denied).toMatchObject({ code: "CALLER_NOT_ALLOWED", details: { attempts: 1, status: 403 } });
    const missing = await failure(client.getTransfer({ worldId: "g07", simNow: SIM_NOW }, "trf-1"));
    expect(missing.code).toBe("WORLD_NOT_FOUND");
    expect(sleeps).toEqual([]);
  });

  it("refuses inputs outside the contract before sending anything", async () => {
    const { client, recorded } = setup();
    await expect(client.registerCollection({ worldId: QA_WORLD, simNow: SIM_NOW }, { ...COLLECTION, amount: 0 })).rejects.toThrow();
    await expect(client.getTransfer({ worldId: "W#demo", simNow: SIM_NOW }, "trf-1")).rejects.toThrow();
    await expect(client.getTransfer({ worldId: QA_WORLD, simNow: "yesterday" }, "trf-1")).rejects.toThrow();
    expect(recorded).toEqual([]);
  });
});

describe("networks client · retries and failures", () => {
  it("retries a 503 three times with backoff, then fails UNAVAILABLE", async () => {
    const calls: string[] = [];
    const { client, sleeps, logLines } = setup("QaDriver", { fetch: scripted([unavailable], calls) });
    const error = await failure(client.getTransfer({ worldId: QA_WORLD, simNow: SIM_NOW }, "trf-1"));
    expect(error).toMatchObject({ code: "UNAVAILABLE", details: { attempts: NETWORK_CLIENT_DEFAULTS.maxRetries + 1, status: 503 } });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 400]);
    expect(logLines.some((line) => line.includes('"metric":"NetworkErrors"'))).toBe(true);
  });

  it("recovers when a retry answers, and treats a timeout as retryable", async () => {
    let calls = 0;
    const flaky: NetworkFetch = async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
      return new Response(JSON.stringify({ transferId: "trf-1", status: "PENDING" }), { status: 200 });
    };
    const { client } = setup("QaDriver", { fetch: flaky, timeoutMs: 5 });
    expect(await client.getTransfer({ worldId: QA_WORLD, simNow: SIM_NOW }, "trf-1")).toEqual({ transferId: "trf-1", status: "PENDING" });
    expect(calls).toBe(2);
  });

  it("never uses an answer outside the contract", async () => {
    const { client } = setup("QaDriver", { fetch: scripted([() => new Response(JSON.stringify({ transferId: "trf-1", status: "PENDING", customerId: "cus-0001" }), { status: 200 })]) });
    expect((await failure(client.getTransfer({ worldId: QA_WORLD, simNow: SIM_NOW }, "trf-1"))).code).toBe("INVALID_RESPONSE");
    const broken = setup("QaDriver", { fetch: scripted([() => new Response("<html>", { status: 400 })]) });
    expect(await failure(broken.client.getTransfer({ worldId: QA_WORLD, simNow: SIM_NOW }, "trf-1"))).toMatchObject({ code: "INVALID_RESPONSE", details: { status: 400 } });
  });

  it("fails UNAVAILABLE without sending when it cannot sign", async () => {
    const calls: string[] = [];
    const { client } = setup("QaDriver", { sign: async () => Promise.reject(new Error("no credentials")), fetch: scripted([unavailable], calls) });
    expect(await failure(client.health())).toMatchObject({ code: "UNAVAILABLE", details: { attempts: 0 } });
    expect(calls).toEqual([]);
  });
});

describe("published settlement files", () => {
  const lines = [{ network: "NORTE" as const, businessDate: "2026-10-07", operationCode: COLLECTION.operationCode, paidAt: COLLECTION.paidAtSim, amount: 11_864_000, customerRef: "cus-0001", loanRef: "L-0001", instalment: 4, terminal: "T-0412" }];
  const csv = formatSettlementCsv(lines);
  const batch = {
    network: "NORTE" as const,
    businessDate: "2026-10-07",
    status: "PUBLISHED" as const,
    publishAtSim: "2026-10-08T08:30:00-03:00",
    s3Key: "W/demo/NORTE/2026-10-07/batch-1.csv",
    lineCount: 1,
    sha256: createHash("sha256").update(csv).digest("hex"),
  };
  const s3 = (body: string) => ({
    send: async (command: GetObjectCommand) => {
      expect(command.input).toEqual({ Bucket: "settlements-bucket", Key: batch.s3Key });
      return { ContentLength: Buffer.byteLength(body), Body: { transformToByteArray: async () => new TextEncoder().encode(body) } };
    },
  });

  it("reads the file the network published, checked against its sha256 and line count", async () => {
    const read = createSettlementFileReader({ s3: s3(csv) as never, bucket: "settlements-bucket" });
    expect(await read(batch)).toEqual(lines);
  });

  it("refuses a pending batch, a tampered file and a file with other lines than declared", async () => {
    const read = createSettlementFileReader({ s3: s3(csv) as never, bucket: "settlements-bucket" });
    await expect(read({ network: "NORTE", businessDate: "2026-10-07", status: "PENDING", publishAtSim: batch.publishAtSim })).rejects.toMatchObject({ code: "NOT_PUBLISHED" });
    const tampered = createSettlementFileReader({ s3: s3(csv.replace("118640.00", "1.00")) as never, bucket: "settlements-bucket" });
    await expect(tampered(batch)).rejects.toMatchObject({ code: "SHA_MISMATCH" });
    await expect(read({ ...batch, lineCount: 2 })).rejects.toBeInstanceOf(SettlementFileError);
    const down = createSettlementFileReader({ s3: { send: async () => Promise.reject(new Error("timeout")) } as never, bucket: "settlements-bucket" });
    await expect(down(batch)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
