// World runtime state over the memory connector: the demo clock (read by lib/clock.ts), events in
// flight and pending items (quiescence), tombstones, the kill switch, the epoch and complaint-number
// counters, and the reset and purge tickets `WorldJanitor` requires.
import { describe, expect, it } from "vitest";
import { worldClock } from "../../lib/clock";
import { TransactionCancelledError } from "../errors";
import { SIM_NOW, TEST_NOW, auditEntry, testConnector, worldMeta } from "../testing";

describe("clock", () => {
  it("stores the world clock and serves lib/clock.ts with its simulated now", async () => {
    const { connector } = testConnector();
    await connector.runtime.putClock({ worldId: "demo", mode: "PAUSED", pausedSimNow: SIM_NOW, worldEpoch: 1 });
    const clock = worldClock("demo", connector.runtime.clockState, { now: async () => TEST_NOW });
    expect((await clock.now()).toISOString()).toBe("2026-10-07T13:10:00.000Z");

    await connector.write(
      connector.runtime.updateClockOp("demo", 1, { mode: "RUNNING", anchorSim: SIM_NOW, anchorReal: "2026-10-07T13:10:00Z", rate: 1440 }, ["pausedSimNow"]),
    );
    const running = worldClock("demo", connector.runtime.clockState, { now: async () => new Date("2026-10-07T13:11:00Z") });
    // One real minute at rate 1440 is one simulated day.
    expect((await running.now()).toISOString()).toBe("2026-10-08T13:10:00.000Z");
    await expect(connector.write(connector.runtime.updateClockOp("demo", 1, { mode: "PAUSED" }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(connector.runtime.clockState("g01")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("quiescence", () => {
  it("tracks the events in flight and the pending emails and scans", async () => {
    const { connector } = testConnector();
    expect(await connector.runtime.getWorldState("demo")).toEqual({ worldId: "demo", inFlight: [] });
    await connector.write(connector.runtime.addInFlightOp("demo", "cus-0001#evt-1"));
    await connector.write(connector.runtime.addInFlightOp("demo", "cus-0002#evt-2"));
    await connector.write(connector.runtime.removeInFlightOp("demo", "cus-0001#evt-1"));
    expect((await connector.runtime.getWorldState("demo")).inFlight).toEqual(["cus-0002#evt-2"]);
    await connector.write(connector.runtime.removeInFlightOp("demo", "cus-0002#evt-2"));
    expect((await connector.runtime.getWorldState("demo")).inFlight).toEqual([]);

    await connector.write(connector.runtime.openPendingOp({ worldId: "demo", kind: "MAIL", pendingId: "mail-1", openedAtReal: TEST_NOW.toISOString(), customerId: "cus-0001" }));
    await connector.write(connector.runtime.openPendingOp({ worldId: "demo", kind: "SCAN", pendingId: "0a1b2c3d", openedAtReal: TEST_NOW.toISOString() }));
    expect((await connector.runtime.listPending("demo")).map((row) => `${row.kind}:${row.pendingId}`)).toEqual(["MAIL:mail-1", "SCAN:0a1b2c3d"]);
    await connector.write(connector.runtime.closePendingOp("demo", "MAIL", "mail-1"));
    await connector.write(connector.runtime.closePendingOp("demo", "MAIL", "mail-1"));
    expect((await connector.runtime.listPending("demo")).map((row) => row.kind)).toEqual(["SCAN"]);
  });

  it("never recreates a missing WORLDSTATE row when the worker removes its token", async () => {
    const { connector, store } = testConnector();
    // A reset wipe or a destruction removed the row while the event was being processed.
    expect(await connector.runtime.removeInFlight("demo", "cus-0001#evt-1")).toBe(false);
    expect(store.dump("Runtime")).toEqual([]);
    expect(await connector.runtime.getWorldState("demo")).toEqual({ worldId: "demo", inFlight: [] });
    await expect(connector.write(connector.runtime.removeInFlightOp("demo", "cus-0001#evt-1"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.dump("Runtime")).toEqual([]);

    await connector.write(connector.runtime.addInFlightOp("demo", "cus-0001#evt-1"));
    expect(await connector.runtime.removeInFlight("demo", "cus-0001#evt-1")).toBe(true);
    expect(await connector.runtime.getWorldState("demo")).toMatchObject({ worldId: "demo", inFlight: [] });
  });

  it("writes a tombstone once per epoch", async () => {
    const { connector } = testConnector();
    await connector.write(connector.runtime.putTombstoneOp({ worldId: "qa-r1-sc01", epoch: 1, reason: "DESTROY", atReal: TEST_NOW.toISOString() }));
    await expect(connector.write(connector.runtime.putTombstoneOp({ worldId: "qa-r1-sc01", epoch: 1, reason: "RESET", atReal: TEST_NOW.toISOString() }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.runtime.getTombstone("qa-r1-sc01", 1)).toMatchObject({ reason: "DESTROY" });
    expect(await connector.runtime.getTombstone("qa-r1-sc01", 2)).toBeUndefined();
  });
});

describe("kill switch", () => {
  it("cuts the agent globally or for one world, without a deploy", async () => {
    const { connector, store } = testConnector();
    expect(await connector.runtime.isAgentKilled("demo")).toBe(false);
    await connector.runtime.setKill({ worldId: "qa-r1-sc19", on: true, by: "QA", atReal: TEST_NOW.toISOString() });
    expect(await connector.runtime.isAgentKilled("qa-r1-sc19")).toBe(true);
    expect(await connector.runtime.isAgentKilled("demo")).toBe(false);
    await connector.runtime.setKill({ on: true, by: "BUDGET", atReal: TEST_NOW.toISOString(), reason: "budget at 100%" });
    expect(await connector.runtime.isAgentKilled("demo")).toBe(true);
    expect(store.dump("Runtime").map((row) => row.pk).sort()).toEqual(["KILL#AGENT", "W#qa-r1-sc19#KILL"]);
    await connector.runtime.setKill({ on: false, by: "OPERATOR:stf-tomas", atReal: TEST_NOW.toISOString() });
    await connector.runtime.setKill({ worldId: "qa-r1-sc19", on: false, by: "QA", atReal: TEST_NOW.toISOString() });
    expect(await connector.runtime.isAgentKilled("qa-r1-sc19")).toBe(false);
  });
});

describe("counters", () => {
  it("moves the epoch forward only from the value read, and never expires it", async () => {
    const { connector, store } = testConnector();
    expect(await connector.counters.getEpoch("g01")).toBe(0);
    await connector.write(connector.counters.initEpochOp("g01", 1));
    await expect(connector.write(connector.counters.initEpochOp("g01", 1))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.write(connector.counters.advanceEpochOp("g01", 1));
    await expect(connector.write(connector.counters.advanceEpochOp("g01", 1))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.counters.getEpoch("g01")).toBe(2);
    expect(store.dump("Runtime")[0]?.expiresAt).toBeUndefined();
    expect(() => connector.counters.advanceEpochOp("g01", 0)).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });

  it("numbers complaints per world, epoch and year without gaps", async () => {
    const { connector } = testConnector();
    const current = await connector.counters.getComplaintCounter("demo", 1, 2026);
    expect(current).toBe(0);
    await connector.transact([connector.counters.advanceComplaintCounterOp("demo", 1, 2026, current)]);
    // A writer that read 0 too loses: the number 1 is taken exactly once.
    await expect(connector.transact([connector.counters.advanceComplaintCounterOp("demo", 1, 2026, 0)])).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.transact([connector.counters.advanceComplaintCounterOp("demo", 1, 2026, 1)]);
    expect(await connector.counters.getComplaintCounter("demo", 1, 2026)).toBe(2);
    expect(await connector.counters.getComplaintCounter("demo", 1, 2027)).toBe(0);
    expect(await connector.counters.getComplaintCounter("demo", 2, 2026)).toBe(0);
  });
});

describe("tickets", () => {
  const leaseUntil = (minutes: number) => new Date(TEST_NOW.getTime() + minutes * 60_000).toISOString();

  it("lets one invocation claim a reset ticket while its lease lasts, and another after it expires", async () => {
    let now = TEST_NOW;
    const { connector } = testConnector({ now: () => now });
    await connector.write(connector.counters.openTicketOp({ worldId: "g03", kind: "RESETREQ", requestId: "req-1", openedAtReal: TEST_NOW.toISOString(), phase: "WIPE" }));
    expect(await connector.counters.claimTicket("g03", "PURGEREQ", "req-1", leaseUntil(14))).toBeUndefined();
    expect(await connector.counters.claimTicket("g03", "RESETREQ", "req-1", leaseUntil(14))).toMatchObject({ status: "CLAIMED", version: 2 });
    expect(await connector.counters.claimTicket("g03", "RESETREQ", "req-1", leaseUntil(14))).toBeUndefined();
    await connector.write(connector.counters.heartbeatTicketOp("g03", "RESETREQ", "req-1", leaseUntil(14), { phase: "RELOAD", detail: { cursor: "block-7" } }));
    now = new Date(TEST_NOW.getTime() + 15 * 60_000);
    expect(await connector.counters.claimTicket("g03", "RESETREQ", "req-1", leaseUntil(29))).toMatchObject({ status: "CLAIMED", phase: "RELOAD" });
    await connector.write(connector.counters.releaseTicketOp("g03", "RESETREQ", "req-1", { countAttempt: true }));
    expect(await connector.counters.getTicket("g03", "RESETREQ", "req-1")).toMatchObject({ status: "OPEN", attempts: 1 });
    await connector.counters.claimTicket("g03", "RESETREQ", "req-1", leaseUntil(44));
    await connector.write(connector.counters.completeTicketOp("g03", "RESETREQ", "req-1"));
    expect(await connector.counters.claimTicket("g03", "RESETREQ", "req-1", leaseUntil(59))).toBeUndefined();
  });

  it("has no ticket for a request nobody wrote", async () => {
    const { connector } = testConnector();
    expect(await connector.counters.getTicket("gprobe", "PURGEREQ", "invented")).toBeUndefined();
    expect(await connector.counters.claimTicket("gprobe", "PURGEREQ", "invented", TEST_NOW.toISOString())).toBeUndefined();
  });
});

describe("reset request", () => {
  it("commits READY → RESETTING, epoch e → e + 1, tombstone, ticket and audit entry together, or nothing", async () => {
    const { connector, store } = testConnector();
    await connector.worlds.register(worldMeta("g04", { status: "READY" }));
    await connector.write(connector.counters.initEpochOp("g04", 1));
    const at = TEST_NOW.toISOString();
    const request = () => [
      connector.worlds.metaChangeOp({
        worldId: "g04",
        from: "READY",
        to: "RESETTING",
        set: { reset: { requestId: "req-1", fromEpoch: 1, toEpoch: 2, phase: "WIPE", requestedAtReal: at, heartbeatAtReal: at, attempts: 0 } },
      }),
      connector.counters.advanceEpochOp("g04", 1),
      connector.runtime.putTombstoneOp({ worldId: "g04", epoch: 1, reason: "RESET", atReal: at }),
      connector.counters.openTicketOp({ worldId: "g04", kind: "RESETREQ", requestId: "req-1", openedAtReal: at, phase: "WIPE" }),
      connector.audit.appendOp(auditEntry("g04", { action: "WORLD_RESET_REQUESTED", auditId: "aud-reset-1" })),
    ];
    await connector.transact(request());
    expect(await connector.worlds.getMeta("g04")).toMatchObject({ status: "RESETTING", reset: { requestId: "req-1", toEpoch: 2 } });
    expect(await connector.counters.getEpoch("g04")).toBe(2);
    expect(await connector.counters.getTicket("g04", "RESETREQ", "req-1")).toMatchObject({ status: "OPEN" });
    // A second request on a world that is not READY writes nothing at all.
    const before = store.dump("Runtime").length;
    await expect(connector.transact(request())).rejects.toBeInstanceOf(TransactionCancelledError);
    expect(store.dump("Runtime")).toHaveLength(before);
    expect(store.dump("AuditLog")).toHaveLength(1);
  });
});
