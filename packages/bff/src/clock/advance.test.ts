// advance_clock (docs/architecture.md §10, FL-082): the moves, the order of the fires (dueAtSim, seq) at
// their own simulated instant, the clock that never goes back, the console's WORLD_BUSY gate, a running
// world's resynchronization and the story's first "Avanzar al próximo evento" (FL-017).
import { describe, expect, it } from "vitest";
import { TEST_NOW, complaint } from "../connector/testing";
import { START_SIM, timersKit } from "../timers/testing";
import { advanceClock } from "./advance";
import { WorldBusyError } from "./busy";
import { setRunning } from "./running";
import { EVENT_MAX_LIFE_MS, inFlightToken } from "../worker/events";
import { QUEUE_VISIBILITY_TIMEOUT_SECONDS } from "../worker/queue-limits";

type Kit = ReturnType<typeof timersKit>;

const MINUTE = 60_000;
const QA = { actor: "QA" as const };
const CONSOLE = { actor: "OPERATOR:stf-operator" as const, gate: { force: false } };
const follow = (timerId: string, dueAtSim: string, seq = 0) => ({ kind: "FOLLOW_UP" as const, timerId, dueAtSim, seq, ownerKey: "CMP#cmp-0001", payload: { complaintId: "cmp-0001", customerId: "cus-0001" } });

async function seeded(kit: Kit): Promise<void> {
  await kit.seedWorld("demo", START_SIM);
  await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo", { status: "AWAITING_NETWORK" }))]);
}

async function simNowOf(kit: Kit): Promise<string | undefined> {
  return (await kit.connector.runtime.getClock("demo"))?.pausedSimNow;
}

describe("moves of a paused world [FL-082]", () => {
  it("[FL-082] fires what fell due in dueAtSim and seq order, firedBy CLOCK at each one's own instant", async () => {
    const kit = timersKit();
    await seeded(kit);
    await kit.putTimers("demo", follow("f-3", "2026-10-07T10:40:00-03:00"), follow("f-2", "2026-10-07T10:30:00-03:00", 2), follow("f-1", "2026-10-07T10:30:00-03:00", 1), follow("f-late", "2026-10-07T12:00:00-03:00"));
    const moved = await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 60 }, caller: QA }, kit.deps);
    expect(moved).toMatchObject({ mode: "PAUSED", fromSim: START_SIM, simNow: "2026-10-07T11:10:00-03:00" });
    expect(moved.fired.map((ref) => [ref.timerId, ref.status])).toEqual([
      ["f-1", "FIRED"],
      ["f-2", "FIRED"],
      ["f-3", "FIRED"],
    ]);
    expect(kit.events.map((event) => event.eventAtSim)).toEqual(["2026-10-07T10:30:00-03:00", "2026-10-07T10:30:00-03:00", "2026-10-07T10:40:00-03:00"]);
    expect(await kit.getTimer("demo", "FOLLOW_UP", "f-1")).toMatchObject({ status: "FIRED", firedBy: "CLOCK", firedAtSim: "2026-10-07T10:30:00-03:00" });
    expect((await kit.getTimer("demo", "FOLLOW_UP", "f-late"))?.status).toBe("SCHEDULED");
    expect(await simNowOf(kit)).toBe("2026-10-07T11:10:00-03:00");
    expect(await kit.connector.audit.listByAction("demo", "CLOCK_ADVANCED")).toEqual([expect.objectContaining({ actor: "QA", detail: expect.objectContaining({ move: "advance", fired: 3 }) })]);
  });

  it("[FL-082] never goes back and never jumps more than 20 days; an invalid move changes nothing", async () => {
    const kit = timersKit();
    await seeded(kit);
    const refusals = [
      { kind: "advanceTo" as const, to: "2026-10-07T09:00:00-03:00", reason: "CLOCK_BACKWARDS" },
      { kind: "advanceTo" as const, to: "2026-10-28T10:10:00-03:00", reason: "CLOCK_MOVE_TOO_LONG" },
      { kind: "advanceTo" as const, to: "not a date", reason: "CLOCK_INVALID_MOVE" },
    ];
    for (const { reason, ...move } of refusals) await expect(advanceClock({ worldId: "demo", move, caller: QA }, kit.deps)).rejects.toMatchObject({ code: "INVALID", reason });
    await expect(advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 0 }, caller: QA }, kit.deps)).rejects.toMatchObject({ code: "INVALID" });
    await expect(advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 20 * 24 * 60 + 1 }, caller: QA }, kit.deps)).rejects.toMatchObject({ reason: "CLOCK_MOVE_TOO_LONG" });
    expect(await simNowOf(kit)).toBe(START_SIM);
    const moved = await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 20 * 24 * 60 }, caller: QA }, kit.deps);
    expect(moved.simNow).toBe("2026-10-27T10:10:00-03:00");
  });

  it("[FL-082] advanceToNext() goes to the next timer and takes along those due within 5 simulated minutes", async () => {
    const kit = timersKit();
    await seeded(kit);
    await kit.putTimers("demo", follow("f-a", "2026-10-08T09:00:00-03:00"), follow("f-b", "2026-10-08T09:04:00-03:00"), follow("f-c", "2026-10-08T09:06:00-03:00"));
    const moved = await advanceClock({ worldId: "demo", move: { kind: "advanceToNext" }, caller: QA }, kit.deps);
    expect(moved.simNow).toBe("2026-10-08T09:04:00-03:00");
    expect(moved.fired.map((ref) => ref.timerId)).toEqual(["f-a", "f-b"]);
    expect((await kit.getTimer("demo", "FOLLOW_UP", "f-c"))?.status).toBe("SCHEDULED");
  });

  it("[FL-082] advanceToNext({complaintId}) stops at that complaint's next timer, firing in order what falls due before", async () => {
    const kit = timersKit();
    await seeded(kit);
    await kit.putTimers(
      "demo",
      { ...follow("other", "2026-10-08T09:00:00-03:00"), ownerKey: "CMP#cmp-0002" },
      { kind: "SLA", timerId: "cmp-0001-OPERATOR_REMINDER", dueAtSim: "2026-10-14T10:00:00-03:00", ownerKey: "CMP#cmp-0001", payload: { milestone: "OPERATOR_REMINDER", complaintId: "cmp-0001", complaintNumber: "R-2026-000123", deadlineSim: "2026-10-21T23:59:59-03:00" } },
      { ...follow("after", "2026-10-14T10:02:00-03:00"), ownerKey: "CMP#cmp-0002" },
    );
    const moved = await advanceClock({ worldId: "demo", move: { kind: "advanceToNext", complaintId: "cmp-0001" }, caller: QA }, kit.deps);
    expect(moved.simNow).toBe("2026-10-14T10:00:00-03:00");
    expect(moved.fired.map((ref) => ref.timerId)).toEqual(["other", "cmp-0001-OPERATOR_REMINDER"]);
    expect((await kit.getTimer("demo", "FOLLOW_UP", "after"))?.status).toBe("SCHEDULED");
    await expect(advanceClock({ worldId: "demo", move: { kind: "advanceToNext", complaintId: "cmp-0009" }, caller: QA }, kit.deps)).rejects.toMatchObject({ reason: "CLOCK_NOTHING_PENDING" });
  });

  it("[FL-082] advanceBusinessDay() keeps the local time and skips the weekend and the holidays", async () => {
    const kit = timersKit();
    await kit.seedWorld("demo", "2026-10-09T10:10:00-03:00");
    const moved = await advanceClock({ worldId: "demo", move: { kind: "advanceBusinessDay" }, caller: QA }, { ...kit.deps, holidays: async () => ["2026-10-12"] });
    expect(moved.simNow).toBe("2026-10-13T10:10:00-03:00");
  });

  it("[FL-017] one advanceToNext() from the start of the story publishes NORTE 08:30 and fires its recheck along (never left for another move)", async () => {
    const kit = timersKit();
    await kit.seedWorld("demo", START_SIM);
    await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo", { status: "AWAITING_SETTLEMENT" }))]);
    await kit.putTimers(
      "demo",
      { kind: "SETTLEMENT_PUBLISH", timerId: "NORTE-2026-10-07", dueAtSim: "2026-10-08T08:30:00-03:00", ownerKey: "BATCH#NORTE#2026-10-07", payload: { network: "NORTE", businessDate: "2026-10-07" } },
      { kind: "SETTLEMENT_RECHECK", timerId: "rck-cmp-0001", dueAtSim: "2026-10-08T10:30:00-03:00", seq: 1, ownerKey: "BATCH#NORTE#2026-10-07", payload: { complaintId: "cmp-0001" } },
      { kind: "SETTLEMENT_PUBLISH", timerId: "SUR-2026-10-06", dueAtSim: "2026-10-08T11:00:00-03:00", seq: 2, ownerKey: "BATCH#SUR#2026-10-06", payload: { network: "SUR", businessDate: "2026-10-06" } },
    );
    const moved = await advanceClock({ worldId: "demo", move: { kind: "advanceToNext" }, caller: CONSOLE }, kit.deps);
    expect(moved.simNow).toBe("2026-10-08T08:30:00-03:00");
    expect(moved.fired.map((ref) => ref.timerId)).toEqual(["NORTE-2026-10-07"]);
    expect(await kit.getTimer("demo", "SETTLEMENT_RECHECK", "rck-cmp-0001")).toMatchObject({ status: "FIRED", firedBy: "PUBLICATION", firedAtSim: "2026-10-08T08:30:00-03:00" });
    expect(kit.events).toEqual([expect.objectContaining({ type: "SETTLEMENT_PUBLISHED", eventAtSim: "2026-10-08T08:30:00-03:00", payload: { complaintId: "cmp-0001", batchKey: "BATCH#NORTE#2026-10-07" } })]);
    expect((await kit.getTimer("demo", "SETTLEMENT_PUBLISH", "SUR-2026-10-06"))?.status).toBe("SCHEDULED");
  });
});

describe("WORLD_BUSY from the console [FL-082]", () => {
  async function busy(kit: Kit): Promise<void> {
    await seeded(kit);
    await kit.connector.write(kit.connector.runtime.addInFlightOp("demo", "cus-0001#evt-0001"));
  }

  it("[FL-082] a busy world does not move: the answer lists what it waits for", async () => {
    const kit = timersKit();
    await busy(kit);
    const error = await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 60 }, caller: CONSOLE }, kit.deps).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(WorldBusyError);
    expect(error).toMatchObject({ code: "CONFLICT", reason: "WORLD_BUSY", pending: [expect.objectContaining({ kind: "EVENT", detail: "evt-0001" })] });
    expect(await simNowOf(kit)).toBe(START_SIM);
  });

  it("[FL-082] an event waiting for its redelivery keeps the world busy past ten minutes, with no force and no audit", async () => {
    const kit = timersKit();
    await seeded(kit);
    await kit.connector.write(kit.connector.runtime.addInFlightOp("demo", inFlightToken({ customerId: "cus-0001", eventId: "evt-throttled" }, kit.deps.realNow())));
    kit.passReal(QUEUE_VISIBILITY_TIMEOUT_SECONDS * 1000 - MINUTE);
    const error = await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 60 }, caller: CONSOLE }, kit.deps).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ reason: "WORLD_BUSY", pending: [expect.objectContaining({ kind: "EVENT", detail: "evt-throttled", stale: false })] });
    expect(await simNowOf(kit)).toBe(START_SIM);
    expect(await kit.connector.audit.listByAction("demo", "CLOCK_FORCED")).toEqual([]);
    kit.passReal(EVENT_MAX_LIFE_MS);
    expect((await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 60 }, caller: CONSOLE }, kit.deps)).forced).toBe(false);
  });

  it("[FL-082] force is refused before five minutes and accepted after them, audited CLOCK_FORCED", async () => {
    const kit = timersKit();
    await busy(kit);
    const forced = { ...CONSOLE, gate: { force: true } };
    await expect(advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 60 }, caller: forced }, kit.deps)).rejects.toBeInstanceOf(WorldBusyError);
    kit.passReal(5 * MINUTE + 1);
    const moved = await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 60 }, caller: forced }, kit.deps);
    expect(moved.forced).toBe(true);
    expect(await kit.connector.audit.listByAction("demo", "CLOCK_FORCED")).toEqual([expect.objectContaining({ actor: "OPERATOR:stf-operator" })]);
  });

  it("[FL-082] a due timer makes the world busy; a pending email older than 10 minutes no longer does; the QaDriver passes no gate", async () => {
    const kit = timersKit();
    await seeded(kit);
    await kit.putTimers("demo", follow("due", "2026-10-07T10:00:00-03:00"));
    await expect(advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 5 }, caller: CONSOLE }, kit.deps)).rejects.toMatchObject({ pending: [expect.objectContaining({ kind: "TIMER" })] });
    expect((await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 5 }, caller: QA }, kit.deps)).fired).toHaveLength(1);
    await kit.connector.write(kit.connector.runtime.openPendingOp({ worldId: "demo", kind: "MAIL", pendingId: "mail-0001", openedAtReal: new Date(TEST_NOW.getTime() - 11 * MINUTE).toISOString() }));
    expect((await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 5 }, caller: CONSOLE }, kit.deps)).simNow).toBe("2026-10-07T10:20:00-03:00");
  });
});

describe("moves of a running world [FL-082]", () => {
  it("[FL-082] keeps the rate, moves the anchor and puts every schedule again at its new real instant", async () => {
    const kit = timersKit();
    await seeded(kit);
    // At rate 60 (an hour per real minute), 3 and 10 simulated hours are 3 and 10 real minutes away.
    await kit.putTimers("demo", follow("f-1", "2026-10-07T13:10:00-03:00"), follow("f-2", "2026-10-07T20:10:00-03:00", 1));
    await setRunning({ worldId: "demo", rate: 60, caller: QA }, kit.deps);
    expect(kit.scheduler.live.size).toBe(2);
    const first = kit.scheduler.puts.find((spec) => spec.input.timerKey.endsWith("f-2"));
    expect(first?.at.toISOString()).toBe(new Date(TEST_NOW.getTime() + 10 * MINUTE).toISOString());
    const moved = await advanceClock({ worldId: "demo", move: { kind: "advance", minutes: 5 * 60 }, caller: QA }, kit.deps);
    expect(moved).toMatchObject({ mode: "RUNNING", simNow: "2026-10-07T15:10:00-03:00" });
    expect(moved.fired.map((ref) => [ref.timerId, ref.status])).toEqual([["f-1", "FIRED"]]);
    expect(await kit.getTimer("demo", "FOLLOW_UP", "f-1")).toMatchObject({ firedBy: "CLOCK", firedAtSim: "2026-10-07T13:10:00-03:00" });
    expect(await kit.connector.runtime.getClock("demo")).toMatchObject({ mode: "RUNNING", rate: 60, anchorSim: "2026-10-07T15:10:00-03:00", anchorReal: TEST_NOW.toISOString() });
    const live = [...kit.scheduler.live.values()];
    expect(live.map((spec) => [spec.input.timerKey.split("#").at(-1), spec.at.toISOString()])).toEqual([["f-2", new Date(TEST_NOW.getTime() + 5 * MINUTE).toISOString()]]);
  });
});
