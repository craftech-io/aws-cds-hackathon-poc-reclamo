// Timers over the memory connector (docs/architecture.md §10): the clock dispatches scheduled timers
// in `dueAtSim` and `seq` order, a fired or cancelled timer leaves that index, and a fire with a
// stale version or another epoch changes nothing.
import { describe, expect, it } from "vitest";
import { testConnector, timer } from "../testing";

const ref = { worldId: "demo", kind: "SLA", timerId: "cmp-0001-DEADLINE" };

describe("timers", () => {
  it("lists scheduled timers in due order, with a stable tie-break, up to an instant", async () => {
    const { connector } = testConnector();
    await connector.transact([
      connector.timers.putOp(timer("demo", { timerId: "late", dueAtSim: "2026-10-22T23:59:59-03:00" })),
      connector.timers.putOp(timer("demo", { timerId: "tie-b", dueAtSim: "2026-10-14T10:00:00-03:00", seq: 2 })),
      connector.timers.putOp(timer("demo", { timerId: "tie-a", dueAtSim: "2026-10-14T13:00:00Z", seq: 1 })),
      connector.timers.putOp(timer("demo", { timerId: "done", dueAtSim: "2026-10-08T10:00:00-03:00", status: "FIRED" })),
      connector.timers.putOp(timer("g01", { timerId: "other-world", dueAtSim: "2026-10-08T10:00:00-03:00" })),
    ]);
    expect((await connector.timers.listDue("demo")).map((row) => row.timerId)).toEqual(["tie-a", "tie-b", "late"]);
    expect((await connector.timers.listDue("demo", { untilSim: "2026-10-14T10:00:00-03:00" })).map((row) => row.timerId)).toEqual(["tie-a", "tie-b"]);
    expect((await connector.timers.next("demo"))?.timerId).toBe("tie-a");
    expect((await connector.timers.listByOwner("demo", "CMP#cmp-0001")).map((row) => row.timerId)).toEqual(["done", "tie-a", "tie-b", "late"]);
  });

  it("fires a timer once, on its version and epoch, and drops it from the clock's index", async () => {
    const { connector } = testConnector();
    await connector.timers.put(timer("demo"));
    const fire = { ...ref, version: 1, from: ["SCHEDULED"] as const, to: "FIRED" as const, epoch: 1, firedBy: "CLOCK" as const, firedAtSim: "2026-10-22T23:59:59-03:00" };
    await expect(connector.timers.transition({ ...fire, epoch: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    const fired = await connector.timers.transition(fire);
    expect(fired).toMatchObject({ status: "FIRED", version: 2, firedBy: "CLOCK" });
    await expect(connector.timers.transition(fire)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(connector.timers.transition({ ...fire, version: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.timers.listDue("demo")).toEqual([]);
    expect((await connector.timers.listByOwner("demo", "CMP#cmp-0001"))[0]?.status).toBe("FIRED");
  });

  it("cancels the milestones of a complaint and reschedules or records a schedule on the version read", async () => {
    const { connector } = testConnector();
    await connector.timers.put(timer("demo"));
    await connector.write(connector.timers.rescheduleOp({ ...ref, version: 1, scheduleName: "tm-demo-e1-abcdefghijklmnop" }));
    await connector.write(connector.timers.rescheduleOp({ ...ref, version: 2, due: { atSim: "2026-10-23T23:59:59-03:00", seq: 4 }, scheduleName: null }));
    const moved = await connector.timers.get(ref, { consistent: true });
    expect(moved).toMatchObject({ dueAtSim: "2026-10-23T23:59:59-03:00", seq: 4, version: 3 });
    expect(moved?.scheduleName).toBeUndefined();
    await connector.write(connector.timers.transitionOp({ ...ref, version: 3, from: ["SCHEDULED"], to: "CANCELLED", reason: "ANSWERED" }));
    await expect(connector.write(connector.timers.rescheduleOp({ ...ref, version: 4, scheduleName: "tm-demo-e1-x" }))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reads a timer by the key a schedule carries, only within the world it names", async () => {
    const { connector } = testConnector();
    await connector.timers.put(timer("demo"));
    const timerKey = connector.timers.timerKey(ref);
    expect(timerKey).toBe("W#demo#TIMER#SLA#cmp-0001-DEADLINE");
    expect((await connector.timers.getByKey("demo", timerKey))?.timerId).toBe("cmp-0001-DEADLINE");
    await expect(connector.timers.getByKey("g01", timerKey)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(connector.timers.getByKey("demo", "W#demo#TIMER#SLA#x#y")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("writes a new timer once, or rewrites it idempotently for the factory", async () => {
    const { connector } = testConnector();
    await connector.timers.put(timer("qa-r1-sc15"));
    await expect(connector.timers.put(timer("qa-r1-sc15"))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.timers.put(timer("qa-r1-sc15"), { replace: true });
    expect(await connector.timers.get({ ...ref, worldId: "qa-r1-sc15" })).toMatchObject({ version: 1, status: "SCHEDULED" });
  });
});
