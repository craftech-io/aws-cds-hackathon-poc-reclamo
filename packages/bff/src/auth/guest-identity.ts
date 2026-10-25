// The identity invariant of a self-signup guest (docs/architecture-guests.md §3). Such an account has
// neither of the two signals that stop a mis-written staff row for everyone else (the immutable
// `custom:worldId` attribute and the role among the user's groups), so a bidirectional rule replaces
// them, checked by the pre-token trigger AND by the BFF's `principalFromClaims`:
//
//   a) a username with `@` resolves to a `gs-*` world, role `GUEST`, no group, no attribute; the one
//      exception is the scenario runner's `success+qa-<runId>-<key>@simulator.amazonses.com`, which
//      resolves only to `qa-<runId>-<key>` (`key` = `su<n>`), with the same rules;
//   b) a `gs-*` (or `qa-*-su*`) world implies role `GUEST` and a username of form (a);
//   c) a username without `@` never resolves to a `gs-*` or `qa-*-su*` world;
//   d) the row's world equals the world of the lead of that `sub` (the trigger reads it, the BFF
//      derives it from the `sub`).
import type { StaffRole } from "@reclamo/shared";

const GUEST_WORLD = /^gs-[a-z2-7]{10}$/;
const QA_SIGNUP_WORLD = /^qa-[a-z0-9]+(?:-[a-z0-9]+)*-su\d{1,3}$/;
const QA_SIGNUP_USERNAME = /^success\+qa-([a-z0-9]+(?:-[a-z0-9]+)*)-(su\d{1,3})@simulator\.amazonses\.com$/;

/** Procedures a signed-in self-signup guest may call while its world is not `READY`. */
export const WORLD_PENDING_PATHS: ReadonlySet<string> = new Set(["guest.status", "guest.requestWorld", "account.session"]);

/** Self-signup usernames are the email; staff, `guest-NN` and `qa-*` usernames never have `@`. */
export function isEmailUsername(username: string): boolean {
  return username.includes("@");
}

/** The run and key of a scenario-runner sign-up, from its username only. */
export function qaSignupScope(username: string): { readonly runId: string; readonly key: string } | undefined {
  const match = QA_SIGNUP_USERNAME.exec(username.toLowerCase());
  return match?.[1] && match[2] ? { runId: match[1], key: match[2] } : undefined;
}

/** The world a self-signup of the scenario runner may hold. */
export function qaSignupWorld(username: string): string | undefined {
  const scope = qaSignupScope(username);
  return scope ? `qa-${scope.runId}-${scope.key}` : undefined;
}

/** A world created by a self-signup (`gs-*`) or by the scenario runner's sign-up (`qa-*-su*`). */
export function isSignupWorld(worldId: string): boolean {
  return GUEST_WORLD.test(worldId) || QA_SIGNUP_WORLD.test(worldId);
}

export interface SignupIdentity {
  readonly username: string;
  readonly worldId: string;
  readonly role: StaffRole | string;
  readonly groups: readonly string[];
  /** `custom:worldId`, when the account carries it (a self-signup never does). */
  readonly attributeWorldId?: string | undefined;
  /** The world of the lead of this `sub` (rule d); `undefined` when there is no lead. */
  readonly leadWorldId?: string | undefined;
}

/**
 * Which rule the identity breaks, or `undefined` when the invariant holds. For a username without
 * `@` only rule (c) is checked here; the attribute and group signals stay with the caller.
 */
export function signupIdentityProblem(identity: SignupIdentity): string | undefined {
  if (!isEmailUsername(identity.username)) return isSignupWorld(identity.worldId) ? "STAFF_USER_IN_SIGNUP_WORLD" : undefined;
  const qaWorld = qaSignupWorld(identity.username);
  if (qaWorld ? identity.worldId !== qaWorld : !GUEST_WORLD.test(identity.worldId)) return "SIGNUP_USER_OUTSIDE_SIGNUP_WORLD";
  if (identity.role !== "GUEST") return "SIGNUP_ROLE_NOT_GUEST";
  if (identity.groups.length > 0) return "SIGNUP_USER_IN_GROUP";
  if (identity.attributeWorldId !== undefined) return "SIGNUP_USER_WITH_ATTRIBUTE";
  if (identity.leadWorldId === undefined || identity.leadWorldId !== identity.worldId) return "LEAD_WORLD_MISMATCH";
  return undefined;
}
