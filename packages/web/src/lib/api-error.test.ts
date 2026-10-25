import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";
import { isAbortError, toApiError } from "./api-error";
import type { AppRouter } from "./trpc-router";

function serverError(code: string, reason: string | null) {
  return TRPCClientError.from<AppRouter>({
    error: { code: -32_603, message: "refused", data: { code, httpStatus: 403, path: "approvals.decide", reason, correlationId: "corr-1", zodError: null } },
  });
}

describe("toApiError", () => {
  it("turns the recent-login refusal into its own kind, whatever the HTTP code", () => {
    expect(toApiError(serverError("FORBIDDEN", "LOGIN_NOT_RECENT"))).toEqual({
      kind: "recentLogin",
      code: "FORBIDDEN",
      httpStatus: 403,
      reason: "LOGIN_NOT_RECENT",
      correlationId: "corr-1",
      message: "refused",
    });
  });

  it("keeps the BFF reason for the view to switch on", () => {
    expect(toApiError(serverError("CONFLICT", "VERSION_STALE"))).toMatchObject({ kind: "conflict", reason: "VERSION_STALE" });
    expect(toApiError(serverError("FORBIDDEN", "CROSS_WORLD"))).toMatchObject({ kind: "forbidden", reason: "CROSS_WORLD" });
    expect(toApiError(serverError("BAD_REQUEST", "GROUNDING_FAIL")).kind).toBe("invalid");
    expect(toApiError(serverError("SERVICE_UNAVAILABLE", null))).toMatchObject({ kind: "unavailable", reason: null });
  });

  it("calls a failure without an answer a network error", () => {
    const offline = TRPCClientError.from(new TypeError("Failed to fetch"));
    expect(toApiError(offline)).toMatchObject({ kind: "network", code: "NETWORK", reason: null });
  });

  it("never throws on something that is not a client error", () => {
    expect(toApiError("boom")).toMatchObject({ kind: "unknown", code: "UNKNOWN", message: "boom" });
    expect(toApiError(undefined).kind).toBe("unknown");
  });
});

describe("isAbortError", () => {
  it("recognises a cancelled request, bare or wrapped by the client", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(TRPCClientError.from(abort))).toBe(true);
    expect(isAbortError(serverError("CONFLICT", null))).toBe(false);
    expect(isAbortError(new Error("x"))).toBe(false);
  });
});
