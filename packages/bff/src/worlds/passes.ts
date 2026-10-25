// The scheduled passes of `WorldJanitor` (docs/architecture.md §10, docs/architecture-guests.md §5-§6):
//
//   PROVISION_PASS  every 5 minutes: the self-signup queue (worlds/guest-provision.ts), the expiry of
//                   the self-signup worlds (worlds/guest-expiry.ts) and the healing of the capacity count
//   HOURLY_PASS     resumes every reset or expiry whose heartbeat is older than 20 minutes, destroys the
//                   scenario worlds and users a cancelled CI job left (older than 6 hours: `qa-*` users
//                   and the runner's `success+qa-*` sign-ups with their `qa-*-su*` worlds) and their
//                   orphan `tm-qa-*` schedules, deletes the accounts never confirmed (48 h) and retires
//                   the dormant self-signup accounts (phone leases of QA expire by their own TTL)
//   NIGHTLY_PASS    04:00 ART: resets the invited guest worlds (`gNN`, `gtest`) with activity that
//                   nobody touched for 24 real hours (a pristine world is left alone)
//
// Every pass is idempotent and reads the real clock only.
import { guestOriginOf } from "@reclamo/shared";
import { qaSignupWorld } from "../auth/guest-identity";
import { type AccountSummary, type Budget, type WorldsDeps, outOfTime } from "./deps";
import { destroyWorld, destroyable } from "./destroy";
import { deleteUnconfirmedAccounts, expiryPass, retireDormantAccounts } from "./guest-expiry";
import { guestWorldsIn, provisionPass } from "./guest-provision";
import { COUNTED_STATUSES, SIGNUP_WORLD_CLASSES, healCapacity, readCapacity } from "./meta";
import { requestAndStartReset, resumeStaleReset } from "./reset";

const HOUR_MS = 3_600_000;
export const QA_WORLD_MAX_AGE_MS = 6 * HOUR_MS;
export const GUEST_IDLE_RESET_MS = 24 * HOUR_MS;
/** Usernames of the scenario runner's sign-ups (`success+qa-<runId>-su<n>@simulator.amazonses.com`). */
const QA_SIGNUP_USERNAME_PREFIX = "success+qa-";

/** The worlds `seed:load` and `console:invite` create (no index lists them: they are a closed set). */
export const SEEDED_WORLDS = ["demo", "qamin", "gprobe"] as const;
export const INVITED_GUEST_WORLDS: readonly string[] = ["gtest", ...Array.from({ length: 99 }, (_, index) => `g${String(index + 1).padStart(2, "0")}`)];

/** Recounts `GUESTCAP#ACTIVE` and `GUESTCAP#QA` from their queues (only when a count stood still, worlds/meta.ts). */
async function healGuestCapacity(deps: WorldsDeps): Promise<void> {
  for (const worldClass of SIGNUP_WORLD_CLASSES) {
    const read = await readCapacity(deps, worldClass);
    const lists = await Promise.all(COUNTED_STATUSES.map((status) => guestWorldsIn(deps, status, worldClass)));
    const counted = { active: lists.reduce((sum, list) => sum + list.length, 0), creating: lists[COUNTED_STATUSES.indexOf("CREATING")]?.length ?? 0 };
    if (await healCapacity(deps, read, counted)) deps.log.warn("worlds.guest_capacity_healed", { worldClass, from: read.active, to: counted.active, creating: counted.creating });
  }
}

export async function runProvisionPass(deps: WorldsDeps): Promise<Record<string, number>> {
  const expiry = await expiryPass(deps);
  const provision = await provisionPass(deps);
  await healGuestCapacity(deps);
  return { ...provision, expiring: expiry.expiring, resumedResets: expiry.resumed };
}

/** The world a QA account may hold: `custom:worldId` of a `qa-*` user, or the world a runner's sign-up names. */
function qaWorldOf(account: AccountSummary): string | undefined {
  if (account.username.startsWith("qa-")) return account.username.includes("@") ? undefined : account.worldId;
  return qaSignupWorld(account.username);
}

async function qaCleanup(deps: WorldsDeps, budget: Budget): Promise<{ worlds: number; users: number }> {
  if (!deps.accounts) return { worlds: 0, users: 0 };
  const cutoff = deps.now().getTime() - QA_WORLD_MAX_AGE_MS;
  let worlds = 0;
  let users = 0;
  const accounts = [...(await deps.accounts.list({ usernamePrefix: "qa-" })), ...(await deps.accounts.list({ usernamePrefix: QA_SIGNUP_USERNAME_PREFIX }))];
  for (const account of accounts) {
    if (outOfTime(budget)) break;
    const worldId = qaWorldOf(account);
    // Only `qa-*` users without `@` and the runner's own sign-ups: never a visitor's account.
    if ((account.username.includes("@") && worldId === undefined) || account.createdAt.getTime() > cutoff) continue;
    if (worldId && destroyable(worldId)) {
      const meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
      const created = meta?.createdAt ? Date.parse(meta.createdAt) : 0;
      if (meta && created <= cutoff && (await destroyWorld(deps, worldId, budget)) === "DESTROYED") worlds += 1;
    }
    await deps.accounts.delete(account.username);
    users += 1;
  }
  return { worlds, users };
}

/** A `tm-qa-*` schedule whose world is gone, or whose epoch is tombstoned, would only be discarded: delete it. */
async function orphanSchedules(deps: WorldsDeps): Promise<number> {
  if (!deps.schedules.list) return 0;
  let names: string[];
  try {
    names = await deps.schedules.list("tm-qa-");
  } catch (error) {
    deps.log.warn("worlds.schedules_unlisted", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    const match = /^tm-(qa-[a-z0-9-]+)-e(\d+)-[a-z2-7]{16}$/.exec(name);
    if (!match?.[1]) continue;
    const [worldId, epoch] = [match[1], Number(match[2])];
    const meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
    const orphan = !meta || meta.epoch > epoch || (await deps.connector.runtime.getTombstone(worldId, epoch)) !== undefined;
    if (!orphan) continue;
    await deps.schedules.delete(name);
    deleted += 1;
  }
  return deleted;
}

export async function runHourlyPass(deps: WorldsDeps, budget: Budget): Promise<Record<string, number>> {
  let resumed = 0;
  for (const worldId of [...SEEDED_WORLDS, ...INVITED_GUEST_WORLDS]) {
    if (outOfTime(budget)) break;
    if ((await resumeStaleReset(deps, worldId)) !== "NOT_STALE") resumed += 1;
  }
  const qa = await qaCleanup(deps, budget);
  const schedules = await orphanSchedules(deps);
  const unconfirmed = await deleteUnconfirmedAccounts(deps);
  const retired = await retireDormantAccounts(deps);
  return { resumed, qaWorlds: qa.worlds, qaUsers: qa.users, schedules, unconfirmed, retired };
}

/** The last time anyone touched an invited guest world, and whether it changed since it was last fresh. */
async function idleSince(deps: WorldsDeps, worldId: string): Promise<number | undefined> {
  const meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
  if (meta?.status !== "READY" || guestOriginOf(worldId) !== "INVITED") return undefined;
  const clock = await deps.connector.runtime.getClock(worldId);
  const touched = [clock?.lastSession?.lastActiveAtReal, meta.lastActivityAtReal].flatMap((at) => (at ? [Date.parse(at)] : []));
  const fresh = Math.max(...[meta.readyAtReal, meta.lastResetAtReal].flatMap((at) => (at ? [Date.parse(at)] : [0])));
  const last = touched.length > 0 ? Math.max(...touched) : undefined;
  return last !== undefined && last > fresh ? last : undefined;
}

export async function runNightlyPass(deps: WorldsDeps, budget: Budget): Promise<Record<string, number>> {
  let reset = 0;
  for (const worldId of INVITED_GUEST_WORLDS) {
    if (outOfTime(budget)) break;
    const last = await idleSince(deps, worldId);
    if (last === undefined || deps.now().getTime() - last < GUEST_IDLE_RESET_MS) continue;
    try {
      await requestAndStartReset(deps, { worldId, actor: "SYSTEM", reason: "NIGHTLY_IDLE" });
      reset += 1;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "CONFLICT")) throw error;
    }
  }
  return { reset };
}
