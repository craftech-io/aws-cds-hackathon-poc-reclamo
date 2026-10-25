import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { challengeRetryUrl, handleChallenge, isChallengeRetry, takeChallengeDraft } from "./challenge";

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the edge firewall's challenge on the public forms [FL-112] [FL-122]", () => {
  it("reloads once with retry=1, keeping the query and only the fields that are not secret", () => {
    const search = new URLSearchParams("lang=en&utm_source=news");
    const navigate = vi.fn<(url: string) => void>();
    expect(handleChallenge("/signup", search, { email: "x@y.ar", password: "secret", acceptTerms: true, code: "123456" }, navigate)).toBe("reloading");
    expect(navigate).toHaveBeenCalledWith("/signup?lang=en&utm_source=news&retry=1");
    expect(takeChallengeDraft()).toEqual({ email: "x@y.ar", acceptTerms: true });
    // Read once.
    expect(takeChallengeDraft()).toBeUndefined();
  });

  it("does not loop: a second challenge right after the reload is reported", () => {
    const navigate = vi.fn<(url: string) => void>();
    const search = new URLSearchParams(challengeRetryUrl("/login/recover", new URLSearchParams()).split("?")[1]);
    expect(isChallengeRetry(search)).toBe(true);
    expect(handleChallenge("/login/recover", search, { email: "x@y.ar" }, navigate)).toBe("failed");
    expect(navigate).not.toHaveBeenCalled();
  });
});
