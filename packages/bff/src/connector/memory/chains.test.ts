// The append-only chains over the memory connector (docs/architecture.md §8.3, ADR-0014): the head
// and the entry commit together or not at all, a cancelled append consumes no `seq`, entries are
// only ever put, and the tape is readable by day, complaint, decision, message and `seq`.
import { describe, expect, it } from "vitest";
import { TransactionCancelledError } from "../errors";
import { SIM_NOW, auditEntry, complaint, registerEntry, tapeEntry, testConnector, testHash } from "../testing";

describe("register chain", () => {
  it("appends the first entry against an absent head and the next against the head it read", async () => {
    const { connector, store } = testConnector();
    expect(await connector.chains.readHead("demo", 1, "REG")).toBeUndefined();
    const first = await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry("demo", 1) });
    expect(first).toEqual({ chain: "REG", worldId: "demo", epoch: 1, seq: 1, pk: "W#demo#REG#e1", sk: "000000001", hash: testHash(1) });
    const head = await connector.chains.readHead("demo", 1, "REG");
    expect(head).toEqual({ value: 1, hash: testHash(1) });
    await connector.chains.append({ chain: "REG", head, entry: registerEntry("demo", 2) });
    expect(await connector.chains.readHead("demo", 1, "REG")).toEqual({ value: 2, hash: testHash(2) });
    const { entries } = await connector.chains.listRegister("REG", "demo", 1);
    expect(entries.map((entry) => [entry.seq, entry.eventType])).toEqual([
      [1, "FILED"],
      [2, "STATUS"],
    ]);
    expect(store.dump("Register").every((row) => typeof row.expiresAt === "number")).toBe(true);
    expect(await connector.chains.getEntry("REG", { pk: "W#demo#REG#e1", sk: "000000002" })).toMatchObject({ seq: 2, prevHash: testHash(1) });
  });

  it("cancels an append against a head that moved, without writing anything or consuming a seq", async () => {
    const { connector, store } = testConnector();
    await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry("demo", 1) });
    // Two writers read the same head; the second one loses the race.
    const stale = { value: 1, hash: testHash(1) };
    await connector.chains.append({ chain: "REG", head: stale, entry: registerEntry("demo", 2) });
    const error = await connector.chains.append({ chain: "REG", head: stale, entry: registerEntry("demo", 2, { eventType: "FINAL_ANSWER" }) }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionCancelledError);
    expect((error as TransactionCancelledError).failedConditions()).toEqual([0, 1]);
    expect(store.dump("Register").map((row) => row.sk)).toEqual(["000000001", "000000002"]);
    expect(await connector.chains.readHead("demo", 1, "REG")).toEqual({ value: 2, hash: testHash(2) });
  });

  it("cancels head and entry when the caller's own condition fails after reading the head (no gap)", async () => {
    const { connector, store } = testConnector();
    await connector.transact([connector.complaints.createOp(complaint("demo"))]);
    // The complaint moved on (version 2) after the caller read version 1 and the head.
    await connector.complaints.patch("demo", "cmp-0001", 1, { priority: "HIGH" });
    const transition = connector.complaints.transitionOp({
      worldId: "demo",
      complaintId: "cmp-0001",
      version: 1,
      allowedFrom: ["REGISTERED"],
      to: "INVESTIGATING",
      change: { from: "REGISTERED", to: "INVESTIGATING", atSim: SIM_NOW, cause: "IDENTIFIED", actor: "AGENT" },
    });
    const error = await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry("demo", 1), extra: [transition] }).catch((thrown: unknown) => thrown);
    expect((error as TransactionCancelledError).failedConditions()).toEqual([2]);
    expect(await connector.chains.readHead("demo", 1, "REG")).toBeUndefined();
    expect(store.dump("Register")).toEqual([]);
    // Re-read and retry: the same seq 1 is still free.
    const retry = connector.complaints.transitionOp({
      worldId: "demo",
      complaintId: "cmp-0001",
      version: 2,
      allowedFrom: ["REGISTERED"],
      to: "INVESTIGATING",
      change: { from: "REGISTERED", to: "INVESTIGATING", atSim: SIM_NOW, cause: "IDENTIFIED", actor: "AGENT" },
    });
    await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry("demo", 1), extra: [retry] });
    expect(await connector.complaints.get("demo", "cmp-0001")).toMatchObject({ status: "INVESTIGATING", version: 3 });
  });

  it("refuses an entry that does not follow the head it names", async () => {
    const { connector } = testConnector();
    expect(() => connector.chains.appendOps({ chain: "REG", head: undefined, entry: registerEntry("demo", 2) })).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    expect(() => connector.chains.appendOps({ chain: "REG", head: { value: 1, hash: testHash(9) }, entry: registerEntry("demo", 2) })).toThrow(
      expect.objectContaining({ code: "VALIDATION" }),
    );
  });

  it("keeps epochs and worlds in their own partitions and indexes entries by complaint", async () => {
    const { connector } = testConnector();
    await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry("demo", 1) });
    await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry("demo", 1, { epoch: 2 }) });
    await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry("g01", 1) });
    expect((await connector.chains.listRegister("REG", "demo", 2)).entries).toHaveLength(1);
    expect((await connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).map((entry) => entry.worldId)).toEqual(["demo"]);
    expect(await connector.chains.readHead("g01", 1, "REG")).toEqual({ value: 1, hash: testHash(1) });
  });

  it("keeps the refund register as its own chain", async () => {
    const { connector } = testConnector();
    const refund = {
      worldId: "demo",
      epoch: 1,
      seq: 1,
      prevHash: "",
      hash: testHash(1),
      atSim: SIM_NOW,
      atReal: "2026-10-07T13:10:00Z",
      customerId: "cus-0003",
      actionId: "act-9",
      cause: "REFUND_DUPLICATE" as const,
      product: "LOAN",
      amountCents: 4_500_000,
      interestCents: 0,
    };
    const appended = await connector.chains.append({ chain: "RRI", head: undefined, entry: refund });
    expect(appended.pk).toBe("W#demo#RRI#e1");
    expect(await connector.chains.readHead("demo", 1, "REG")).toBeUndefined();
    expect((await connector.chains.listRegister("RRI", "demo", 1)).entries[0]).toMatchObject({ amountCents: 4_500_000 });
  });
});

describe("compliance tape", () => {
  it("files each decision by simulated day and indexes it by complaint, decision, message and seq", async () => {
    const { connector } = testConnector();
    await connector.chains.append({ chain: "TAPE", head: undefined, entry: tapeEntry("demo", 1) });
    const head = await connector.chains.readHead("demo", 1, "TAPE");
    const blocked = await connector.chains.append({
      chain: "TAPE",
      head,
      entry: tapeEntry("demo", 2, { decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"], sender: "OPERATOR:stf-lucia", kind: "COLLECTION_REMINDER", atSim: "2026-10-07T23:30:00-03:00" }),
    });
    // 23:30 in Argentina is the next day in UTC: the tape keeps the Argentine date.
    expect(blocked.pk).toBe("W#demo#TAPE#2026-10-07");
    expect((await connector.chains.listTapeDay("demo", "2026-10-07")).entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect((await connector.chains.listTapeByDecision("demo", "BLOCKED")).map((entry) => entry.ruleIds)).toEqual([["CH-WA-NO-COLLECTION"]]);
    expect((await connector.chains.listTapeByComplaint("demo", "cmp-0001")).map((entry) => entry.seq)).toEqual([2, 1]);
    expect((await connector.chains.listTapeByMessage("msg-2")).map((entry) => entry.decision)).toEqual(["BLOCKED"]);
    expect((await connector.chains.listTapeBySeq("demo", 1, { fromSeq: 2 })).entries.map((entry) => entry.seq)).toEqual([2]);
  });
});

describe("audit log", () => {
  it("puts an entry once, never overwrites it, and lists it by action and by ref", async () => {
    const { connector, store } = testConnector();
    await connector.audit.append(auditEntry("demo"));
    await expect(connector.audit.append(auditEntry("demo"))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.audit.append(auditEntry("demo", { auditId: "aud-0002", action: "DENY", primaryRef: undefined }));
    expect(store.dump("AuditLog").map((row) => row.pk)).toEqual(["W#demo#AUD#e1#2026-10", "W#demo#AUD#e1#2026-10"]);
    expect((await connector.audit.listByAction("demo", "DENY")).map((entry) => entry.auditId)).toEqual(["aud-0002"]);
    expect((await connector.audit.listByRef("demo", "CMP#cmp-0001")).map((entry) => entry.auditId)).toEqual(["aud-0001"]);
    expect((await connector.audit.listMonth("demo", 1, "2026-10")).entries).toHaveLength(2);
    // Twelve months in the demo world, 2 days in a QA world.
    expect(store.dump("AuditLog")[0]?.expiresAt).toBe(Math.floor(Date.parse("2026-10-07T13:10:00Z") / 1000) + 365 * 86_400);
    await connector.audit.append(auditEntry("qa-r1-sc01"));
    expect(store.dump("AuditLog").find((row) => row.worldId === "qa-r1-sc01")?.expiresAt).toBe(Math.floor(Date.parse("2026-10-07T13:10:00Z") / 1000) + 2 * 86_400);
  });

  it("commits an audit entry with the change it records, or neither", async () => {
    const { connector, store } = testConnector();
    await connector.worlds.register({ worldId: "demo", kind: "DEMO", template: "demo", epoch: 1, status: "REGISTERED" });
    await expect(
      connector.transact([connector.worlds.metaChangeOp({ worldId: "demo", from: "READY", to: "RESETTING" }), connector.audit.appendOp(auditEntry("demo", { action: "WORLD_RESET_REQUESTED" }))]),
    ).rejects.toBeInstanceOf(TransactionCancelledError);
    expect(store.dump("AuditLog")).toEqual([]);
  });
});
