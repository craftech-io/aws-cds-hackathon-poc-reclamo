import { describe, expect, it } from "vitest";
import { GuestStatus, IDLE_WAIT, READY_POLL_MS, SLOW_AFTER_MS, WAITING_POLL_MS, isSlow, nextWait, phaseOf, pollDelay } from "./provisioning-model";

const status = (worldStatus: string, queuePosition = 0) => GuestStatus.parse({ worldStatus, queuePosition });

describe("a self-signup world that is not ready [FL-117] [FL-120] [FL-124]", () => {
  it("gives each status of the world its text", () => {
    expect(phaseOf(status("REGISTERED"))).toEqual({ kind: "preparing" });
    expect(phaseOf(status("REGISTERED", 4))).toEqual({ kind: "queued", position: 4 });
    expect(phaseOf(status("CREATING"))).toEqual({ kind: "creating" });
    expect(phaseOf(status("EXPIRED"))).toEqual({ kind: "expired" });
    expect(phaseOf(status("EXPIRING"))).toEqual({ kind: "expired" });
    expect(phaseOf(status("READY"))).toEqual({ kind: "ready" });
    // A reset in progress is the console's own screen.
    expect(phaseOf(status("RESETTING"))).toEqual({ kind: "ready" });
  });

  it("asks every 5 s while waiting and every minute once open", () => {
    expect(pollDelay(undefined)).toBe(WAITING_POLL_MS);
    expect(pollDelay(status("CREATING"))).toBe(WAITING_POLL_MS);
    expect(pollDelay(status("READY"))).toBe(READY_POLL_MS);
  });

  it("counts 'longer than expected' from the first wait out of the queue", () => {
    let clock = nextWait(IDLE_WAIT, phaseOf(status("REGISTERED")), 1_000);
    expect(clock.since).toBe(1_000);
    clock = nextWait(clock, phaseOf(status("CREATING")), 50_000);
    expect(clock.since).toBe(1_000);
    expect(isSlow(clock, 1_000 + SLOW_AFTER_MS - 1)).toBe(false);
    expect(isSlow(clock, 1_000 + SLOW_AFTER_MS)).toBe(true);
  });

  it("after a turn in line, counts from CREATING", () => {
    let clock = nextWait(IDLE_WAIT, phaseOf(status("REGISTERED", 3)), 1_000);
    expect(clock).toEqual({ queued: true });
    expect(isSlow(clock, 10 * SLOW_AFTER_MS)).toBe(false);
    clock = nextWait(clock, phaseOf(status("CREATING")), 900_000);
    expect(clock).toEqual({ since: 900_000, queued: false });
    expect(isSlow(clock, 900_000 + SLOW_AFTER_MS / 2)).toBe(false);
  });

  it("refuses an answer that is not a status", () => {
    expect(GuestStatus.safeParse({ worldStatus: "READY", queuePosition: -1 }).success).toBe(false);
    expect(GuestStatus.safeParse({ worldStatus: "READY", queuePosition: 0, usage: { turnsToday: 60, turnsPerDay: 60, limitReached: true } }).success).toBe(true);
  });
});
