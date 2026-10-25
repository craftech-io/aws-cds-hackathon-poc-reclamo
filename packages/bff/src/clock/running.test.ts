// "Reloj en vivo" (docs/architecture.md §10, FL-082): RUNNING at a validated rate for 30 real minutes,
// up to 50 schedules per world inside the next real hour (the next ones as the earlier fire), a timer
// within a minute fired at once, resynchronization on a change of rate, the pause that deletes every
// schedule and the automatic return to PAUSED.
import { describe, expect, it } from "vitest";
import { TEST_NOW } from "../connector/testing";
import { dispatchScheduled } from "../timers/dispatch";
import { MAX_SCHEDULES_PER_WORLD } from "../timers/resync";
import { scheduleNameOf } from "../timers/schedule-name";
import { START_SIM, timersKit } from "../timers/testing";
import { pause, refreshClock, setRunning, validRate } from "./running";

type Kit = ReturnType<typeof timersKit>;

const MINUTE = 60_000;
const QA = { actor: "QA" as const };
const CONSOLE = { actor: "OPERATOR:stf-operator" as const };
const simPlus = (minutes: number) => new Date(Date.parse(START_SIM) + minutes * MINUTE).toISOString();
const follow = (timerId: string, dueAtSim: string, seq = 0) => ({ kind: "FOLLOW_UP" as const, timerId, dueAtSim, seq, ownerKey: "CMP#cmp-0001", payload: { complaintId: "cmp-0001", customerId: "cus-0001" } });
const ARN = (name: string) => `arn:aws:scheduler:us-east-1:776805327629:schedule/aws-cds-hackathon-poc-reclamo-poc-schedules/${name}`;

async function world(kit: Kit, worldId = "demo"): Promise<void> {
  await kit.seedWorld(worldId, START_SIM);
}

describe("rate [FL-082]", () => {
  it("[FL-082] the console sets 1 to 2,880; only the QaDriver goes beyond, and only in a qa-* world", () => {
    expect(validRate(undefined, "demo", CONSOLE)).toBe(1_440);
    expect(validRate(1, "demo", CONSOLE)).toBe(1);
    expect(validRate(288, "g01", CONSOLE)).toBe(288);
    expect(validRate(2_880, "demo", CONSOLE)).toBe(2_880);
    for (const rate of [0, 2_881, 1.5, -3]) expect(() => validRate(rate, "demo", CONSOLE), String(rate)).toThrow(expect.objectContaining({ code: "INVALID", reason: "CLOCK_INVALID_RATE" }));
    expect(validRate(43_200, "qa-r1-sc15", QA)).toBe(43_200);
    expect(() => validRate(43_200, "g01", QA)).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(() => validRate(43_200, "qamin", QA)).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(() => validRate(43_200, "qa-r1-sc15", CONSOLE)).toThrow(expect.objectContaining({ code: "INVALID" }));
  });

  it("[FL-082] an invalid rate changes nothing", async () => {
    const kit = timersKit();
    await world(kit);
    await expect(setRunning({ worldId: "demo", rate: 5_000, caller: CONSOLE }, kit.deps)).rejects.toMatchObject({ code: "INVALID" });
    expect(await kit.connector.runtime.getClock("demo")).toMatchObject({ mode: "PAUSED", pausedSimNow: START_SIM });
  });
});

describe("running [FL-082]", () => {
  it("[FL-082] runs from the instant reached for 30 real minutes and schedules what falls in the next real hour", async () => {
    const kit = timersKit();
    await world(kit);
    // At 1440: +2 days = 2 real minutes; +25 days = 25 real minutes; +40 days is past the 30-minute window.
    await kit.putTimers("demo", follow("soon", simPlus(2 * 24 * 60)), follow("later", simPlus(25 * 24 * 60), 1), follow("beyond", simPlus(40 * 24 * 60), 2));
    const changed = await setRunning({ worldId: "demo", caller: CONSOLE }, kit.deps);
    expect(changed).toMatchObject({ mode: "RUNNING", simNow: START_SIM, rate: 1_440, runningUntilReal: new Date(TEST_NOW.getTime() + 30 * MINUTE).toISOString(), resync: { put: 2, direct: 0 } });
    const soon = await kit.getTimer("demo", "FOLLOW_UP", "soon");
    const spec = kit.scheduler.live.get(soon?.scheduleName ?? "");
    expect(spec).toMatchObject({ name: scheduleNameOf("demo", 1, "W#demo#TIMER#FOLLOW_UP#soon"), input: { worldId: "demo", timerKey: "W#demo#TIMER#FOLLOW_UP#soon", version: 2, epoch: 1, dueAtSim: simPlus(2 * 24 * 60) } });
    expect(spec?.at.toISOString()).toBe(new Date(TEST_NOW.getTime() + 2 * MINUTE).toISOString());
    expect((await kit.getTimer("demo", "FOLLOW_UP", "beyond"))?.scheduleName).toBeUndefined();
    expect(await kit.connector.audit.listByAction("demo", "CLOCK_RUNNING")).toHaveLength(1);
  });

  it("[FL-082] a timer due within a minute fires at once, at its dueAtSim, instead of getting a schedule", async () => {
    const kit = timersKit();
    await world(kit);
    await kit.putTimers("demo", follow("now", simPlus(30)));
    const changed = await setRunning({ worldId: "demo", rate: 1_440, caller: CONSOLE }, kit.deps);
    expect(changed.resync).toMatchObject({ direct: 1, put: 0 });
    expect(await kit.getTimer("demo", "FOLLOW_UP", "now")).toMatchObject({ status: "FIRED", firedBy: "SCHEDULER", firedAtSim: simPlus(30) });
    expect(kit.events).toEqual([expect.objectContaining({ eventAtSim: simPlus(30) })]);
  });

  it(`[FL-082] keeps at most ${MAX_SCHEDULES_PER_WORLD} schedules per world; the next one is created when an earlier one fires`, async () => {
    const kit = timersKit();
    await world(kit);
    // At rate 60 the timers are 20 real seconds apart, the first 70 s away: all inside the window.
    const timers = Array.from({ length: 55 }, (_, index) => follow(`t-${String(index).padStart(2, "0")}`, simPlus(70 + index * 20), index));
    await kit.putTimers("demo", ...timers);
    await setRunning({ worldId: "demo", rate: 60, caller: CONSOLE }, kit.deps);
    expect(kit.scheduler.live.size).toBe(MAX_SCHEDULES_PER_WORLD);
    expect((await kit.getTimer("demo", "FOLLOW_UP", "t-49"))?.scheduleName).toBeDefined();
    expect((await kit.getTimer("demo", "FOLLOW_UP", "t-50"))?.scheduleName).toBeUndefined();
    const first = (await kit.getTimer("demo", "FOLLOW_UP", "t-00"))!;
    const result = await dispatchScheduled({ worldId: "demo", timerKey: "W#demo#TIMER#FOLLOW_UP#t-00", version: first.version, epoch: 1, dueAtSim: first.dueAtSim, scheduleArn: ARN(first.scheduleName!) }, kit.deps);
    expect(result).toEqual({ status: "TIMER_FIRED" });
    kit.scheduler.live.delete(first.scheduleName!); // ActionAfterCompletion DELETE
    expect(kit.scheduler.live.size).toBe(MAX_SCHEDULES_PER_WORLD);
    expect((await kit.getTimer("demo", "FOLLOW_UP", "t-50"))?.scheduleName).toBe(scheduleNameOf("demo", 1, "W#demo#TIMER#FOLLOW_UP#t-50"));
  });

  it("[FL-082] a change of rate puts every schedule again: none keeps a real instant of the old rate", async () => {
    const kit = timersKit();
    await world(kit);
    await kit.putTimers("demo", follow("a", simPlus(4 * 24 * 60)));
    await setRunning({ worldId: "demo", rate: 1_440, caller: CONSOLE }, kit.deps);
    expect([...kit.scheduler.live.values()][0]?.at.toISOString()).toBe(new Date(TEST_NOW.getTime() + 4 * MINUTE).toISOString());
    await setRunning({ worldId: "demo", rate: 2_880, caller: CONSOLE }, kit.deps);
    const live = [...kit.scheduler.live.values()];
    expect(live).toHaveLength(1);
    expect(live[0]?.at.toISOString()).toBe(new Date(TEST_NOW.getTime() + 2 * MINUTE).toISOString());
  });
});

describe("pause and the end of the live window [FL-082]", () => {
  it("[FL-082] pause stops at the instant reached and deletes every schedule; the clock never goes back", async () => {
    const kit = timersKit();
    await world(kit);
    await kit.putTimers("demo", follow("a", simPlus(10 * 24 * 60)));
    await setRunning({ worldId: "demo", rate: 1_440, caller: CONSOLE }, kit.deps);
    const named = (await kit.getTimer("demo", "FOLLOW_UP", "a"))?.scheduleName;
    kit.passReal(MINUTE);
    const paused = await pause({ worldId: "demo", caller: CONSOLE }, kit.deps);
    expect(paused).toMatchObject({ mode: "PAUSED", simNow: "2026-10-08T10:10:00-03:00", resync: { deleted: 1 } });
    expect(kit.scheduler.live.size).toBe(0);
    expect(kit.scheduler.deletes).toContain(named);
    expect((await kit.getTimer("demo", "FOLLOW_UP", "a"))?.scheduleName).toBeUndefined();
    expect(await kit.connector.runtime.getClock("demo")).toMatchObject({ mode: "PAUSED", pausedSimNow: "2026-10-08T10:10:00-03:00" });
    expect(await kit.connector.audit.listByAction("demo", "CLOCK_PAUSED")).toHaveLength(1);
  });

  it("[FL-082] back to PAUSED on its own after 30 real minutes, at the instant the window ended, without schedules", async () => {
    const kit = timersKit();
    await world(kit);
    await kit.putTimers("demo", follow("a", simPlus(25 * 24 * 60)));
    await setRunning({ worldId: "demo", rate: 1_440, caller: CONSOLE }, kit.deps);
    expect(kit.scheduler.live.size).toBe(1);
    kit.passReal(45 * MINUTE);
    const refreshed = await refreshClock({ worldId: "demo" }, kit.deps);
    expect(refreshed).toMatchObject({ mode: "PAUSED", simNow: "2026-11-06T10:10:00-03:00", resync: { deleted: 1 } });
    expect(kit.scheduler.live.size).toBe(0);
    expect(await kit.connector.audit.listByAction("demo", "CLOCK_PAUSED")).toEqual([expect.objectContaining({ actor: "SYSTEM", detail: { reason: "WINDOW_ENDED" } })]);
    expect((await refreshClock({ worldId: "demo" }, kit.deps)).resync).toEqual({ put: 0, deleted: 0, direct: 0, skipped: 0 });
  });

  it("[FL-099] running one guest world leaves another guest world's timers without schedules", async () => {
    const kit = timersKit();
    await world(kit, "g01");
    await world(kit, "g02");
    for (const id of ["g01", "g02"]) await kit.putTimers(id, follow("a", simPlus(2 * 24 * 60)));
    await setRunning({ worldId: "g01", rate: 1_440, caller: CONSOLE }, kit.deps);
    expect([...kit.scheduler.live.keys()]).toEqual([scheduleNameOf("g01", 1, "W#g01#TIMER#FOLLOW_UP#a")]);
    expect((await kit.getTimer("g02", "FOLLOW_UP", "a"))?.scheduleName).toBeUndefined();
    await pause({ worldId: "g02", caller: CONSOLE }, kit.deps);
    expect(kit.scheduler.live.size).toBe(1);
  });
});
