// Secret-dependent primitives of the edge in one place: HMACs, constant-time comparison, ULIDs,
// button nonces and HKDF subkeys. Keys are always parameters (read once from `Resource` by
// lib/secrets.ts), so these functions stay pure. There is one secret per purpose
// (docs/architecture.md §3) and, inside a purpose, one HKDF-SHA256 subkey per use: `SessionKey` →
// `session`, `runtime-session`; `PhoneHashKey` → `phone-hash`, `email-hash` and, for the guest
// self-signup (docs/architecture-guests.md), `lead-email`, `signup-ip`, `guest-world`.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export type SecretKey = string | Uint8Array;

export function sha256Hex(message: string | Uint8Array): string {
  return createHash("sha256").update(message).digest("hex");
}

export function hmacSha256Hex(key: SecretKey, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

/** 43 characters: an HMAC-SHA256 in base64url, the signature segment of a session token. */
export function hmacSha256Base64Url(key: SecretKey, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64url");
}

// Constant-time comparison; a length mismatch is compared against itself so timing does not leak
// how many characters matched.
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out = (CROCKFORD[Number(remaining & 31n)] ?? "0") + out;
    remaining >>= 5n;
  }
  return out;
}

// ULID (48-bit millisecond timestamp + 80 random bits, Crockford base32, 26 chars): sortable ids
// for button nonces, turn ids and message ids without a dependency.
export function ulid(nowMs: number = Date.now(), random: (size: number) => Uint8Array = randomBytes): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) throw new RangeError(`ulid time out of range: ${nowMs}`);
  const entropy = random(10);
  if (entropy.length !== 10) throw new RangeError("ulid needs 10 bytes of entropy");
  let randomPart = 0n;
  for (const byte of entropy) randomPart = (randomPart << 8n) | BigInt(byte);
  return encodeBase32(BigInt(nowMs), 10) + encodeBase32(randomPart, 16);
}

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Opaque button nonce: the model and the customer only ever see this, never a payload. Random, no key. */
export function newNonce(nowMs?: number): string {
  return ulid(nowMs);
}

/** Subkeys of each secret, by purpose (docs/architecture.md §3). */
export const SUBKEY_PURPOSES = {
  SessionKey: ["session", "runtime-session"],
  PhoneHashKey: ["phone-hash", "email-hash", "lead-email", "signup-ip", "guest-world"],
} as const;

export type SubkeySecret = keyof typeof SUBKEY_PURPOSES;
export type SubkeyPurpose<S extends SubkeySecret> = (typeof SUBKEY_PURPOSES)[S][number];

const HKDF_SALT = "aws-cds-hackathon-poc-reclamo";

/** 32-byte HKDF-SHA256 subkey of `secret` for one of its purposes; another purpose never yields it. */
export function deriveSubkey<S extends SubkeySecret>(secret: S, key: SecretKey, purpose: SubkeyPurpose<S>): Buffer {
  if (!(SUBKEY_PURPOSES[secret] as readonly string[]).includes(purpose)) throw new RangeError(`${secret} has no subkey "${purpose}"`);
  return Buffer.from(hkdfSync("sha256", key, HKDF_SALT, `${secret}/${purpose}`, 32));
}
