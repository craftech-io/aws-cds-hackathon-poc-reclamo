// Reads the principal out of the Cognito id token. The console only decodes the payload: the
// signature is verified by the BFF on every call. `worldId`, `staffId` and `role` are the claims the
// pre-token trigger stamps from the staff row of the world (ADR-0018); the console uses them to draw
// the menu, never to authorize. Nothing here trusts user input.
import { StaffRole } from "@reclamo/shared";
import { z } from "zod";
import { isSelfSignupGuest } from "./auth/guest-principal";

const IdTokenClaimsSchema = z.looseObject({
  sub: z.string().min(1),
  iss: z.string().min(1),
  aud: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
  auth_time: z.number().int().optional(),
  token_use: z.literal("id"),
  "cognito:username": z.string().min(1).optional(),
  "cognito:groups": z.array(z.string()).optional(),
  worldId: z.string().min(1).optional(),
  staffId: z.string().min(1).optional(),
  role: z.string().optional(),
});

export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

export interface Principal {
  readonly sub: string;
  readonly username?: string;
  /** World of the user, from its staff row; absent when the account is incomplete. */
  readonly worldId?: string;
  readonly staffId?: string;
  readonly role?: StaffRole;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** Epoch seconds of the last interactive sign-in (the client's recent-login check). */
  readonly authTime?: number;
  /** A self-signup guest: no group, its world prepared on demand (views/provisioning). */
  readonly selfSignup?: boolean;
}

function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function decodeJwtPayload(token: string): unknown {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("malformed JWT");
  return JSON.parse(decodeBase64Url(payload)) as unknown;
}

export function parseIdTokenClaims(token: string): IdTokenClaims {
  return IdTokenClaimsSchema.parse(decodeJwtPayload(token));
}

function selfSignupOf(claims: IdTokenClaims): boolean {
  return isSelfSignupGuest({ username: claims["cognito:username"], worldId: claims.worldId, role: claims.role, groups: claims["cognito:groups"] ?? [] });
}

/**
 * The stamped role, only when it is also one of the user's groups, or a self-signup guest's GUEST
 * under the identity invariant (the BFF applies the same rules).
 */
function roleOf(claims: IdTokenClaims, selfSignup: boolean): StaffRole | undefined {
  const role = StaffRole.safeParse(claims.role);
  if (!role.success) return undefined;
  return selfSignup || (claims["cognito:groups"] ?? []).includes(role.data) ? role.data : undefined;
}

export function principalFromClaims(claims: IdTokenClaims): Principal {
  const selfSignup = selfSignupOf(claims);
  const role = roleOf(claims, selfSignup);
  return {
    sub: claims.sub,
    expiresAt: claims.exp * 1000,
    ...(claims["cognito:username"] !== undefined ? { username: claims["cognito:username"] } : {}),
    ...(claims.worldId !== undefined ? { worldId: claims.worldId } : {}),
    ...(claims.staffId !== undefined ? { staffId: claims.staffId } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(claims.auth_time !== undefined ? { authTime: claims.auth_time } : {}),
    ...(selfSignup ? { selfSignup } : {}),
  };
}

export function principalFromIdToken(token: string): Principal {
  return principalFromClaims(parseIdTokenClaims(token));
}
