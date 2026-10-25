import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "@reclamo/shared";
import { backoffDelayMs, withRetry } from "./retry";

describe("backoffDelayMs", () => {
  it("grows exponentially and caps at maxDelayMs with full jitter", () => {
    const random = () => 1;
    expect(backoffDelayMs(0, { baseDelayMs: 50, maxDelayMs: 1000, random })).toBe(50);
    expect(backoffDelayMs(1, { baseDelayMs: 50, maxDelayMs: 1000, random })).toBe(100);
    expect(backoffDelayMs(3, { baseDelayMs: 50, maxDelayMs: 1000, random })).toBe(400);
    expect(backoffDelayMs(10, { baseDelayMs: 50, maxDelayMs: 1000, random })).toBe(1000);
    expect(backoffDelayMs(3, { baseDelayMs: 50, maxDelayMs: 1000, random: () => 0 })).toBe(0);
  });
});

describe("withRetry", () => {
  it("retries retryable connector errors and returns the first success", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ConnectorError("THROTTLED", "slow down", "Complaints");
        return "ok";
      },
      { attempts: 3, sleep, random: () => 0.5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable error", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ConnectorError("CONFLICT", "already there", "Complaints");
        },
        { attempts: 3, sleep },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the last attempt with the last error", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(
      withRetry(
        async () => {
          throw new ConnectorError("TIMEOUT", "timeout", "Complaints");
        },
        { attempts: 2, sleep },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
