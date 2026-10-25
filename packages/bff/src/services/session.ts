// `sessionToken` of every Gateway tool call (docs/tool-catalog.md, Convenciones):
// `<worldId>.<sessionId>.<turnId>.<exp>.<HMAC-SHA256 base64url>`, signed with the `session` HKDF
// subkey of `SessionKey`, at most 15 minutes of REAL time. The tool derives everything else
// (customer, conversation, complaints) from `Runtime/W#<worldId>#SESSION#<sessionId>`; nothing the
// model writes can name another world, session or turn.
import { WorldId } from "@reclamo/shared";
import { type SecretKey, deriveSubkey, hmacSha256Base64Url, safeEqual } from "../lib/crypto";

export const SESSION_TOKEN_MAX_AGE_SECONDS = 15 * 60;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface SessionClaims {
  readonly worldId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Epoch seconds, real time. */
  readonly exp: number;
}

export type SessionTokenFailure = "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED";

export type SessionTokenResult = { readonly ok: true; readonly claims: SessionClaims } | { readonly ok: false; readonly reason: SessionTokenFailure };

function payloadOf(claims: SessionClaims): string {
  return `${claims.worldId}.${claims.sessionId}.${claims.turnId}.${claims.exp}`;
}

/** Signs a token for one turn; `now` is real time and the lifetime never exceeds 15 minutes. */
export function issueSessionToken(sessionKey: SecretKey, claims: Omit<SessionClaims, "exp">, now: Date, lifetimeSeconds = SESSION_TOKEN_MAX_AGE_SECONDS): string {
  if (!WorldId.safeParse(claims.worldId).success || !ID.test(claims.sessionId) || !ID.test(claims.turnId)) throw new RangeError("invalid session token claims");
  if (lifetimeSeconds <= 0 || lifetimeSeconds > SESSION_TOKEN_MAX_AGE_SECONDS) throw new RangeError(`lifetime must be 1..${SESSION_TOKEN_MAX_AGE_SECONDS} s`);
  const full: SessionClaims = { ...claims, exp: Math.floor(now.getTime() / 1000) + lifetimeSeconds };
  const payload = payloadOf(full);
  return `${payload}.${hmacSha256Base64Url(deriveSubkey("SessionKey", sessionKey, "session"), payload)}`;
}

/** Verifies signature and expiry (real time); the caller then checks the turn is still open. */
export function verifySessionToken(sessionKey: SecretKey, token: string, now: Date): SessionTokenResult {
  const parts = token.split(".");
  if (parts.length !== 5) return { ok: false, reason: "MALFORMED" };
  const [worldId = "", sessionId = "", turnId = "", expText = "", signature = ""] = parts;
  const exp = Number(expText);
  if (!WorldId.safeParse(worldId).success || !ID.test(sessionId) || !ID.test(turnId) || !/^\d{10}$/.test(expText) || !SIGNATURE.test(signature)) {
    return { ok: false, reason: "MALFORMED" };
  }
  const claims: SessionClaims = { worldId, sessionId, turnId, exp };
  const expected = hmacSha256Base64Url(deriveSubkey("SessionKey", sessionKey, "session"), payloadOf(claims));
  if (!safeEqual(signature, expected)) return { ok: false, reason: "BAD_SIGNATURE" };
  if (Math.floor(now.getTime() / 1000) >= exp) return { ok: false, reason: "EXPIRED" };
  return { ok: true, claims };
}
