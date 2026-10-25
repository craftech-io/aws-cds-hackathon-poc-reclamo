import { describe, expect, it } from "vitest";
import { clockViewOf, isWorldResetting, resetFinished } from "./world-clock";

describe("world clock of the shell", () => {
  it("turns a clock answer into the bar, with the busy reason", () => {
    expect(clockViewOf({ mode: "PAUSED", simNow: "2026-10-07T10:10:00-03:00" })).toEqual({ simNowText: "mié 07/10 10:10", mode: "PAUSED", rate: 1, busyReason: undefined });
    expect(clockViewOf({ mode: "RUNNING", simNow: "2026-10-07T13:15:00Z", rate: 60, busy: { reason: "Hay un turno en curso" }, nextTimers: [] })).toEqual({
      simNowText: "mié 07/10 10:15",
      mode: "RUNNING",
      rate: 60,
      busyReason: "Hay un turno en curso",
    });
  });

  it("shows no bar for an answer that is not a clock", () => {
    expect(clockViewOf(undefined)).toBeUndefined();
    expect(clockViewOf({ mode: "FAST", simNow: "2026-10-07T10:10:00-03:00" })).toBeUndefined();
    expect(clockViewOf({ mode: "PAUSED", simNow: "ayer" })).toBeUndefined();
  });

  it("ends the reset screen only on READY", () => {
    expect(resetFinished({ status: "READY" })).toBe(true);
    expect(resetFinished({ status: "RESETTING", phase: "WIPE" })).toBe(false);
    expect(resetFinished({ status: "DONE" })).toBe(false);
    expect(resetFinished(null)).toBe(false);
  });

  it("recognises the refusal of a world being reset", () => {
    expect(isWorldResetting({ reason: "WORLD_RESETTING" })).toBe(true);
    expect(isWorldResetting({ reason: "CROSS_WORLD" })).toBe(false);
    expect(isWorldResetting({ reason: null })).toBe(false);
  });
});
