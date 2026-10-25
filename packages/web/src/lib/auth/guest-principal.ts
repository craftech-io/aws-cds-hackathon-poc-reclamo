// The console's reading of a self-signup guest (docs/architecture-guests.md §1, §3). Such an account
// has no group and no `custom:worldId`: its role comes from its staff row under the bidirectional
// invariant the pre-token trigger and the BFF enforce. The console only decodes the token to draw the
// menu, never to authorize, so it mirrors the invariant's shape (a username with `@` in a self-signup
// world, role GUEST, no group) and nothing more; the BFF re-checks everything on every call.
import { GuestOrigin, guestOriginOf } from "@reclamo/shared";

const QA_SIGNUP_WORLD = /^qa-[a-z0-9]+(?:-[a-z0-9]+)*-su\d{1,3}$/;
const QA_SIGNUP_USERNAME = /^success\+qa-([a-z0-9]+(?:-[a-z0-9]+)*)-(su\d{1,3})@simulator\.amazonses\.com$/;

/** A world created by a self-signup (`gs-*`) or by the scenario runner's sign-up (`qa-<run>-su<n>`). */
export function isSignupWorld(worldId: string | undefined): boolean {
  if (worldId === undefined) return false;
  return guestOriginOf(worldId) === GuestOrigin.enum.SIGNUP || QA_SIGNUP_WORLD.test(worldId);
}

export interface GuestClaims {
  readonly username: string | undefined;
  readonly worldId: string | undefined;
  readonly role: string | undefined;
  readonly groups: readonly string[];
}

/**
 * True when the claims are those of a self-signup guest: a username with `@` resolving to its own
 * self-signup world (the scenario runner's address only to `qa-<run>-<key>`), role GUEST, no group.
 */
export function isSelfSignupGuest(claims: GuestClaims): boolean {
  const { username, worldId } = claims;
  if (!username?.includes("@") || worldId === undefined || claims.role !== "GUEST" || claims.groups.length > 0) return false;
  const qa = QA_SIGNUP_USERNAME.exec(username.toLowerCase());
  if (qa) return worldId === `qa-${qa[1] ?? ""}-${qa[2] ?? ""}`;
  return guestOriginOf(worldId) === GuestOrigin.enum.SIGNUP;
}
