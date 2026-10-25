// Test-only RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s): what an authenticator app computes from the
// base32 secret of an otpauth URI. The fake Cognito checks codes with it, and the tests produce
// them with it, so a secret that reached the QR code garbled would fail the test.

type Bytes = Uint8Array<ArrayBuffer>;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function randomBase32Secret(length = 32): string {
  return [...crypto.getRandomValues(new Uint8Array(length))].map((byte) => BASE32[byte % 32]).join("");
}

function base32Decode(secret: string): Bytes {
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error("not base32");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

export async function totpCode(secret: string, atMs: number = Date.now()): Promise<string> {
  const counter = Math.floor(atMs / 1000 / 30);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) | ((digest[offset + 1] ?? 0) << 16) | ((digest[offset + 2] ?? 0) << 8) | (digest[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}
