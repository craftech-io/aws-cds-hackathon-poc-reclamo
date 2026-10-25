import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupSecret, looksLikeEmail, looksLikeUsername, missingPasswordRules, normalizeTotpCode, normalizeUsername, otpauthUri } from "./credentials";
import { TOKENS_KEY, isExpired, loadTokens, refreshTokens, revokeSession, safeReturnTo, saveTokens, type TokenSet } from "./tokens";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.assign(globalThis, { sessionStorage: storage });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

const FRESH: TokenSet = { idToken: "id", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 };

describe("token set in sessionStorage", () => {
  it("round-trips and rejects what is not a token set", () => {
    saveTokens(FRESH);
    expect(loadTokens()).toEqual(FRESH);
    storage.setItem(TOKENS_KEY, JSON.stringify({ idToken: "x" }));
    expect(loadTokens()).toBeUndefined();
  });

  it("treats a token about to expire as expired", () => {
    expect(isExpired({ ...FRESH, expiresAt: Date.now() + 10_000 })).toBe(true);
    expect(isExpired(FRESH)).toBe(false);
  });

  it("refreshes a session and keeps the refresh token Cognito does not rotate", async () => {
    const cognito = { refresh: async () => ({ IdToken: "id-2", AccessToken: "access-2", ExpiresIn: 900 }) };
    const refreshed = await refreshTokens(cognito, { ...FRESH, expiresAt: Date.now() - 1 });
    expect(refreshed).toMatchObject({ idToken: "id-2", accessToken: "access-2", refreshToken: "refresh" });
    expect(loadTokens()).toEqual(refreshed);
  });

  it("refuses to refresh without a refresh token", async () => {
    await expect(refreshTokens({ refresh: async () => Promise.reject(new Error("unused")) }, { idToken: "i", accessToken: "a", expiresAt: 0 })).rejects.toThrow();
  });

  it("clears locally and revokes the refresh token on sign-out, even offline", async () => {
    saveTokens(FRESH);
    const revoked: string[] = [];
    await revokeSession({ revoke: async (token) => void revoked.push(token) }, FRESH);
    expect(revoked).toEqual(["refresh"]);
    expect(loadTokens()).toBeUndefined();
    saveTokens(FRESH);
    await revokeSession({ revoke: async () => Promise.reject(new Error("offline")) }, FRESH);
    expect(loadTokens()).toBeUndefined();
  });
});

describe("safeReturnTo", () => {
  it("keeps same-origin paths and refuses the login route and other origins", () => {
    expect(safeReturnTo("/app/complaints/cmp-1?x=1", "/login")).toBe("/app/complaints/cmp-1?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/login", "/login?returnTo=%2F", "", null, undefined]) {
      expect(safeReturnTo(bad, "/login", "/app/inbox")).toBe("/app/inbox");
    }
  });
});

describe("credentials helpers", () => {
  it("normalizes usernames of the pool: staff names and, for a self-signup guest, the email itself", () => {
    expect(normalizeUsername(" Guest-03 ")).toBe("guest-03");
    expect(normalizeUsername(" Success+QA-Run1-su1@Simulator.AmazonSES.com ")).toBe("success+qa-run1-su1@simulator.amazonses.com");
    expect(looksLikeUsername("operator-01")).toBe(true);
    expect(looksLikeUsername("success+qa-run1-su1@simulator.amazonses.com")).toBe(true);
    expect(looksLikeUsername("a")).toBe(false);
    expect(looksLikeUsername("no-domain@")).toBe(false);
    expect(looksLikeEmail("success+qa-run1-su1@simulator.amazonses.com")).toBe(true);
    expect(looksLikeEmail("operator-01")).toBe(false);
    expect(looksLikeEmail("ñandú@dominio.ar")).toBe(false);
  });

  it("lists the password rules still missing: 12 characters, upper and lower case and a digit, no symbol", () => {
    expect(missingPasswordRules("abc")).toEqual(["length", "upper", "number"]);
    expect(missingPasswordRules("Fixture-Password-1!")).toEqual([]);
    expect(missingPasswordRules("UnaClaveLarga2026")).toEqual([]);
  });

  it("accepts a six-digit code with spaces and nothing else", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode("12345")).toBeUndefined();
    expect(normalizeTotpCode("12345a")).toBeUndefined();
  });

  it("builds the otpauth URI authenticator apps scan", () => {
    const uri = new URL(otpauthUri("JBSWY3DPEHPK3PXP", "supervisor-01"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/Reclamo en regla:supervisor-01");
    expect(uri.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(uri.searchParams.get("issuer")).toBe("Reclamo en regla");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });
});
