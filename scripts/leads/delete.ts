// Deletion of a lead on request (docs/architecture-guests.md §10, FL-127, Ley 25.326 art. 16). An
// operator runs it with the account's profile:
//
//   npm run leads:delete -- --email <address>
//
// In this order: every session of the account signed out (the refresh token stops working; an access
// token still alive is refused by `worldProcedure` at the next step), the staff row inactive, the
// Cognito user deleted, the world sent to `EXPIRING` (the janitor wipes it; `META`, `SETTINGS` and the
// inactive `STAFF#` stay as a tombstone without personal data that expires in 30 days), the lead,
// every request of the email, its pointer and one count of its canonical address removed, and a
// `LEADDEL#<emailHash>` proof written (hash and instant only). Audited with the hash. It prints the
// hash prefix, never the address. The immutable register, tape and log of what was typed in the
// simulator (masked) are not deleted: the privacy policy says so.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectorError } from "@reclamo/shared";
import { DynamoStore } from "../../packages/bff/src/connector/dynamo/engine";
import { keys } from "../../packages/bff/src/connector/keys";
import { worldsRepo } from "../../packages/bff/src/connector/repos/worlds";
import type { TableStore, WriteOp } from "../../packages/bff/src/connector/store";
import { cond } from "../../packages/bff/src/connector/store";
import { canonicalEmail, checkEmailShape, normalizeEmail } from "../../packages/bff/src/guests/email-domain";
import { type LeadHashes, leadHashes, leadsKeys } from "../../packages/bff/src/leads/keys";
import { LEADS_TTL_SECONDS, expiresAt } from "../../packages/bff/src/leads/limits";
import { edgeAuditOp } from "../../packages/bff/src/leads/repo";
import { ulid } from "../../packages/bff/src/lib/crypto";
import { keySecret } from "../../packages/bff/src/lib/secrets";
import { parseFlags } from "../channels/cli-args";
import { poolAccounts } from "./dynamo";

export interface DeleteDeps {
  readonly store: TableStore;
  readonly hashes: LeadHashes;
  readonly accounts: { signOutEverywhere(username: string): Promise<void>; deleteAccount(username: string): Promise<void> };
  readonly now: () => Date;
}

export interface DeleteReport {
  readonly emailHashPrefix: string;
  readonly leadFound: boolean;
  readonly worldId?: string;
  readonly removed: number;
}

const TOMBSTONE_SECONDS = 30 * 24 * 3_600;

export function parseDeleteArgs(argv: readonly string[]): { readonly email: string } {
  let email: string | undefined;
  parseFlags(argv, {
    "--email": (value) => {
      email = value();
    },
  });
  const shape = checkEmailShape(email ?? "");
  // A domain listed as disposable after the sign-up still names a lead that has to be deletable.
  if (!shape.ok && shape.reason !== "EMAIL_NOT_ACCEPTED") throw new RangeError("--email <address> needs a valid email address");
  return { email: normalizeEmail(email ?? "") };
}

/**
 * Retires a self-signup world and gives its kept rows the tombstone's TTL. A world that holds a place
 * of the quota (`CREATING`, `READY`) goes to `EXPIRING`: the janitor wipes it and frees the place. One
 * still in the queue (`REGISTERED`) holds no place and no data: it goes straight to `EXPIRED`.
 */
async function retireWorld(deps: DeleteDeps, worldId: string): Promise<void> {
  const ttl = expiresAt(deps.now(), TOMBSTONE_SECONDS);
  const at = deps.now().toISOString();
  const move = (from: readonly string[], to: "EXPIRING" | "EXPIRED"): WriteOp => ({
    kind: "update",
    table: "Worlds",
    key: keys.worldMeta(worldId),
    condition: cond.and(cond.present(), cond.in("status", [...from])),
    update: { set: { status: to, guestIndexKey: `GUEST#${to}`, guestIndexSort: `${at}#${worldId}`, expiresAt: ttl, updatedAt: at } },
  });
  let moved = false;
  for (const op of [move(["CREATING", "READY"], "EXPIRING"), move(["REGISTERED"], "EXPIRED")]) {
    try {
      await deps.store.write(op);
      moved = true;
      break;
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    }
  }
  // Already expiring, expired or gone: the tombstone TTL still applies.
  if (!moved) await deps.store.write({ kind: "update", table: "Worlds", key: keys.worldMeta(worldId), condition: cond.present(), update: { set: { expiresAt: ttl } } }).catch(() => undefined);
  for (const key of [keys.worldSettings(worldId), keys.staff(worldId, `stf-${worldId}`)]) {
    await deps.store.write({ kind: "update", table: "Worlds", key, condition: cond.present(), update: { set: { expiresAt: ttl } } }).catch(() => undefined);
  }
}

export async function deleteLead(email: string, deps: DeleteDeps): Promise<DeleteReport> {
  const emailHash = deps.hashes.emailHash(email);
  const indexed = await deps.store.query({ table: "Leads", index: "ByEmailHash", partition: leadsKeys.emailHashKey(emailHash), limit: 100 });
  const leadKey = indexed.items.find((item) => item.pk.startsWith("LEAD#"));
  const lead = leadKey ? await deps.store.get("Leads", { pk: leadKey.pk, sk: leadKey.sk }, { consistent: true }) : undefined;
  const sub = leadKey ? leadKey.pk.slice("LEAD#".length) : undefined;
  const worldId = typeof lead?.worldId === "string" ? lead.worldId : sub ? deps.hashes.guestWorldId(sub) : undefined;

  await deps.accounts.signOutEverywhere(email);
  if (worldId) {
    const staff = await worldsRepo({ store: deps.store, now: deps.now }).getStaff(worldId, `stf-${worldId}`);
    if (staff) await worldsRepo({ store: deps.store, now: deps.now }).setStaffActive(worldId, staff.staffId, false);
  }
  await deps.accounts.deleteAccount(email);
  if (worldId) await retireWorld(deps, worldId);

  const deletions: WriteOp[] = [
    ...indexed.items.map((item): WriteOp => ({ kind: "delete", table: "Leads", key: { pk: item.pk, sk: item.sk } })),
    { kind: "delete", table: "Leads", key: leadsKeys.pending(emailHash) },
  ];
  for (const op of deletions) await deps.store.write(op);
  if (lead) {
    await deps.store
      .write({ kind: "update", table: "Leads", key: leadsKeys.canon(deps.hashes.canonHash(canonicalEmail(email))), condition: cond.gt("confirmed", 0), update: { add: { confirmed: -1 } } })
      .catch(() => undefined);
  }
  const now = deps.now();
  await deps.store.write({ kind: "put", table: "Leads", item: { ...leadsKeys.deleted(emailHash, now), entity: "LeadDeleted", expiresAt: expiresAt(now, LEADS_TTL_SECONDS.deletionProof) } });
  await deps.store.write(edgeAuditOp({ action: "LEAD_DELETED", outcome: lead ? "DELETED" : "NO_LEAD", refs: { emailHash: emailHash.slice(0, 16) } }, ulid(now.getTime()), now));
  return { emailHashPrefix: emailHash.slice(0, 12), leadFound: lead !== undefined, ...(worldId ? { worldId } : {}), removed: deletions.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { email } = parseDeleteArgs(process.argv.slice(2));
    const report = await deleteLead(email, { store: new DynamoStore(), hashes: leadHashes(keySecret("PhoneHashKey")), accounts: poolAccounts(), now: () => new Date() });
    console.log(`leads:delete: ${report.leadFound ? "lead, account and requests deleted" : "no lead for that address; account and requests cleared"} (hash ${report.emailHashPrefix}…).`);
  } catch (error) {
    console.error(`leads:delete: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
