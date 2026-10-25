// The world factory's raw items and a reset's wipe over the memory connector (docs/architecture.md
// §10): a wipe through `WorldIndex` removes the world's mutable rows and nothing else — never the
// world's META, SETTINGS or staff, the append-only records, the epoch, tombstones, tickets or caps.
import { describe, expect, it } from "vitest";
import { TransactionCancelledError } from "../errors";
import { WORLD_INDEXED_TABLES } from "../repos/world-items";
import { TEST_NOW, auditEntry, complaint, conversation, registerEntry, staff, testConnector, timer, worldMeta, worldSettings } from "../testing";

const coreItem = (worldId: string, sk: string) => ({ pk: `W#${worldId}#CUS#cus-0001`, sk, entity: "Customer", phoneHash: "ph-1" });

async function populatedWorld(worldId: string) {
  const setup = testConnector();
  const { connector } = setup;
  await connector.worlds.register(worldMeta(worldId, { status: "RESETTING" }));
  await connector.worlds.putSettings(worldSettings(worldId));
  await connector.worlds.putStaff(staff(worldId, "stf-guest-01", "sub-1"));
  await connector.worldItems.put("Core", worldId, [coreItem(worldId, "META"), coreItem(worldId, "ACCOUNT")]);
  await connector.transact([connector.complaints.createOp(complaint(worldId)), connector.timers.putOp(timer(worldId)), connector.conversations.createOp(conversation(worldId))]);
  await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry(worldId, 1) });
  await connector.audit.append(auditEntry(worldId));
  await connector.write(connector.counters.initEpochOp(worldId, 1));
  await connector.caps.increment({ kind: "TURNCAP", worldId, window: "DAY", at: TEST_NOW }, 150);
  await connector.runtime.putClock({ worldId, mode: "PAUSED", pausedSimNow: "2026-10-07T10:10:00-03:00", worldEpoch: 1 });
  await connector.worldItems.put("Core", "g02", [coreItem("g02", "META")]);
  return setup;
}

describe("world items", () => {
  it("writes template items idempotently, stamped with the world, WorldIndex and retention", async () => {
    const { connector, store } = testConnector();
    await connector.worldItems.put("Core", "qa-r1-sc01", [coreItem("qa-r1-sc01", "META")]);
    await connector.worldItems.put("Core", "qa-r1-sc01", [coreItem("qa-r1-sc01", "META")]);
    expect(store.dump("Core")).toEqual([
      expect.objectContaining({
        pk: "W#qa-r1-sc01#CUS#cus-0001",
        entity: "Customer",
        worldId: "qa-r1-sc01",
        worldIndexKey: "W#qa-r1-sc01#",
        worldIndexSort: "W#qa-r1-sc01#CUS#cus-0001|META",
        expiresAt: Math.floor(TEST_NOW.getTime() / 1000) + 2 * 86_400,
      }),
    ]);
  });

  it("refuses items outside the world, without an entity, and every protected table or runtime item", async () => {
    const { connector } = testConnector();
    await expect(connector.worldItems.put("Core", "g01", [coreItem("g02", "META")])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(connector.worldItems.put("Core", "g01", [{ pk: "W#g01#CUS#x", sk: "META" }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(connector.worldItems.put("Core", "g01", [{ ...coreItem("g01", "META"), worldId: "g02" }])).rejects.toMatchObject({ code: "VALIDATION" });
    for (const table of ["Worlds", "Register", "ComplianceTape", "AuditLog", "Reference"] as const) {
      await expect(connector.worldItems.delete(table, "g01", [{ pk: "W#g01#WORLD", sk: "META" }]), table).rejects.toMatchObject({ code: "VALIDATION" });
    }
    for (const pk of ["W#g01#COUNTER#EPOCH", "W#g01#COUNTER#REGSEQ#e1", "W#g01#TOMB#1", "W#g01#RESETREQ#r", "W#g01#PURGEREQ#r", "W#g01#KILL", "W#g01#RATE#ph#2026-10-07T13", "W#g01#TURNCAP#2026-10-07", "W#g01#IMGCAP#c#d"]) {
      await expect(connector.worldItems.delete("Runtime", "g01", [{ pk, sk: "META" }]), pk).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await connector.worldItems.put("Runtime", "g01", [{ pk: "W#g01#CLOCK", sk: "META", entity: "Clock", mode: "PAUSED", pausedSimNow: "2026-10-07T10:10:00-03:00", worldEpoch: 2 }]);
    expect(await connector.runtime.getClock("g01")).toMatchObject({ worldEpoch: 2 });
  });

  it("wipes a world through WorldIndex and leaves what a reset must keep", async () => {
    const { connector, store } = await populatedWorld("g01");
    for (const table of WORLD_INDEXED_TABLES) {
      let cursor: string | undefined;
      do {
        const page = await connector.worldItems.listKeys(table, "g01", { limit: 1, ...(cursor ? { cursor } : {}) });
        if (page.keys.length > 0) await connector.worldItems.delete(table, "g01", page.keys);
        cursor = page.cursor;
      } while (cursor);
    }
    expect(store.dump("Complaints")).toEqual([]);
    expect(store.dump("Timers")).toEqual([]);
    expect(store.dump("Conversations")).toEqual([]);
    expect(store.dump("Core").map((row) => row.pk)).toEqual(["W#g02#CUS#cus-0001"]);
    expect(store.dump("Worlds").map((row) => row.sk)).toEqual(["META", "SETTINGS", "STAFF#stf-guest-01"]);
    expect(store.dump("Register")).toHaveLength(1);
    expect(store.dump("AuditLog")).toHaveLength(1);
    expect(await connector.counters.getEpoch("g01")).toBe(1);
    expect(await connector.caps.peek({ kind: "TURNCAP", worldId: "g01", window: "DAY", at: TEST_NOW })).toBe(1);
  });

  it("lets the factory rewrite typed rows idempotently while a live create never overwrites", async () => {
    const { connector } = testConnector();
    const rewrite = () => connector.transact([connector.complaints.createOp(complaint("demo"), { replace: true }), connector.caseItems.restoreApprovalOp({ worldId: "demo", complaintId: "cmp-0001", approvalId: "apr-9", action: "REVERSE_CHARGE", amountCents: 2_000_000, capTier: "OPERATOR", evidenceId: "evd-1", justification: "seed", requestedBy: "AGENT", requestedAtSim: "2026-10-01T10:00:00-03:00", decision: "APPROVED", decidedBy: "stf-lucia", decidedAtSim: "2026-10-01T11:00:00-03:00", epoch: 1, expiresAtSim: "2026-10-03T10:00:00-03:00" })]);
    await rewrite();
    await rewrite();
    await expect(connector.transact([connector.complaints.createOp(complaint("demo"))])).rejects.toBeInstanceOf(TransactionCancelledError);
    // A decided template approval is restored as it was, outside the pending index.
    expect(await connector.caseItems.getApproval("demo", "cmp-0001", "apr-9")).toMatchObject({ decision: "APPROVED" });
    expect(await connector.caseItems.listPendingApprovals("demo")).toEqual([]);
  });

  it("lists the keys of the world's metrics partition", async () => {
    const { connector } = testConnector();
    await connector.metrics.put({
      worldId: "qamin",
      source: "WORLD",
      runId: "run-1",
      complaintId: "cmp-0001",
      agentMode: "SCRIPTED",
      origin: "LIVE",
      humanActions: [],
      tokens: { in: 0, out: 0, cached: 0 },
      messages: { wa: 1, email: 1 },
    });
    expect((await connector.worldItems.listMetricsKeys("qamin")).keys).toEqual([{ pk: "W#qamin#METRICS", sk: "WORLD#run-1#cmp-0001" }]);
    expect((await connector.metrics.list("qamin", { source: "WORLD", runId: "run-1" })).map((row) => row.complaintId)).toEqual(["cmp-0001"]);
    expect(await connector.metrics.list("qamin", { source: "BATCH" })).toEqual([]);
  });
});
