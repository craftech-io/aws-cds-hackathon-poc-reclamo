// Who is calling, resolved once per request (docs/architecture.md §11): verify the id token offline,
// build the principal from its claims, re-read the staff row it names and the world's `META`, and
// apply the `ServerClient` rule. The outcome keeps the principal of a refused request so the caller
// can audit the denial in the right world. The in-process principal of the QaDriver skips the token
// and the staff row (it has neither) but not the world checks.
import { AUTH_REASON, AuthError } from "./errors";
import { isSignupWorld } from "./guest-identity";
import { type IdTokenVerifier, bearerToken } from "./jwt";
import { type GuestWorldOf, type Principal, inProcessWorldAllowed, principalFromClaims, serverClientAllowed } from "./principal";
import { type StaffRow, type WorldDirectory, type WorldMeta, staffRowActive } from "./staff";

export interface AuthenticationDeps {
  readonly verifier: IdTokenVerifier;
  readonly directory: WorldDirectory;
  /** Derives a self-signup account's world from its `sub`; absent, such accounts are refused. */
  readonly guestWorldOf?: GuestWorldOf;
}

export type AuthOutcome =
  | { readonly ok: true; readonly principal: Principal; readonly world: WorldMeta }
  | { readonly ok: false; readonly error: AuthError; readonly principal?: Principal; readonly world?: WorldMeta };

function refused(error: AuthError, principal?: Principal, world?: WorldMeta): AuthOutcome {
  return { ok: false, error, ...(principal ? { principal } : {}), ...(world ? { world } : {}) };
}

// A world answers only when `READY`, or `RESETTING` for the reset-status poll (the procedure decides).
// A self-signup world answers in any status: its guest polls `guest.status` while it is prepared, and
// `worldProcedure` keeps every other procedure closed until it is `READY` (WORLD_PENDING_PATHS).
function worldUsable(world: WorldMeta | undefined): world is WorldMeta {
  if (world === undefined) return false;
  return world.status === "READY" || world.status === "RESETTING" || isSignupWorld(world.worldId);
}

interface WorldRead {
  readonly row?: StaffRow;
  readonly world?: WorldMeta;
}

// A directory outage fails the request closed as AUTH_UNAVAILABLE (503), never as a verdict.
async function readWorld(directory: WorldDirectory, principal: Principal, withStaff: boolean): Promise<WorldRead | AuthError> {
  try {
    const [row, world] = await Promise.all([withStaff ? directory.staff(principal.worldId, principal.staffId) : undefined, directory.meta(principal.worldId)]);
    return { ...(row ? { row } : {}), ...(world ? { world } : {}) };
  } catch (error) {
    return new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not read the staff directory", { cause: error });
  }
}

/** The principal of an `Authorization: Bearer <id token>` header, or why it is refused. */
export async function authenticateToken(authorization: string | undefined, deps: AuthenticationDeps): Promise<AuthOutcome> {
  let principal: Principal;
  try {
    const { claims, audience } = await deps.verifier.verify(bearerToken(authorization));
    principal = principalFromClaims(claims, audience, deps.guestWorldOf);
  } catch (error) {
    return refused(error instanceof AuthError ? error : new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "authentication failed unexpectedly", { cause: error }));
  }

  const read = await readWorld(deps.directory, principal, true);
  if (read instanceof AuthError) return refused(read, principal);
  const { row, world } = read;
  if (!serverClientAllowed(principal, row)) {
    return refused(new AuthError(AUTH_REASON.SERVER_CLIENT_AUDIENCE, "this audience is accepted only for QA users of QA worlds"), principal, world);
  }
  // The row must still exist, be active, belong to this `sub` and grant the role the token carries.
  if (!staffRowActive(row, principal.sub) || row.worldId !== principal.worldId || row.role !== principal.role) {
    return refused(new AuthError(AUTH_REASON.STAFF_INACTIVE, "this staff account is not active in its world"), principal, world);
  }
  if (!worldUsable(world)) {
    return refused(new AuthError(AUTH_REASON.WORLD_NOT_READY, "this world is not ready"), principal, world);
  }
  return { ok: true, principal, world };
}

/** The QaDriver's server-built principal: only in QA worlds (and `GUEST` only in `qa-*`). */
export async function authenticateInProcess(principal: Principal, deps: Pick<AuthenticationDeps, "directory">): Promise<AuthOutcome> {
  if (principal.audience !== "in-process" || !inProcessWorldAllowed(principal.worldId, principal.role)) {
    return refused(new AuthError(AUTH_REASON.IN_PROCESS_WORLD_DENIED, "the in-process principal acts only in QA worlds"), principal);
  }
  const read = await readWorld(deps.directory, principal, false);
  if (read instanceof AuthError) return refused(read, principal);
  const { world } = read;
  if (!worldUsable(world)) return refused(new AuthError(AUTH_REASON.WORLD_NOT_READY, "this world is not ready"), principal, world);
  return { ok: true, principal, world };
}
