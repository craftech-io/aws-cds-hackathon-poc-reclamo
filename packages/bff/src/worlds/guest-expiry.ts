// Expiry of the self-signup worlds and retention of their accounts (docs/architecture-guests.md §6),
// all on the REAL clock:
//
//   - a `READY` `gs-*` world expires 6 h after `READY` without any sign-in (`lastActivityAtReal`
//     absent), after 72 h without activity, or 7 days after `READY` (a runner's `qa-*-su*` world also
//     6 h after `READY` whatever its activity, so a place a run left always comes back): the expiry request
//     (worlds/reset.ts, `EXPIRE`) and the work without `RELOAD` (worlds/reset-work.ts) leave it
//     `EXPIRED` with a new epoch, keeping `META`, `SETTINGS`, `STAFF#`, the register, the tape and the
//     audit log; the account and the lead stay, and the next sign-in asks for the world again;
//   - an expiry or reset of a `gs-*` world whose heartbeat is stale is resumed, and a world `leads:delete`
//     left `EXPIRING` with no request gets the expiry request it lacks (worlds/reset.ts `adopt`);
//   - accounts never confirmed are deleted after 48 h (only names with `@` in `UNCONFIRMED`: the code
//     fences it, IAM cannot), and a self-signup account whose world has been `EXPIRED` for 24 months
//     (no sign-in since) is retired: user deleted, staff row inactive, world rows and lead left to
//     expire by TTL (ADR-0021 §3: one retention for the account and the lead).
import { type SignupWorldClass, ToolError } from "@reclamo/shared";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import { cond } from "../connector/store";
import { GUEST_WORLD_LIMITS, QA_GUEST_WORLD_LIMITS } from "../leads/limits";
import type { WorldsDeps } from "./deps";
import { guestWorldsIn } from "./guest-provision";
import { SIGNUP_WORLD_CLASSES, metaUpdateOp, rawMeta } from "./meta";
import { requestAndStartReset, resumeStaleReset } from "./reset";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const UNCONFIRMED_ACCOUNT_MS = 48 * HOUR_MS;
/** 24 months (ADR-0021 §3). */
export const DORMANT_ACCOUNT_MS = 730 * DAY_MS;
/** Rows of a retired world disappear 30 days later (docs/architecture-guests.md §11). */
const RETIRED_ROWS_TTL_SECONDS = 30 * 24 * 3_600;

export type ExpiryReason = "NO_SIGN_IN" | "INACTIVE" | "MAX_AGE";

const MAX_AGE_MS: Readonly<Record<SignupWorldClass, number>> = {
  SIGNUP: GUEST_WORLD_LIMITS.expireAfterReadyDays * DAY_MS,
  QA: QA_GUEST_WORLD_LIMITS.expireAfterReadyHours * HOUR_MS,
};

/** Why a `READY` self-signup world expires now, or `undefined` while it may stay. */
export function expiryReasonOf(meta: { readonly readyAtReal?: string; readonly lastActivityAtReal?: string }, now: Date, worldClass: SignupWorldClass = "SIGNUP"): ExpiryReason | undefined {
  const ready = meta.readyAtReal ? Date.parse(meta.readyAtReal) : Number.NaN;
  if (Number.isNaN(ready)) return undefined;
  const at = now.getTime();
  if (at - ready >= MAX_AGE_MS[worldClass]) return "MAX_AGE";
  if (!meta.lastActivityAtReal) return at - ready >= GUEST_WORLD_LIMITS.expireWithoutSignInHours * HOUR_MS ? "NO_SIGN_IN" : undefined;
  return at - Date.parse(meta.lastActivityAtReal) >= GUEST_WORLD_LIMITS.expireWithoutActivityHours * HOUR_MS ? "INACTIVE" : undefined;
}

export interface ExpiryPassResult {
  readonly expiring: number;
  readonly resumed: number;
}

/** The expiry half of the 5-minute pass (see the header). */
export async function expiryPass(deps: WorldsDeps): Promise<ExpiryPassResult> {
  let expiring = 0;
  for (const worldClass of SIGNUP_WORLD_CLASSES) {
    for (const worldId of await guestWorldsIn(deps, "READY", worldClass)) {
      const meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
      const reason = meta?.status === "READY" ? expiryReasonOf(meta, deps.now(), worldClass) : undefined;
      if (!reason) continue;
      try {
        await requestAndStartReset(deps, { worldId, actor: "SYSTEM", kind: "EXPIRE", reason });
        expiring += 1;
      } catch (error) {
        // A reset the guest asked for in the meantime wins; the next pass looks again.
        if (!(error instanceof Error && "code" in error && error.code === "CONFLICT")) throw error;
      }
    }
    for (const worldId of await guestWorldsIn(deps, "EXPIRING", worldClass)) {
      const meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
      if (meta?.status !== "EXPIRING" || meta.reset !== undefined) continue;
      try {
        await requestAndStartReset(deps, { worldId, actor: "SYSTEM", kind: "EXPIRE", reason: "LEAD_DELETED", adopt: true });
        expiring += 1;
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        deps.log.warn("worlds.expiry_not_adopted", { worldId, code: error.code });
      }
    }
  }
  let resumed = 0;
  for (const worldClass of SIGNUP_WORLD_CLASSES) {
    for (const status of ["EXPIRING", "RESETTING"]) {
      for (const worldId of await guestWorldsIn(deps, status, worldClass)) if ((await resumeStaleReset(deps, worldId)) !== "NOT_STALE") resumed += 1;
    }
  }
  return { expiring, resumed };
}

/** Accounts that never confirmed their email, after 48 h (names with `@` only). */
export async function deleteUnconfirmedAccounts(deps: WorldsDeps): Promise<number> {
  if (!deps.accounts) return 0;
  const cutoff = deps.now().getTime() - UNCONFIRMED_ACCOUNT_MS;
  let deleted = 0;
  for (const account of await deps.accounts.list({ status: "UNCONFIRMED" })) {
    if (account.status !== "UNCONFIRMED" || !account.username.includes("@") || account.createdAt.getTime() > cutoff) continue;
    await deps.accounts.delete(account.username);
    deleted += 1;
  }
  if (deleted > 0) deps.log.info("worlds.unconfirmed_accounts_deleted", { count: deleted });
  return deleted;
}

async function ttlAt(deps: WorldsDeps, table: "Worlds" | "Leads", key: { pk: string; sk: string }, expiresAt: number): Promise<void> {
  try {
    await deps.store.write({ kind: "update", table, key, condition: cond.present(), update: { set: { expiresAt } } });
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

async function retire(deps: WorldsDeps, worldId: string): Promise<void> {
  const now = deps.now();
  const expiresAt = Math.floor(now.getTime() / 1000) + RETIRED_ROWS_TTL_SECONDS;
  for (const staff of await deps.connector.worlds.listStaff(worldId)) {
    const sub = staff.cognitoSubKey.slice("SUB#".length);
    for (const account of (await deps.accounts?.list({ sub })) ?? []) if (account.username.includes("@")) await deps.accounts?.delete(account.username);
    await deps.connector.worlds.setStaffActive(worldId, staff.staffId, false);
    await ttlAt(deps, "Worlds", keys.staff(worldId, staff.staffId), expiresAt);
    // The lead goes with its account: the TTL deletes it (the janitor only updates `LEAD#`).
    await ttlAt(deps, "Leads", { pk: `LEAD#${sub}`, sk: "META" }, Math.floor(now.getTime() / 1000));
  }
  await ttlAt(deps, "Worlds", keys.worldSettings(worldId), expiresAt);
  await deps.connector.write(metaUpdateOp(deps, { worldId, from: "EXPIRED", set: { expiresAt, retiredAtReal: now.toISOString() }, remove: ["guestIndexKey", "guestIndexSort"] }));
  await deps.connector.audit.append({
    worldId,
    epoch: await deps.connector.counters.getEpoch(worldId),
    auditId: `aud-${deps.newId().toLowerCase()}`,
    ts: now.toISOString(),
    action: "GUEST_ACCOUNT_RETIRED",
    actor: "SYSTEM",
    refs: { worldId },
  });
}

/** Self-signup accounts whose world has been `EXPIRED` for 24 months (see the header). */
export async function retireDormantAccounts(deps: WorldsDeps): Promise<number> {
  const cutoff = deps.now().getTime() - DORMANT_ACCOUNT_MS;
  let retired = 0;
  const expired = await Promise.all(SIGNUP_WORLD_CLASSES.map((worldClass) => guestWorldsIn(deps, "EXPIRED", worldClass)));
  for (const worldId of expired.flat()) {
    const meta = await rawMeta(deps, worldId);
    const expiredAt = typeof meta?.expiredAtReal === "string" ? Date.parse(meta.expiredAtReal) : Number.NaN;
    if (meta?.status !== "EXPIRED" || !(expiredAt <= cutoff)) continue;
    await retire(deps, worldId);
    retired += 1;
  }
  return retired;
}
