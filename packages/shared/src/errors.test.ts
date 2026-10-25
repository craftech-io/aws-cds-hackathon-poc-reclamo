import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChannelError, ConnectorError, ToolError, ToolFailureSchema, fail, isRetryable, ok, toToolFailure } from "./errors";

describe("tool envelope", () => {
  it("ok spreads the payload under ok: true", () => {
    expect(ok({ found: true, total: 1 })).toEqual({ ok: true, found: true, total: 1 });
  });

  it("fail produces the catalog shape", () => {
    const failure = fail("FORBIDDEN", "not your complaint", "NOT_IN_SESSION");
    expect(ToolFailureSchema.parse(failure)).toEqual(failure);
    expect(fail("NOT_FOUND", "no document")).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "no document" } });
  });
});

describe("toToolFailure", () => {
  it("passes ToolError through", () => {
    const failure = toToolFailure(new ToolError("FORBIDDEN", "session expired", "SESSION_EXPIRED"));
    expect(failure).toEqual({ ok: false, error: { code: "FORBIDDEN", message: "session expired", reason: "SESSION_EXPIRED" } });
  });

  it("maps connector and channel codes", () => {
    expect(toToolFailure(new ConnectorError("NOT_FOUND", "no item", "Complaints")).error.code).toBe("NOT_FOUND");
    expect(toToolFailure(new ConnectorError("CONFLICT", "version changed")).error.code).toBe("CONFLICT");
    expect(toToolFailure(new ConnectorError("THROTTLED", "slow down")).error.code).toBe("UNAVAILABLE");
    expect(toToolFailure(new ChannelError("OPTED_OUT", "WHATSAPP", "opted out")).error.code).toBe("POLICY_DENIED");
    expect(toToolFailure(new ChannelError("INVALID", "WHATSAPP", "button too long")).error.code).toBe("INVALID");
  });

  it("hides unknown errors and zod details from the model", () => {
    const unknown = toToolFailure(new Error("ECONNRESET at 10.0.0.1"));
    expect(unknown.error.code).toBe("UNAVAILABLE");
    expect(unknown.error.message).not.toContain("10.0.0.1");
    const invalid = toToolFailure(z.object({ a: z.string() }).safeParse({}).error);
    expect(invalid.error).toEqual({ code: "INVALID", message: "invalid input", reason: "VALIDATION" });
  });

  it("marks transient failures as retryable", () => {
    expect(isRetryable(new ChannelError("TIMEOUT", "EMAIL", "timeout"))).toBe(true);
    expect(isRetryable(new ChannelError("INVALID", "EMAIL", "bad"))).toBe(false);
    expect(isRetryable(new ChannelError("SEND_FAILED", "WHATSAPP", "no", { retryable: false }))).toBe(false);
    expect(isRetryable(new ConnectorError("UNAVAILABLE", "down"))).toBe(true);
    expect(isRetryable(new Error("x"))).toBe(false);
  });
});
