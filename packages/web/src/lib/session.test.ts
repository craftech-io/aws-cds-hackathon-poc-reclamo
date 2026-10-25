import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveTokens, type TokenSet } from "./auth/tokens";
import { currentIdToken, sessionTick, signInIsRecent } from "./session";

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

function idToken(authTime: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub: "s", iss: "i", aud: "a", exp: authTime + 900, iat: authTime, auth_time: authTime, token_use: "id" })}.sig`;
}

const NOW = Date.parse("2026-09-26T12:00:00Z");
const A: TokenSet = { idToken: "id-a", accessToken: "access-a", expiresAt: NOW + 600_000 };
const B: TokenSet = { idToken: "id-b", accessToken: "access-b", expiresAt: NOW + 900_000 };

beforeEach(() => {
  Object.assign(globalThis, { sessionStorage: new MemoryStorage() });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("session contract [FL-094]", () => {
  it("reads the id token from sessionStorage on every call", () => {
    expect(currentIdToken()).toBeUndefined();
    saveTokens(A);
    expect(currentIdToken()).toBe("id-a");
    saveTokens(B);
    expect(currentIdToken()).toBe("id-b");
  });

  it("follows a token replaced without a reload and ends at the exp of the stored one", () => {
    expect(sessionTick("id-a", B, NOW)).toEqual({ kind: "replaced", tokens: B });
    // Past A's exp but not B's: the session goes on with B.
    expect(sessionTick("id-b", B, A.expiresAt + 1_000)).toEqual({ kind: "same" });
    expect(sessionTick("id-b", B, B.expiresAt)).toEqual({ kind: "expired" });
  });

  it("refreshes only with a refresh token, and never tries without one", () => {
    const withRefresh = { ...A, refreshToken: "r" };
    expect(sessionTick("id-a", withRefresh, A.expiresAt - 30_000)).toEqual({ kind: "refresh", tokens: withRefresh });
    expect(sessionTick("id-a", A, A.expiresAt - 30_000)).toEqual({ kind: "expired" });
  });

  it("ends a session whose tokens left storage", () => {
    expect(sessionTick("id-a", undefined, NOW)).toEqual({ kind: "expired" });
    expect(sessionTick(undefined, undefined, NOW)).toEqual({ kind: "none" });
  });

  it("checks a recent sign-in against the auth_time of the stored token", () => {
    const authTime = Math.floor(NOW / 1000) - 10 * 60;
    saveTokens({ ...A, idToken: idToken(authTime) });
    expect(signInIsRecent(NOW)).toBe(true);
    expect(signInIsRecent(NOW + 6 * 60_000)).toBe(false);
    saveTokens({ ...A, idToken: idToken(Math.floor(NOW / 1000)) });
    expect(signInIsRecent(NOW + 6 * 60_000)).toBe(true);
  });
});
