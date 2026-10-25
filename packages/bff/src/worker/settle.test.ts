// How an event leaves the world's quiescence (docs/architecture.md §7 "Quiescencia", "Mundos destruidos",
// "Evento perdido"; FL-108): out of `inFlight` when done, discarded against its tombstone, and on its last
// failing delivery out of `inFlight` with `processError` and `EVENT_DEAD_LETTERED`, so an event in the
// dead letters never keeps a world busy.
import { describe, expect, it } from "vitest";
import { CUSTOMER, TEST_NOW, eventOf, workerKit } from "./testing";
import { DEAD_LETTER_METRIC, deadLetter, discardTombstoned, isTombstoned, settleEvent } from "./settle";
import { looseIdentity } from "./events";

const IDENTITY = { worldId: "demo", customerId: CUSTOMER, eventId: "evt-lost" };

describe("[FL-108] settling an event", () => {
  it("[FL-108] takes the event out of inFlight, and a wiped world's missing row is nothing to remove", async () => {
    const kit = await workerKit();
    await kit.connector.write(kit.connector.runtime.addInFlightOp("demo", `${CUSTOMER}#evt-lost`));
    expect(await settleEvent(kit.connector, IDENTITY)).toBe(true);
    expect((await kit.connector.runtime.getWorldState("demo")).inFlight).toEqual([]);
    expect(await settleEvent(kit.connector, { ...IDENTITY, worldId: "g07" })).toBe(false);
  });

  it("[FL-108] the last failing delivery leaves inFlight, records processError and audits EVENT_DEAD_LETTERED once", async () => {
    const kit = await workerKit();
    await kit.connector.write(kit.connector.runtime.addInFlightOp("demo", `${CUSTOMER}#evt-lost`));
    const log = kit.deps.loggerFor("corr-dead-letter");
    const identity = looseIdentity(JSON.stringify(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-x" }, { eventId: "evt-lost" })));
    await deadLetter({ data: kit.connector, now: kit.deps.now, log }, identity);
    await deadLetter({ data: kit.connector, now: kit.deps.now, log }, identity);
    expect((await kit.connector.runtime.getWorldState("demo")).inFlight).toEqual([]);
    expect((await kit.connector.conversations.getMeta("demo", CUSTOMER))?.processError).toEqual({ eventId: "evt-lost", type: "ANSWER_DUE", atReal: TEST_NOW.toISOString() });
    const audit = await kit.audited("EVENT_DEAD_LETTERED");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.refs).toMatchObject({ customerId: CUSTOMER, type: "ANSWER_DUE", eventId: "evt-lost" });
    expect(kit.lines.filter((line) => line.metric === DEAD_LETTER_METRIC)).toHaveLength(2);
  });

  it("[FL-108] a body without a world still counts the metric and writes nothing", async () => {
    const kit = await workerKit();
    await deadLetter({ data: kit.connector, now: kit.deps.now, log: kit.deps.loggerFor("corr-dead-letter") }, looseIdentity("not json"));
    expect(kit.lines.filter((line) => line.metric === DEAD_LETTER_METRIC)).toHaveLength(1);
    expect(await kit.audited("EVENT_DEAD_LETTERED")).toEqual([]);
  });

  it("[FL-108] never hides the event's own error: a failure while recording is only logged", async () => {
    const kit = await workerKit();
    const broken = { ...kit.connector, runtime: { ...kit.connector.runtime, removeInFlight: async () => Promise.reject(new Error("throttled")) } };
    await expect(deadLetter({ data: broken, now: kit.deps.now, log: kit.deps.loggerFor("corr-dead-letter") }, IDENTITY)).resolves.toBeUndefined();
    expect(kit.lines.some((line) => line.message === "event.dead_letter_record_failed")).toBe(true);
  });
});

describe("destroyed worlds and old epochs", () => {
  it("knows a tombstoned epoch, an epoch the world left behind and a world that is gone", async () => {
    const kit = await workerKit();
    expect(await isTombstoned(kit.connector, { worldId: "demo", epoch: 1 })).toBe(false);
    expect(await isTombstoned(kit.connector, { worldId: "demo", epoch: 2 })).toBe(true);
    expect(await isTombstoned(kit.connector, { worldId: "g07", epoch: 1 })).toBe(true);
    await kit.connector.write(kit.connector.runtime.putTombstoneOp({ worldId: "demo", epoch: 1, reason: "DESTROY", atReal: TEST_NOW.toISOString() }));
    expect(await isTombstoned(kit.connector, { worldId: "demo", epoch: 1 })).toBe(true);
  });

  it("discards a late event once, audited in the world's current epoch, and settles it", async () => {
    const kit = await workerKit();
    await kit.connector.write(kit.connector.runtime.addInFlightOp("demo", `${CUSTOMER}#evt-late`));
    const late = { worldId: "demo", customerId: CUSTOMER, eventId: "evt-late", epoch: 0, type: "TIMER", eventAtSim: "2026-10-07T10:10:00-03:00" };
    await discardTombstoned({ data: kit.connector, now: kit.deps.now, log: kit.deps.loggerFor("corr-late") }, late);
    await discardTombstoned({ data: kit.connector, now: kit.deps.now, log: kit.deps.loggerFor("corr-late") }, late);
    const audit = await kit.audited("TOMBSTONED_EVENT");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ epoch: 1, refs: expect.objectContaining({ eventEpoch: "0", type: "TIMER" }) });
    expect((await kit.connector.runtime.getWorldState("demo")).inFlight).toEqual([]);
  });
});
