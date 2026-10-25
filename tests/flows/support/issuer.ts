// The Cognito of the local flows and of the local UI server, as far as the BFF can tell: an ephemeral
// RSA key per run (or one handed over by the Playwright runner, so its specs sign what the server
// trusts), the JWKS a user pool would publish for it and id tokens with the claims the pre-token
// trigger stamps (`worldId`, `staffId`, `role` from the staff row). The BFF verifies them with its REAL
// verifier, the key set pinned at construction with `cacheJwks` — the seam only the local entries use;
// the Lambda has none (packages/bff/src/auth/no-jwks-override.test.ts). Never a key of a real pool.
import { type JsonWebKey, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { Fetcher } from "aws-jwt-verify/https";
import type { Jwk, Jwks } from "aws-jwt-verify/jwk";
import type { StaffRole } from "@reclamo/shared";
import { type IdTokenVerifier, type IdTokenVerifierConfig, createCognitoIdTokenVerifier } from "@reclamo/bff/auth/jwt";

/** The placeholder pool of the local console (packages/web/e2e/support/env.ts `FAKE_COGNITO`). */
export const LOCAL_POOL: IdTokenVerifierConfig & { readonly region: string } = {
  userPoolId: "us-east-1_e2e",
  consoleClientId: "e2e-client",
  serverClientId: "e2e-server-client",
  region: "us-east-1",
};
export const LOCAL_ISSUER = `https://cognito-idp.${LOCAL_POOL.region}.amazonaws.com/${LOCAL_POOL.userPoolId}`;

/** What a runner hands over: the private half as a JWK and its key id. */
export interface SigningKey {
  readonly kid: string;
  readonly privateJwk: JsonWebKey;
}

export interface SessionClaims {
  readonly sub: string;
  readonly username: string;
  readonly role: StaffRole;
  readonly worldId: string;
  readonly staffId: string;
  /** `ServerClient` tokens are the QaDriver's `auth.session`; the console's are `ConsoleClient`. */
  readonly audience?: "console" | "server";
  /** Seconds since the interactive sign-in (`auth_time`) on the issuer's clock; 0 by default. */
  readonly signedInAgo?: number;
  /** Seconds until `exp`; 900 by default (15 minutes). */
  readonly expiresIn?: number;
  readonly originJti?: string;
  /** `cognito:groups`; the role alone by default, none for a self-signup guest. */
  readonly groups?: readonly string[];
}

export interface TokenIssuer {
  readonly kid: string;
  /** The public half, as a pool's `/.well-known/jwks.json`. */
  readonly jwks: Jwks;
  readonly signingKey: SigningKey;
  idToken(claims: SessionClaims): string;
  /** The BFF's real verifier, pinned to this key set (and the trusted ones). */
  verifier(): IdTokenVerifier;
}

export function newSigningKey(): SigningKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid: `local-${randomUUID()}`, privateJwk: privateKey.export({ format: "jwk" }) };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export interface TokenIssuerOptions {
  readonly key?: SigningKey;
  readonly now?: () => Date;
  /** Further keys the verifier trusts (a Playwright run's own JWKS, handed over by its runner). */
  readonly trustedJwks?: Jwks;
}

let processKey: SigningKey | undefined;

/** One key per process unless a caller brings its own: an RSA key pair is slow to generate. */
function sharedKey(): SigningKey {
  processKey ??= newSigningKey();
  return processKey;
}

export function createTokenIssuer(options: TokenIssuerOptions = {}): TokenIssuer {
  const signingKey = options.key ?? sharedKey();
  const now = options.now ?? (() => new Date());
  const privateKey = createPrivateKey({ key: signingKey.privateJwk, format: "jwk" });
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  const jwk: Jwk = { kty: "RSA", n: exported.n ?? "", e: exported.e ?? "", kid: signingKey.kid, alg: "RS256", use: "sig" };
  const jwks: Jwks = { keys: [jwk] };
  return {
    kid: signingKey.kid,
    jwks,
    signingKey,
    idToken(claims) {
      // `exp` is checked by aws-jwt-verify against the machine's clock, `auth_time` by the BFF against
      // its `wallClock` (the world's real time): each is stamped on the clock that reads it.
      const issuedAt = Math.floor(Date.now() / 1_000);
      const signedInAt = Math.floor(now().getTime() / 1_000) - (claims.signedInAgo ?? 0);
      const payload = {
        sub: claims.sub,
        iss: LOCAL_ISSUER,
        aud: claims.audience === "server" ? LOCAL_POOL.serverClientId : LOCAL_POOL.consoleClientId,
        token_use: "id",
        auth_time: signedInAt,
        iat: issuedAt,
        exp: issuedAt + (claims.expiresIn ?? 900),
        origin_jti: claims.originJti ?? randomUUID(),
        "cognito:username": claims.username,
        ...((claims.groups ?? [claims.role]).length === 0 ? {} : { "cognito:groups": [...(claims.groups ?? [claims.role])] }),
        worldId: claims.worldId,
        staffId: claims.staffId,
        role: claims.role,
      };
      const signingInput = `${base64url({ alg: "RS256", typ: "JWT", kid: signingKey.kid })}.${base64url(payload)}`;
      return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
    },
    verifier: () => {
      const trusted: Jwks = { keys: [...jwks.keys, ...(options.trustedJwks?.keys ?? [])] };
      // A token with an unknown `kid` makes the verifier fetch the pool's key set again: here it gets the
      // same keys from memory, as the pool's URI would answer, and never a request off the machine.
      const fetcher: Fetcher = { fetch: async () => new TextEncoder().encode(JSON.stringify(trusted)).buffer as ArrayBuffer };
      return createCognitoIdTokenVerifier(LOCAL_POOL, { jwks: trusted, fetcher });
    },
  };
}
