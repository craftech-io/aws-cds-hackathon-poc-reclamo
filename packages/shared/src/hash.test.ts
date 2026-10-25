import { describe, expect, it } from "vitest";
import {
  addressHash,
  hmacSha256Hex,
  isHexHash,
  maskDocument,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizePhone,
  sha256Hex,
} from "./hash";

describe("normalization", () => {
  it("phones become +digits", () => {
    expect(normalizePhone("+54 9 11 0000-1003")).toBe("+5491100001003");
    expect(normalizePhone("(300) 555 1234 ")).toBe("+3005551234");
    expect(() => normalizePhone("123")).toThrow(RangeError);
  });

  it("emails are trimmed and lower-cased", () => {
    expect(normalizeEmail("  Ana.Gomez@Example.test ")).toBe("ana.gomez@example.test");
    expect(() => normalizeEmail("no-at-sign")).toThrow(RangeError);
    expect(() => normalizeEmail("a b@x.test")).toThrow(RangeError);
  });
});

describe("hashing", () => {
  it("sha256 matches the known digest of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hmac-sha256 matches RFC 4231 test case 2", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("addressHash is stable across formatting and keyed by the secret", async () => {
    const key = "test-key";
    const a = await addressHash("WHATSAPP", "+54 9 11 0000-1003", key);
    const b = await addressHash("WHATSAPP", "+5491100001003", key);
    const c = await addressHash("WHATSAPP", "+5491100001003", "other-key");
    const email = await addressHash("EMAIL", " Ana@Example.test", key);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(email).toBe(await addressHash("EMAIL", "ana@example.test", key));
    expect(isHexHash(a)).toBe(true);
    expect(isHexHash("nope")).toBe(false);
  });
});

describe("masks", () => {
  it("never reveal the middle of an address", () => {
    expect(maskPhone("+5491100001003")).toBe("+54*******1003");
    expect(maskEmail("ana.gomez@example.test")).toBe("a***@example.test");
    expect(maskDocument("20-12345678-9")).toBe("*******6789");
  });
});
