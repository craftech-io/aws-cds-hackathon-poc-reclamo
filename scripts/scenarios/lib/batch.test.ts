import { describe, expect, it } from "vitest";
import { batchRefusal, batchSpend, runBatch } from "./batch";
import type { DriverClient } from "./driver-client";

function scripted(states: Array<{ state: string } | { error: string }>): DriverClient & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async call(action, input, key) {
      expect(action).toBe("batch.run");
      expect(input).toEqual({ runId: "812-1", batchId: "b1" });
      keys.push(key);
      const next = states.shift() ?? { state: "RUNNING" };
      return "error" in next ? { ok: false, error: { code: "FORBIDDEN", reason: "QA_FENCE", message: next.error } } : { ok: true, replayed: false, result: next };
    },
  };
}

describe("--suite batch: the real-agent metrics batch (docs/seed-spec.md §13)", () => {
  it("is priced first and refuses to start without the spend confirmed and covered", () => {
    const spend = batchSpend();
    expect(spend.presentations).toBe(30);
    expect(spend.turns).toEqual({ low: 30, high: 90 });
    expect(spend.usd.high).toBeGreaterThan(spend.usd.low);
    expect(batchRefusal(spend, false, 1_000)).toContain("--confirm-spend");
    expect(batchRefusal(spend, true, undefined)).toContain("--max-cost-usd");
    expect(batchRefusal(spend, true, spend.usd.high / 2)).toContain("--max-cost-usd");
    expect(batchRefusal(spend, true, spend.usd.high)).toBeUndefined();
  });

  it("polls batch.run under one key until DONE", async () => {
    const driver = scripted([{ state: "CREATING" }, { state: "RUNNING" }, { state: "DONE" }]);
    let clock = 0;
    const outcome = await runBatch({ runId: "812-1", batchId: "b1", driver, now: () => clock, sleep: async (ms) => void (clock += ms) });
    expect(outcome).toMatchObject({ state: "DONE", done: true, polls: 3 });
    expect(new Set(driver.keys)).toEqual(new Set(["812-1/sc20-batch/1/b1"]));
  });

  it("stops at a refusal or at the deadline, never reporting DONE", async () => {
    expect(await runBatch({ runId: "812-1", batchId: "b1", driver: scripted([{ error: "no" }]), sleep: async () => undefined })).toMatchObject({ done: false, error: expect.stringContaining("QA_FENCE") });
    let clock = 0;
    const late = await runBatch({ runId: "812-1", batchId: "b1", driver: scripted([]), timeoutMs: 60_000, everyMs: 30_000, now: () => clock, sleep: async (ms) => void (clock += ms) });
    expect(late).toMatchObject({ done: false, state: "RUNNING", error: expect.stringContaining("still RUNNING") });
  });
});
