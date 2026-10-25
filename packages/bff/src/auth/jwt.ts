// Verifies the Cognito id token the console sends on every call: RS256 signature against the
// pool's JWKS, issuer, audience (`ConsoleClient` or `ServerClient`, docs/architecture.md §11),
// `token_use = id` and expiry. Verification is offline: the JWKS is fetched once per container
// from the pool's own URI and cached. Nothing a request carries can change where the keys come
// from: the only seams are construction-time options, which the Lambda never passes
// (routers/deps.ts) and only the local UI server and the tests use (`auth/no-jwks-override.test.ts`).
// The library is AWS's own verifier; this module only adds the timeout and backoff every external
// call carries and turns its errors into `AuthError` so the edge can tell "bad token" from "Cognito
// is down".
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { FetchError, JwtBaseError, JwtExpiredError, NonRetryableFetchError } from "aws-jwt-verify/error";
import { fetch as fetchJwks, type Fetcher } from "aws-jwt-verify/https";
import { type Jwks, SimpleJwksCache } from "aws-jwt-verify/jwk";
import { z } from "zod";
import { withRetry } from "../lib/retry";
import { AUTH_REASON, AuthError } from "./errors";

/** Claims the BFF reads. Everything else in the token is ignored, never trusted by name. */
export const IdTokenClaims = z.looseObject({
  sub: z.string().min(1),
  iss: z.string().min(1),
  aud: z.string().min(1),
  token_use: z.literal("id"),
  exp: z.number().int(),
  iat: z.number().int(),
  // Epoch seconds of the last interactive sign-in; a refresh does not move it.
  auth_time: z.number().int(),
  // Id of the sign-in that started this session; a refresh keeps it (the "other session" warning).
  origin_jti: z.string().min(1).optional(),
  "cognito:username": z.string().min(1),
  "cognito:groups": z.array(z.string()).optional(),
  // Stamped by the pre-token trigger from the staff row of `Worlds` (never from the user's
  // immutable `custom:worldId` attribute, ADR-0018).
  worldId: z.string().optional(),
  staffId: z.string().optional(),
  role: z.string().optional(),
});
export type IdTokenClaims = z.infer<typeof IdTokenClaims>;

/** Which app client issued a verified token (docs/architecture.md §11). */
export type TokenAudience = "console" | "server";

export interface VerifiedIdToken {
  readonly claims: IdTokenClaims;
  /** `server` only for the `ServerClient` audience; the BFF then applies the `qa-*` rule. */
  readonly audience: TokenAudience;
}

export interface IdTokenVerifier {
  /** Resolves with the verified claims or rejects with an `AuthError`. */
  verify(token: string): Promise<VerifiedIdToken>;
}

export interface IdTokenVerifierConfig {
  readonly userPoolId: string;
  readonly consoleClientId: string;
  readonly serverClientId: string;
}

/** Construction-time seams. The Lambda passes none of them (routers/deps.ts). */
export interface IdTokenVerifierOptions {
  /** Tests: serves the JWKS instead of the network. */
  readonly fetcher?: Fetcher;
  /** Local UI server: an ephemeral key set cached up front with the verifier's own `cacheJwks`. */
  readonly jwks?: Jwks;
}

// The JWKS is a small static document behind Cognito's CDN. It is fetched once per container and
// again only when a token names an unknown `kid` (key rotation), so a short deadline is safe.
const JWKS_SOCKET_IDLE_MS = 1_500;
const JWKS_RESPONSE_TIMEOUT_MS = 3_000;
const JWKS_ATTEMPTS = 3;

class BackoffFetcher implements Fetcher {
  fetch(uri: string, requestOptions?: Record<string, unknown>, data?: ArrayBuffer): Promise<ArrayBuffer> {
    const options = { timeout: JWKS_SOCKET_IDLE_MS, responseTimeout: JWKS_RESPONSE_TIMEOUT_MS, ...requestOptions };
    return withRetry(() => fetchJwks(uri, options, data), {
      attempts: JWKS_ATTEMPTS,
      baseDelayMs: 100,
      shouldRetry: (error) => error instanceof FetchError && !(error instanceof NonRetryableFetchError),
    });
  }
}

function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  if (error instanceof JwtExpiredError) return new AuthError(AUTH_REASON.TOKEN_EXPIRED, "id token expired", { cause: error });
  if (error instanceof FetchError) return new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not fetch the signing keys", { cause: error });
  if (error instanceof JwtBaseError || error instanceof z.ZodError) {
    return new AuthError(AUTH_REASON.TOKEN_INVALID, "id token rejected", { cause: error });
  }
  // Anything unexpected fails closed as an outage, not as a verdict on the token.
  return new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "id token could not be verified", { cause: error });
}

export function createCognitoIdTokenVerifier(config: IdTokenVerifierConfig, options: IdTokenVerifierOptions = {}): IdTokenVerifier {
  const jwksCache = new SimpleJwksCache({ fetcher: options.fetcher ?? new BackoffFetcher() });
  // Any other audience is refused by the library itself (TOKEN_INVALID → 401).
  const clientId = [config.consoleClientId, config.serverClientId];
  const verifier = CognitoJwtVerifier.create({ userPoolId: config.userPoolId, clientId, tokenUse: "id" }, { jwksCache });
  if (options.jwks) verifier.cacheJwks(options.jwks);

  // Only `verify` leaves this closure: the underlying verifier (and its `cacheJwks`) never does.
  return {
    async verify(token) {
      try {
        const payload: unknown = await verifier.verify(token);
        const claims = IdTokenClaims.parse(payload);
        return { claims, audience: claims.aud === config.serverClientId ? "server" : "console" };
      } catch (error) {
        throw toAuthError(error);
      }
    },
  };
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** Extracts the token of an `Authorization: Bearer <jwt>` header; rejects with TOKEN_MISSING. */
export function bearerToken(authorization: string | undefined): string {
  const match = authorization === undefined ? null : BEARER.exec(authorization.trim());
  const token = match?.[1];
  if (!token) throw new AuthError(AUTH_REASON.TOKEN_MISSING, "missing bearer token");
  return token;
}
