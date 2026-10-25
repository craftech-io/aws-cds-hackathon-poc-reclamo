import { describe, expect, it } from "vitest";
import { type ClockState, fixedClock, realInstantOf, simulatedNow, systemClock, worldClock } from "./clock";

describe("clocks", () => {
  it("a fixed clock always answers the same instant and hands out copies", async () => {
    const clock = fixedClock("2026-10-07T10:10:00-03:00");
    const first = await clock.now();
    first.setUTCFullYear(1999);
    expect((await clock.now()).toISOString()).toBe("2026-10-07T13:10:00.000Z");
  });

  it("rejects an instant that does not parse", () => {
    expect(() => fixedClock("mañana")).toThrow();
  });

  it("the system clock follows real time", async () => {
    const before = Date.now();
    const now = (await systemClock.now()).getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});

describe("world clock (ADR-0011)", () => {
  const running: ClockState = { mode: "RUNNING", anchorSim: "2026-10-07T13:10:00Z", anchorReal: "2026-09-26T12:00:00Z", rate: 1_440 };

  it("stands still while PAUSED", () => {
    const paused: ClockState = { mode: "PAUSED", pausedSimNow: "2026-10-07T13:10:00Z" };
    expect(simulatedNow(paused, new Date("2030-01-01T00:00:00Z")).toISOString()).toBe("2026-10-07T13:10:00.000Z");
  });

  it("runs a simulated day per real minute at rate 1440, and maps a due instant back to real time", () => {
    expect(simulatedNow(running, new Date("2026-09-26T12:01:00Z")).toISOString()).toBe("2026-10-08T13:10:00.000Z");
    expect(realInstantOf(running, new Date("2026-10-17T13:10:00Z")).toISOString()).toBe("2026-09-26T12:10:00.000Z");
  });

  it("re-reads the stored state of its world on every call", async () => {
    let state: ClockState = running;
    const reads: string[] = [];
    const clock = worldClock("g03", async (worldId) => { reads.push(worldId); return state; }, fixedClock("2026-09-26T12:00:30Z"));
    expect((await clock.now()).toISOString()).toBe("2026-10-08T01:10:00.000Z");
    state = { mode: "PAUSED", pausedSimNow: "2026-10-09T09:00:00Z" };
    expect((await clock.now()).toISOString()).toBe("2026-10-09T09:00:00.000Z");
    expect(reads).toEqual(["g03", "g03"]);
  });
});
