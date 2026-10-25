import { describe, expect, it } from "vitest";
import { ULID_PATTERN, deriveSubkey, hmacSha256Base64Url, hmacSha256Hex, newNonce, safeEqual, sha256Hex, ulid } from "./crypto";

const KEY = "k".repeat(44);
const OTHER = "o".repeat(44);

describe("crypto primitives", () => {
  it("hashes and signs deterministically, and the key matters", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hmacSha256Hex(KEY, "m")).toBe(hmacSha256Hex(KEY, "m"));
    expect(hmacSha256Hex(KEY, "m")).not.toBe(hmacSha256Hex(OTHER, "m"));
    expect(hmacSha256Base64Url(KEY, "m")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("compares in constant time, including different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("makes sortable ULIDs from the given time and entropy", () => {
    const zero = () => new Uint8Array(10);
    expect(ulid(0, zero)).toBe("0".repeat(26));
    const early = ulid(1_000, zero);
    const late = ulid(2_000, zero);
    expect(early < late).toBe(true);
    expect(early).toMatch(ULID_PATTERN);
    expect(newNonce()).toMatch(ULID_PATTERN);
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(0, () => new Uint8Array(4))).toThrow(RangeError);
  });

  it("derives one subkey per purpose inside each secret, never across them", () => {
    const session = deriveSubkey("SessionKey", KEY, "session");
    expect(session).toHaveLength(32);
    expect(deriveSubkey("SessionKey", KEY, "session").equals(session)).toBe(true);
    expect(deriveSubkey("SessionKey", KEY, "runtime-session").equals(session)).toBe(false);
    expect(deriveSubkey("PhoneHashKey", KEY, "phone-hash").equals(deriveSubkey("PhoneHashKey", KEY, "email-hash"))).toBe(false);
    expect(deriveSubkey("SessionKey", OTHER, "session").equals(session)).toBe(false);
    // @ts-expect-error a purpose of another secret is not a subkey of this one
    expect(() => deriveSubkey("SessionKey", KEY, "phone-hash")).toThrow(RangeError);
  });
});
