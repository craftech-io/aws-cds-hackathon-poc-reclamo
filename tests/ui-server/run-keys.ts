// The key of one Playwright run (docs/test-plan.md §2, level UI): generated once by the runner's
// config, handed to the UI server only as its public JWKS (`E2E_JWKS`, injected into the BFF's real
// verifier with `cacheJwks` from the server's entry) and to the spec workers as the private half
// (`E2E_SIGNING_KEY`), so the Cognito route of the browser answers tokens the server accepts. A run's
// key never outlives the run and is never a key of a real pool.
//
//   playwright.config.ts   const keys = ensureRunKeys();   webServer env: { E2E_JWKS: keys.jwksJson }
//   a spec                 runIssuer().idToken({...})       or sessionTokens({...}) to plant a session
import type { Jwks } from "aws-jwt-verify/jwk";
import { z } from "zod";
import { type SessionClaims, type SigningKey, type TokenIssuer, createTokenIssuer, newSigningKey } from "../flows/support/issuer";
import { defaultStaff } from "../flows/support/seed-world";

export const SIGNING_KEY_ENV = "E2E_SIGNING_KEY";
export const JWKS_ENV = "E2E_JWKS";

const SigningKeySchema = z.object({ kid: z.string().min(1), privateJwk: z.looseObject({ kty: z.literal("RSA"), d: z.string().min(1) }) });
const JwksSchema = z.object({ keys: z.array(z.looseObject({ kty: z.literal("RSA"), kid: z.string().min(1), n: z.string().min(1), e: z.string().min(1) })).min(1) });

export interface RunKeys {
  readonly signingKey: SigningKey;
  readonly jwks: Jwks;
  /** `E2E_JWKS` as the UI server's environment carries it. */
  readonly jwksJson: string;
}

/** The run's key from the environment, created (and put there for the workers) on first use. */
export function ensureRunKeys(env: NodeJS.ProcessEnv = process.env): RunKeys {
  const raw = env[SIGNING_KEY_ENV];
  const signingKey: SigningKey = raw === undefined ? newSigningKey() : (SigningKeySchema.parse(JSON.parse(raw)) as SigningKey);
  const { jwks } = createTokenIssuer({ key: signingKey });
  const jwksJson = JSON.stringify(jwks);
  env[SIGNING_KEY_ENV] = JSON.stringify(signingKey);
  env[JWKS_ENV] = jwksJson;
  return { signingKey, jwks, jwksJson };
}

/** The public key set the UI server trusts (`E2E_JWKS`); throws when the runner did not set it. */
export function runJwksFromEnv(env: NodeJS.ProcessEnv = process.env): Jwks {
  const raw = env[JWKS_ENV];
  if (raw === undefined) throw new Error(`the UI server needs ${JWKS_ENV} (set by the Playwright config with ensureRunKeys)`);
  return JwksSchema.parse(JSON.parse(raw)) as Jwks;
}

/** The issuer of a spec worker: the run's private key, real time. */
export function runIssuer(env: NodeJS.ProcessEnv = process.env): TokenIssuer {
  const raw = env[SIGNING_KEY_ENV];
  if (raw === undefined) throw new Error(`a spec needs ${SIGNING_KEY_ENV} (set by the Playwright config with ensureRunKeys)`);
  return createTokenIssuer({ key: SigningKeySchema.parse(JSON.parse(raw)) as SigningKey });
}

/** What the console keeps in `sessionStorage` after a sign-in (packages/web/src/lib/auth/tokens.ts). */
export interface StoredTokens {
  readonly idToken: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

/** A session the BFF accepts, ready to plant (`expiresAt` in epoch ms, as the console stores it). */
export function sessionTokens(claims: SessionClaims, issuer: TokenIssuer = runIssuer()): StoredTokens {
  const expiresIn = claims.expiresIn ?? 900;
  return { idToken: issuer.idToken(claims), accessToken: `e2e-access-${claims.username}`, expiresAt: Date.now() + expiresIn * 1_000 };
}

/**
 * The claims of a staff user of a world of the UI server (its default staff, flows/support/seed-world.ts):
 * the `sub` and `staffId` the world's `STAFF#` row holds, so the BFF re-reads a real row.
 */
export function staffClaims(worldId: string, role: SessionClaims["role"], extra: Partial<Pick<SessionClaims, "signedInAgo" | "expiresIn">> = {}): SessionClaims {
  const staff = defaultStaff(worldId).find((row) => row.role === role);
  if (staff === undefined) throw new Error(`world ${worldId} has no ${role} on the UI server`);
  return { sub: staff.sub, username: staff.username, role, worldId, staffId: staff.staffId, ...extra };
}
