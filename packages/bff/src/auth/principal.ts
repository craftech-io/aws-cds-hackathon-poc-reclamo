// The principal of a console request. Every field comes from the verified id token, never from the
// request input (docs/architecture.md §11, ADR-0018): `worldId`, `staffId` and `role` are stamped by
// the pre-token trigger from the staff row of `Worlds` (`BySub`), and the Cognito groups only
// confirm the role. The QaDriver calls the same procedures in process with a principal it builds on
// the server (`inProcessPrincipal`), accepted only in QA worlds (docs/tool-catalog.md, ADR-0009).
import { StaffRole, WorldId, worldKindOf } from "@reclamo/shared";
import { AUTH_REASON, AuthError } from "./errors";
import { isEmailUsername, qaSignupWorld, signupIdentityProblem } from "./guest-identity";
import type { IdTokenClaims, TokenAudience } from "./jwt";
import { StaffId, type StaffRow, staffRowActive } from "./staff";

/** Which app client issued the token, or `in-process` for the QaDriver's `createCaller`. */
export type Audience = TokenAudience | "in-process";

export interface Principal {
  /** Cognito `sub`: stable id of the user in the pool (`qa` for the in-process principal). */
  readonly sub: string;
  /** Cognito username (`operator-01`, `guest-03`, `qa-<runId>-<scenario>-<role>`). */
  readonly username: string;
  /** The only world this user may read or write. */
  readonly worldId: string;
  readonly staffId: StaffId;
  readonly role: StaffRole;
  /** Guest accounts: no password change, no TOTP, their own `gNN` world. */
  readonly isGuest: boolean;
  /** Epoch seconds of the last interactive sign-in (`auth_time`). */
  readonly authTime: number;
  readonly audience: Audience;
  /**
   * Identity of the session for the "another session" warning (`CLOCK.lastSession`): the token's
   * `origin_jti`, which a refresh keeps; the `sub` for `qa-*` users, whose re-issued tokens
   * (`auth.session` with the same `sessionKey`) are the same session.
   */
  readonly sessionId: string;
}

/**
 * `qa-<runId>-<scenario>-<role>`: users created by the QaDriver's `auth.session` and `guest.invite`.
 * Never an email: a visitor `qa-x@domain.com` is not a QA user (docs/architecture-guests.md §3).
 */
export function isQaUsername(username: string): boolean {
  return username.startsWith("qa-") && !isEmailUsername(username);
}

/** `qa-<runId>-<scenario>` and `qa-live-…` worlds (not `qamin`). */
export function isQaDashWorld(worldId: string): boolean {
  return worldId.startsWith("qa-") && worldKindOf(worldId) === "QA";
}

export function sessionIdOf(claims: Pick<IdTokenClaims, "sub" | "origin_jti" | "cognito:username">): string {
  if (isQaUsername(claims["cognito:username"])) return claims.sub;
  return claims.origin_jti ?? claims.sub;
}

/** The world a self-signup account holds, derived from its `sub` (leads/keys.ts `guestWorldId`). */
export interface GuestWorldOf {
  (sub: string): string;
}

/**
 * The self-signup side of the identity invariant (auth/guest-identity.ts): a username with `@` has no
 * group and must hold exactly the world its `sub` derives (or, for the scenario runner, its username
 * names); a username without `@` never holds a self-signup world and keeps the group signal.
 */
function assertIdentity(claims: IdTokenClaims, worldId: string, role: StaffRole, guestWorldOf: GuestWorldOf | undefined): void {
  const username = claims["cognito:username"];
  const groups = claims["cognito:groups"] ?? [];
  const leadWorldId = isEmailUsername(username) ? (qaSignupWorld(username) ?? guestWorldOf?.(claims.sub)) : undefined;
  const problem = signupIdentityProblem({ username, worldId, role, groups, leadWorldId });
  if (problem) throw new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, `the account breaks the guest identity invariant (${problem})`);
  if (!isEmailUsername(username) && !groups.includes(role)) {
    throw new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, "the stamped role is not a group of the user");
  }
}

/**
 * Resolves the principal of verified claims; `audience` says which app client issued them. Without
 * `guestWorldOf` (it needs `PhoneHashKey`) a self-signup account is refused: fail closed.
 */
export function principalFromClaims(claims: IdTokenClaims, audience: TokenAudience, guestWorldOf?: GuestWorldOf): Principal {
  const worldId = WorldId.safeParse(claims.worldId);
  const staffId = StaffId.safeParse(claims.staffId);
  const role = StaffRole.safeParse(claims.role);
  if (!worldId.success || !staffId.success || !role.success) {
    throw new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, "the token carries no world, staff id or role");
  }
  assertIdentity(claims, worldId.data, role.data, guestWorldOf);
  return {
    sub: claims.sub,
    username: claims["cognito:username"],
    worldId: worldId.data,
    staffId: staffId.data,
    role: role.data,
    isGuest: role.data === "GUEST",
    authTime: claims.auth_time,
    audience,
    sessionId: sessionIdOf(claims),
  };
}

/**
 * A `ServerClient` token is accepted only when both hold (docs/architecture.md §11): the username
 * starts with `qa-`, and the staff row the token names (re-read by the caller) exists with this
 * `sub` in a `qa-*` world. Console tokens pass; the in-process principal never reaches this check.
 */
export function serverClientAllowed(principal: Principal, staffRow: StaffRow | undefined): boolean {
  if (principal.audience !== "server") return true;
  return (
    isQaUsername(principal.username) &&
    staffRowActive(staffRow, principal.sub) &&
    staffRow.worldId === principal.worldId &&
    isQaDashWorld(staffRow.worldId)
  );
}

/**
 * Where the in-process principal may act: a QA world, and `GUEST` only in a `qa-*` world (never in
 * `qamin`). The QaDriver's own guard is one more layer, not the only one.
 */
export function inProcessWorldAllowed(worldId: string, role: StaffRole): boolean {
  if (worldKindOf(worldId) !== "QA") return false;
  return role !== "GUEST" || isQaDashWorld(worldId);
}

export interface InProcessPrincipalInput {
  readonly worldId: string;
  readonly role: StaffRole;
  /** Epoch seconds of the simulated sign-in; the QaDriver passes an old one to test the recent-login gate. */
  readonly authTime: number;
}

/** The principal the QaDriver builds on the server for `appRouter.createCaller` (docs/tool-catalog.md). */
export function inProcessPrincipal(input: InProcessPrincipalInput): Principal {
  const role = StaffRole.parse(input.role);
  if (!inProcessWorldAllowed(input.worldId, role)) {
    throw new AuthError(AUTH_REASON.IN_PROCESS_WORLD_DENIED, "the in-process principal acts only in QA worlds");
  }
  return {
    sub: "qa",
    username: "qa-driver",
    worldId: input.worldId,
    staffId: StaffId.parse(`stf-qa-${role.toLowerCase()}`),
    role,
    isGuest: role === "GUEST",
    authTime: input.authTime,
    audience: "in-process",
    sessionId: "qa",
  };
}

/** How long after an interactive sign-in approving money, answering in writing and resetting stay open. */
export const RECENT_LOGIN_MAX_AGE_SECONDS = 15 * 60;

// Tolerated clock difference between Cognito and the Lambda.
const CLOCK_SKEW_SECONDS = 60;

/** True while the last interactive sign-in is inside the recent-login window (real clock). */
export function isSignInFresh(principal: Pick<Principal, "authTime">, now: Date, maxAgeSeconds: number = RECENT_LOGIN_MAX_AGE_SECONDS): boolean {
  const ageSeconds = Math.floor(now.getTime() / 1000) - principal.authTime;
  return ageSeconds >= -CLOCK_SKEW_SECONDS && ageSeconds <= maxAgeSeconds;
}
