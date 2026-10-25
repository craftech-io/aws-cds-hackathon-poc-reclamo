// Session contract of the console (docs/architecture.md §11): `sessionStorage` is the ONLY source of
// `idToken`, `accessToken` and `exp`. Every call to the BFF and every tick of the session watcher
// (1 s) reads them from there, and nothing copies them into React state: a token replaced without a
// reload (a refresh, or a token injected by a browser scenario) is used from the next call, and the
// session ends at the `exp` of the token stored at that moment, never at the one of the first token.
// Silent refresh only with a refresh token; without one, the stored `exp` is the end.
import { parseIdTokenClaims } from "./auth-claims";
import { type TokenSet, isExpired, loadTokens } from "./auth/tokens";

/** Refresh this long before the id token expires so no request goes out with a stale one. */
export const REFRESH_LEAD_MS = 60_000;

/** Approving money, answering in writing and resetting need a sign-in this recent (ADR-0005). */
export const RECENT_LOGIN_MAX_AGE_SECONDS = 15 * 60;

/** The stored tokens, read now. */
export function getSession(): TokenSet | undefined {
  return loadTokens();
}

/** The id token for the next BFF call, read from storage on every call. */
export function currentIdToken(): string | undefined {
  return getSession()?.idToken;
}

export type SessionTick =
  /** Nothing stored and nothing was: anonymous. */
  | { readonly kind: "none" }
  /** Same token, still valid. */
  | { readonly kind: "same" }
  /** Another token was stored since the last tick: the session follows it. */
  | { readonly kind: "replaced"; readonly tokens: TokenSet }
  /** Close to `exp` and a refresh token exists. */
  | { readonly kind: "refresh"; readonly tokens: TokenSet }
  /** Gone from storage, or past its `exp` with no way to refresh. */
  | { readonly kind: "expired" };

/** What the watcher does now, from the token it knew and the one stored at this instant. */
export function sessionTick(knownIdToken: string | undefined, stored: TokenSet | undefined, now: number): SessionTick {
  if (!stored) return knownIdToken === undefined ? { kind: "none" } : { kind: "expired" };
  if (stored.refreshToken && stored.expiresAt - REFRESH_LEAD_MS <= now) return { kind: "refresh", tokens: stored };
  if (isExpired(stored, now)) return { kind: "expired" };
  if (stored.idToken !== knownIdToken) return { kind: "replaced", tokens: stored };
  return { kind: "same" };
}

/** Client-side recent-login check (whether to open the step-up first), from the STORED id token. */
export function signInIsRecent(nowMs: number, stored: TokenSet | undefined = getSession()): boolean {
  if (!stored) return false;
  try {
    const authTime = parseIdTokenClaims(stored.idToken).auth_time;
    return authTime !== undefined && Math.floor(nowMs / 1000) - authTime <= RECENT_LOGIN_MAX_AGE_SECONDS;
  } catch {
    return false;
  }
}
