// appendChained (docs/architecture.md §8.3, ADR-0014): optimistic head, one transaction with the
// caller's items, no gap after a cancellation, the HMAC chain and the anchor request after the commit.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it, vi } from "vitest";
import { SIM_NOW, complaint } from "../connector/testing";
import type { WriteOp } from "../connector/store";
import { lambdaAnchorRequester } from "./anchors";
import { type ChainBuild, GENESIS_HASH, appendChained, canonicalJson, chainHash, hashedContent } from "./register";
import { TEST_CHAIN_KEY, complaintsKit, linesNamed } from "./testing";

vi.mock("sst", () => ({ Resource: new Proxy({}, { get: (_target, name) => (name === "AnchorWriter" ? { name: "reclamo-poc-AnchorWriter" } : undefined) }) }));

function statusEntry(cause: string) {
  return {
    eventType: "STATUS" as const,
    atSim: SIM_NOW,
    complaintId: "cmp-0001",
    complaintNumber: "R-2026-000123",
    kind: "RECLAMO" as const,
    type: "PAYMENT_NOT_REFLECTED" as const,
    channel: "WHATSAPP" as const,
    origin: "LIVE" as const,
    reason: cause,
  };
}

describe("canonical JSON and the chain hash", () => {
  it("writes one text per value: keys sorted at every level, undefined members dropped", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: undefined, w: 0 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"w":0,"y":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("hashes the entry without its own hash and the connector's stamps", () => {
    const entry = { seq: 1, prevHash: GENESIS_HASH, eventType: "FILED" };
    expect(hashedContent({ ...entry, hash: "x", createdAt: "t", updatedAt: "t", version: 1 })).toEqual(entry);
    const hash = chainHash(TEST_CHAIN_KEY, GENESIS_HASH, entry);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(chainHash(TEST_CHAIN_KEY, GENESIS_HASH, { ...entry, hash, createdAt: "later" })).toBe(hash);
    expect(chainHash(TEST_CHAIN_KEY, GENESIS_HASH, { ...entry, eventType: "STATUS" })).not.toBe(hash);
    expect(chainHash("another-key-another-key-another-key", GENESIS_HASH, entry)).not.toBe(hash);
  });
});

describe("appendChained [FL-014]", () => {
  it("[FL-014] chains seq 1 from the genesis hash and seq 2 from the stored hash, then asks for each anchor", async () => {
    const kit = complaintsKit();
    const first = await appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: statusEntry("A") }) });
    const second = await appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: statusEntry("B") }) });
    expect(first.entry).toMatchObject({ seq: 1, prevHash: GENESIS_HASH, worldId: "demo", epoch: 1 });
    expect(second.entry).toMatchObject({ seq: 2, prevHash: first.entry.hash });
    expect(first.entry.hash).toBe(chainHash(TEST_CHAIN_KEY, GENESIS_HASH, first.entry));
    const stored = await kit.connector.chains.getEntry("REG", { pk: "W#demo#REG#e1", sk: "000000002" });
    expect(stored && chainHash(TEST_CHAIN_KEY, stored.prevHash, stored)).toBe(stored?.hash);
    expect(await kit.connector.chains.readHead("demo", 1, "REG")).toEqual({ value: 2, hash: second.entry.hash });
    expect(kit.anchorRequests).toEqual([
      { worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 1, pk: "W#demo#REG#e1", sk: "000000001" }] },
      { worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 2, pk: "W#demo#REG#e1", sk: "000000002" }] },
    ]);
  });

  it("[FL-014] serializes two concurrent writers by the head: consecutive seq, no gap", async () => {
    const kit = complaintsKit();
    const [a, b] = await Promise.all([
      appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: statusEntry("A") }) }),
      appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: statusEntry("B") }) }),
    ]);
    expect([a.entry.seq, b.entry.seq].sort()).toEqual([1, 2]);
    const { entries } = await kit.connector.chains.listRegister("REG", "demo", 1);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
  });

  it("[FL-014] a head that moves after it was read cancels the transaction and the retry takes the next seq", async () => {
    let raced = false;
    const kit = complaintsKit({
      beforeWrite: async (ops) => {
        if (raced || !ops.some((op) => op.table === "Register")) return;
        raced = true;
        await appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: statusEntry("RACER") }) });
      },
    });
    const result = await appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: statusEntry("MINE") }) });
    expect(result.attempts).toBe(2);
    expect(result.entry.seq).toBe(2);
    const { entries } = await kit.connector.chains.listRegister("REG", "demo", 1);
    expect(entries.map((entry) => [entry.seq, entry.reason])).toEqual([
      [1, "RACER"],
      [2, "MINE"],
    ]);
  });

  it("[FL-014] the caller's own condition failing after the head was read cancels head and entry: no seq consumed", async () => {
    const kit = complaintsKit();
    await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo"))]);
    let builds = 0;
    const result = await appendChained(kit.deps, {
      chain: "REG",
      worldId: "demo",
      epoch: 1,
      build: async () => {
        builds += 1;
        const current = await kit.connector.complaints.get("demo", "cmp-0001", { consistent: true });
        const version = current?.version ?? 0;
        // Someone else changes the complaint after this build read it (only the first time).
        if (builds === 1) await kit.connector.complaints.patch("demo", "cmp-0001", version, { priority: "HIGH" });
        const extra: WriteOp[] = [kit.connector.complaints.patchOp("demo", "cmp-0001", version, { slaState: "AT_RISK" })];
        return { entry: statusEntry("PATCHED"), extra };
      },
    });
    expect(builds).toBe(2);
    expect(result.entry.seq).toBe(1);
    expect(kit.store.dump("Register").map((row) => row.sk)).toEqual(["000000001"]);
    expect(await kit.connector.complaints.get("demo", "cmp-0001")).toMatchObject({ priority: "HIGH", slaState: "AT_RISK", version: 3 });
  });

  it("gives up after five cancelled transactions without writing anything", async () => {
    const kit = complaintsKit();
    await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo"))]);
    const error = await appendChained(kit.deps, {
      chain: "REG",
      worldId: "demo",
      epoch: 1,
      build: () => ({ entry: statusEntry("NEVER"), extra: [kit.connector.complaints.patchOp("demo", "cmp-0001", 99, { priority: "HIGH" })] }),
    }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(kit.store.dump("Register")).toEqual([]);
    expect(kit.anchorRequests).toEqual([]);
  });

  it("[FL-014] a failed anchor request leaves the entry committed and logs AnchorWriteFailed", async () => {
    const kit = complaintsKit({
      onAnchor: () => {
        throw new Error("lambda down");
      },
    });
    const result = await appendChained(kit.deps, { chain: "TAPE", worldId: "demo", epoch: 1, build: () => ({ entry: tapeBody() }) });
    expect(result.entry.seq).toBe(1);
    expect(kit.store.dump("ComplianceTape")).toHaveLength(1);
    expect(linesNamed(kit.lines, "register.anchor_request_failed")[0]).toMatchObject({ metric: "AnchorWriteFailed", chain: "TAPE", seq: 1 });
  });

  it("chains the refund register apart from the complaint register", async () => {
    const kit = complaintsKit();
    await appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: statusEntry("A") }) });
    const refund = await appendChained(kit.deps, {
      chain: "RRI",
      worldId: "demo",
      epoch: 1,
      build: (): ChainBuild<"RRI"> => ({ entry: { atSim: SIM_NOW, customerId: "cus-0002", actionId: "act-1", cause: "REVERSE_CHARGE", product: "Billetera", amountCents: 120_000, interestCents: 300 } }),
    });
    expect(refund.entry).toMatchObject({ seq: 1, prevHash: GENESIS_HASH });
    expect(refund.appended).toMatchObject({ chain: "RRI", pk: "W#demo#RRI#e1", sk: "000000001" });
  });
});

function tapeBody() {
  return {
    atSim: SIM_NOW,
    tapeId: "tape-0001",
    decision: "ALLOWED" as const,
    ruleIds: [],
    evaluated: [{ ruleId: "CH-WA-NO-COLLECTION", result: "PASS" }],
    ruleSetVersion: "v1",
    sender: "AGENT",
    channel: "WHATSAPP" as const,
    kind: "REPLY" as const,
    messageId: "msg-0001",
  };
}

describe("the stage anchor requester", () => {
  it("invokes the linked AnchorWriter asynchronously with only the keys of the entries", async () => {
    const lambda = mockClient(LambdaClient);
    lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
    const kit = complaintsKit();
    const requester = lambdaAnchorRequester(kit.log, new LambdaClient({ region: "us-east-1" }));
    await requester.request({ worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 1, pk: "W#demo#REG#e1", sk: "000000001" }] });
    const input = lambda.commandCalls(InvokeCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ FunctionName: "reclamo-poc-AnchorWriter", InvocationType: "Event" });
    expect(JSON.parse(new TextDecoder().decode(input?.Payload as Uint8Array))).toEqual({ worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 1, pk: "W#demo#REG#e1", sk: "000000001" }] });
    lambda.restore();
  });

  it("refuses a request that carries a hash or more than 100 entries", async () => {
    const kit = complaintsKit();
    const requester = lambdaAnchorRequester(kit.log, new LambdaClient({ region: "us-east-1" }));
    await expect(requester.request({ worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 1, pk: "p", sk: "s", hash: "h" } as never] })).rejects.toThrow();
    const many = Array.from({ length: 101 }, (_, index) => ({ seq: index + 1, pk: "p", sk: String(index) }));
    await expect(requester.request({ worldId: "demo", epoch: 1, chain: "REG", entries: many })).rejects.toThrow();
  });
});
