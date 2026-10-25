import { describe, expect, it } from "vitest";
import { issueSessionToken, verifySessionToken } from "./session";

const KEY = "test-session-key-test-session-key-0123456789";
const NOW = new Date("2026-09-26T12:00:00Z");
const CLAIMS = { worldId: "g03", sessionId: "ses-01J7ABCDEF", turnId: "trn-01J7GHJKMN" };

describe("sessionToken", () => {
  it("round-trips world, session, turn and expiry", () => {
    const token = issueSessionToken(KEY, CLAIMS, NOW);
    expect(token.split(".")).toHaveLength(5);
    const result = verifySessionToken(KEY, token, new Date(NOW.getTime() + 60_000));
    expect(result).toEqual({ ok: true, claims: { ...CLAIMS, exp: Math.floor(NOW.getTime() / 1000) + 900 } });
  });

  it("expires after 15 real minutes and never lives longer", () => {
    const token = issueSessionToken(KEY, CLAIMS, NOW);
    expect(verifySessionToken(KEY, token, new Date(NOW.getTime() + 900_000))).toEqual({ ok: false, reason: "EXPIRED" });
    expect(() => issueSessionToken(KEY, CLAIMS, NOW, 901)).toThrow(RangeError);
  });

  it("rejects another world, another key or any edited part", () => {
    const token = issueSessionToken(KEY, CLAIMS, NOW);
    const [, sessionId, turnId, exp, signature] = token.split(".");
    expect(verifySessionToken(KEY, ["demo", sessionId, turnId, exp, signature].join("."), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifySessionToken(`${KEY}x`, token, NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifySessionToken(KEY, `${token}x`, NOW)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifySessionToken(KEY, "a.b.c", NOW)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(() => issueSessionToken(KEY, { ...CLAIMS, worldId: "world-x" }, NOW)).toThrow(RangeError);
  });
});
