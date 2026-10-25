// The token set of the console session. Tokens live in sessionStorage: they die with the tab and
// never reach localStorage, where any script of the origin would outlive the session. Passwords and
// TOTP secrets are never stored anywhere: they exist only in the memory of the form that uses them.
// The id token is what the BFF expects in the Authorization header (principal from the id token).
import { z } from "zod";
import type { AuthenticationResult, CognitoApi } from "./cognito";

export const TOKENS_KEY = "reclamo.console.tokens";

/** Tokens are considered expired this long before Cognito says so, to absorb clock skew. */
const EXPIRY_SKEW_MS = 30_000;

const TokenSetSchema = z.object({
  idToken: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Epoch milliseconds. */
  expiresAt: z.number().int(),
});
export type TokenSet = z.infer<typeof TokenSetSchema>;

export function tokenSetOf(result: AuthenticationResult, now: number, previousRefreshToken?: string): TokenSet {
  // REFRESH_TOKEN_AUTH answers without a refresh token unless rotation is on: keep the one we had.
  const refreshToken = result.RefreshToken ?? previousRefreshToken;
  return {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    expiresAt: now + result.ExpiresIn * 1000,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

// sessionStorage can throw (private mode, storage disabled); the console must still render.
export function loadTokens(): TokenSet | undefined {
  try {
    const raw = sessionStorage.getItem(TOKENS_KEY);
    if (!raw) return undefined;
    const parsed = TokenSetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveTokens(tokens: TokenSet): void {
  try {
    sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  } catch {
    // Nothing to do: the session simply will not survive a reload.
  }
}

export function clearTokens(): void {
  try {
    sessionStorage.removeItem(TOKENS_KEY);
  } catch {
    // Same as above.
  }
}

export function isExpired(tokens: TokenSet, now = Date.now()): boolean {
  return tokens.expiresAt - EXPIRY_SKEW_MS <= now;
}

export async function refreshTokens(cognito: Pick<CognitoApi, "refresh">, current: TokenSet, now: () => number = Date.now): Promise<TokenSet> {
  if (!current.refreshToken) throw new Error("no refresh token");
  const tokens = tokenSetOf(await cognito.refresh(current.refreshToken), now(), current.refreshToken);
  saveTokens(tokens);
  return tokens;
}

/**
 * Ends the session: the refresh token (and the access tokens issued from it) is revoked at Cognito,
 * then the local copy goes. A failed revocation still signs out locally; the tokens expire on their own.
 */
export async function revokeSession(cognito: Pick<CognitoApi, "revoke">, tokens: TokenSet | undefined): Promise<void> {
  clearTokens();
  if (!tokens?.refreshToken) return;
  try {
    await cognito.revoke(tokens.refreshToken);
  } catch {
    // Offline or already revoked: nothing the user can do about it.
  }
}

/** Sanitizes a post-login destination: same-origin paths only, never the login route. */
export function safeReturnTo(candidate: string | null | undefined, loginPath: string, fallback = "/"): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\")) return fallback;
  if (candidate === loginPath || candidate.startsWith(`${loginPath}?`) || candidate.startsWith(`${loginPath}/`)) return fallback;
  return candidate;
}
