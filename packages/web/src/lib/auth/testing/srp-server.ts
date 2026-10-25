// Test-only: the server half of Cognito's SRP-6a (3072-bit group, SHA-256, HKDF "Caldera Derived
// Key"), so the fake Cognito really verifies the PASSWORD_CLAIM_SIGNATURE the client computes.
// A wrong password, user id, pool name, secret block or timestamp fails exactly like it would in
// Cognito. Native BigInt and WebCrypto only; nothing here ships in the bundle.

type Bytes = Uint8Array<ArrayBuffer>;

const N_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";
const N = BigInt(`0x${N_HEX}`);
const G = 2n;
const encoder = new TextEncoder();

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** Java BigInteger.toByteArray() as hex, which is how Cognito serialises positive integers. */
function padHex(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return /^[89a-f]/i.test(hex) ? `00${hex}` : hex;
}

function hexToBytes(hex: string): Bytes {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256Hex(bytes: Bytes): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

function randomBigInt(bytes: number): bigint {
  return BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
}

function base64(bytes: Bytes): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Bytes {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export interface SrpVerifier {
  readonly saltHex: string;
  readonly verifier: bigint;
}

/** What Cognito stores for a password: salt and v = g^x mod N. */
export async function createVerifier(poolId: string, userId: string, password: string): Promise<SrpVerifier> {
  const poolName = poolId.split("_")[1] ?? "";
  const saltHex = padHex(randomBigInt(16));
  const identity = await sha256Hex(encoder.encode(`${poolName}${userId}:${password}`));
  const x = BigInt(`0x${await sha256Hex(hexToBytes(saltHex + identity))}`);
  return { saltHex, verifier: modPow(G, x, N) };
}

export interface ServerSession {
  readonly srpBHex: string;
  readonly secretBlock: string;
  verify(input: { srpAHex: string; userId: string; timestamp: string; secretBlock: string; signature: string }): Promise<boolean>;
}

export async function startServerSession(poolId: string, record: SrpVerifier): Promise<ServerSession> {
  const poolName = poolId.split("_")[1] ?? "";
  const k = BigInt(`0x${await sha256Hex(hexToBytes(padHex(N) + padHex(G)))}`);
  const b = randomBigInt(128);
  const B = (k * record.verifier + modPow(G, b, N)) % N;
  const secretBlock = base64(crypto.getRandomValues(new Uint8Array(64)));
  return {
    srpBHex: B.toString(16),
    secretBlock,
    async verify(input) {
      if (input.secretBlock !== secretBlock) return false;
      const A = BigInt(`0x${input.srpAHex}`);
      if (A % N === 0n) return false;
      const u = BigInt(`0x${await sha256Hex(hexToBytes(padHex(A) + padHex(B)))}`);
      const S = modPow(A * modPow(record.verifier, u, N), b, N);
      const prk = await hmac(hexToBytes(padHex(u)), hexToBytes(padHex(S)));
      const key = (await hmac(prk, concat(encoder.encode("Caldera Derived Key"), new Uint8Array([1])))).slice(0, 16);
      const message = concat(encoder.encode(poolName), encoder.encode(input.userId), fromBase64(secretBlock), encoder.encode(input.timestamp));
      return base64(await hmac(key, message)) === input.signature;
    },
  };
}
