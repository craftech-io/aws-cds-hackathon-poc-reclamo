// Address hashing. Phone numbers and emails never travel in clear outside the simulated core: the
// identity lookups, `PHONE#` claims, logs and sessions use an HMAC-SHA256 of the normalized address
// (`phoneHash`, `emailHash`, docs/architecture.md §3 and §5). The key is
// a parameter (a subkey derived from an `sst.Secret` by the caller) so this module has no runtime
// dependency and works in Node 22 and in the browser through Web Crypto.
import type { Channel } from "./enums";

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof value === "string") return encoder.encode(value);
  return new Uint8Array(value);
}

function subtle() {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error("Web Crypto is not available in this runtime");
  return api;
}

export async function sha256Hex(message: string | Uint8Array): Promise<string> {
  return toHex(await subtle().digest("SHA-256", toBytes(message)));
}

export async function hmacSha256Hex(key: string | Uint8Array, message: string | Uint8Array): Promise<string> {
  const cryptoKey = await subtle().importKey("raw", toBytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await subtle().sign("HMAC", cryptoKey, toBytes(message)));
}

// E.164 with a leading "+" and digits only ("+54 9 11 0000-1003" → "+5491100001003").
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) throw new RangeError("phone must have 8 to 15 digits");
  return `+${digits}`;
}

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at < 1 || at === email.length - 1 || email.includes(" ")) throw new RangeError("invalid email address");
  return email;
}

export function normalizeAddress(channel: Channel, raw: string): string {
  return channel === "EMAIL" ? normalizeEmail(raw) : normalizePhone(raw);
}

// Hash of a normalized address with a caller-supplied key. Same address, same channel, same key
// → same hash, which is what the identity lookups and the `PHONE#` uniqueness claims rely on.
export async function addressHash(channel: Channel, raw: string, key: string | Uint8Array): Promise<string> {
  return hmacSha256Hex(key, normalizeAddress(channel, raw));
}

export function isHexHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

// Public masks for logs and tool results: "+54*******0103", "m***@example.test".
export function maskPhone(raw: string): string {
  const phone = normalizePhone(raw);
  return `${phone.slice(0, 3)}${"*".repeat(Math.max(phone.length - 7, 0))}${phone.slice(-4)}`;
}

export function maskEmail(raw: string): string {
  const email = normalizeEmail(raw);
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

// Identity documents (DNI, CUIT) keep only the last four characters.
export function maskDocument(raw: string): string {
  const compact = raw.replace(/[\s.-]/g, "");
  return `${"*".repeat(Math.max(compact.length - 4, 0))}${compact.slice(-4)}`;
}
