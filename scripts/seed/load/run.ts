// `seed:load` (docs/seed-spec.md §15, ADR-0021 §1), in this order:
//
//   1. `SeedOverrides` checked (at most 5 demo recipients, `@craftech.io` only; demo phones E.164),
//      before anything is written;
//   2. the fingerprint of the seed compared with the one stored in `Reference`: unchanged (and no
//      `--force`) skips the upload, `Reference` and the rebuild of the worlds;
//   3. `Seed/` uploaded (templates, receipts, settlement files, load inputs) and `Reference` written;
//   4. `demo`, `qamin` and `gprobe` created, finished or (seed changed) reset in process;
//   5. the `LIVEPHONE#` rows of the demo phones; `DEMO_RECIPIENTS_LOADED` audited with how many and
//      their keyed hashes, never the addresses;
//   6. `Runtime/SWITCH#SIGNUP = {open: true}` written only if absent (`attribute_not_exists`), audited
//      `SIGNUP_SWITCH_SEEDED`: the sign-up opens with the first load that brings the world factory, and
//      an operator's `--off` survives every later deploy;
//   7. the new fingerprint stored last, so an interrupted load runs again in full.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isConflict } from "../../../packages/bff/src/connector/errors";
import { type TableStore, cond } from "../../../packages/bff/src/connector/store";
import { signupAuditPartition, signupRuntimeKeys } from "../../../packages/bff/src/leads/keys";
import { hmacSha256Hex } from "../../../packages/bff/src/lib/crypto";
import type { WorldsDeps } from "../../../packages/bff/src/worlds/deps";
import { fingerprintOf, readManifest, seedFiles } from "./files";
import { parseOverrides } from "./overrides";
import { referenceRows, saveFingerprint, storedFingerprint, writeReference } from "./reference";
import { type WorldOutcome, ensureSeedWorlds, writeLivePhones } from "./worlds";

/** One year, like the other audit entries of the public edge. */
const AUDIT_TTL_SECONDS = 365 * 24 * 3_600;

export interface SeedUploader {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface LoadDeps {
  readonly worlds: WorldsDeps;
  readonly uploader: SeedUploader;
  /** The raw `SeedOverrides` secret (`undefined` when it is not set). */
  readonly overrides: () => string | undefined;
  /** `scripts/seed`. */
  readonly root: string;
}

export interface LoadSummary {
  readonly changed: boolean;
  readonly uploaded: number;
  readonly referenceRows: number;
  readonly worlds: Record<string, WorldOutcome>;
  readonly livePhones: number;
  readonly demoRecipients: number;
  readonly signupSwitch: "SEEDED" | "KEPT";
}

/** `customerId → E.164` of the demo phones, from the personas of the demo template. */
function demoPhonesByCustomer(root: string, personaPhones: Readonly<Record<string, string>>): Record<string, string> {
  if (Object.keys(personaPhones).length === 0) return {};
  const demo = JSON.parse(readFileSync(join(root, "data", "worlds", "demo.json"), "utf8")) as { personas: { id: string; customerId: string }[] };
  const byPersona = new Map(demo.personas.map((persona) => [persona.id, persona.customerId]));
  return Object.fromEntries(
    Object.entries(personaPhones).map(([persona, phone]) => {
      const customerId = byPersona.get(persona);
      if (!customerId) throw new Error(`SeedOverrides.personaPhones names a persona the demo world does not have (${persona})`);
      return [customerId, phone];
    }),
  );
}

/** `SWITCH#SIGNUP` open, only when no row exists (ADR-0021 §1). */
export async function seedSignupSwitch(store: TableStore, auditId: string, now: Date): Promise<"SEEDED" | "KEPT"> {
  try {
    await store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.switch(), entity: "SignupSwitch", open: true, changedAtReal: now.toISOString() }, condition: cond.absent() });
  } catch (error) {
    if (isConflict(error)) return "KEPT";
    throw error;
  }
  // The sign-up's own audit partition (no world): codes only, like every entry of the public edge.
  const ts = now.toISOString();
  await store.write({
    kind: "put",
    table: "AuditLog",
    item: { pk: signupAuditPartition(now), sk: `${ts}#${auditId}`, entity: "Decision", auditId, ts, actor: "SYSTEM", action: "SIGNUP_SWITCH_SEEDED", outcome: "OPEN", refs: { by: "seed-load" }, createdAt: ts, expiresAt: Math.floor(now.getTime() / 1000) + AUDIT_TTL_SECONDS },
    condition: cond.absent(),
  });
  return "SEEDED";
}

async function auditDemoRecipients(deps: WorldsDeps, emails: readonly string[]): Promise<void> {
  const hashes = emails.map((email) => hmacSha256Hex(deps.keys().emailHash, email));
  await deps.connector.audit.append({
    worldId: "demo",
    epoch: await deps.connector.counters.getEpoch("demo"),
    auditId: `aud-${deps.newId().toLowerCase()}`,
    ts: deps.now().toISOString(),
    action: "DEMO_RECIPIENTS_LOADED",
    actor: "SYSTEM",
    refs: { count: String(emails.length) },
    detail: { count: emails.length, hashes },
  });
}

async function upload(deps: LoadDeps, files: ReturnType<typeof seedFiles>): Promise<number> {
  for (const file of files) await deps.uploader.put(file.key, readFileSync(join(deps.root, file.path)), file.contentType);
  return files.length;
}

/** The whole load (see the header). */
export async function runSeedLoad(deps: LoadDeps, options: { readonly force: boolean }): Promise<LoadSummary> {
  const overrides = parseOverrides(deps.overrides());
  const manifest = readManifest(deps.root);
  const fingerprint = fingerprintOf(manifest, overrides.personaPhones);
  const { store } = deps.worlds;
  const changed = options.force || (await storedFingerprint(store)) !== fingerprint;
  const livePhones = demoPhonesByCustomer(deps.root, overrides.personaPhones);

  let uploaded = 0;
  let rows = 0;
  if (changed) {
    uploaded = await upload(deps, seedFiles(manifest));
    rows = await writeReference(store, referenceRows(deps.root, manifest, deps.worlds.now()));
  }
  const worlds = await ensureSeedWorlds(deps.worlds, { rebuild: changed, livePhones });
  const phones = await writeLivePhones(deps.worlds, livePhones);
  await auditDemoRecipients(deps.worlds, overrides.demoEmails);
  const signupSwitch = await seedSignupSwitch(store, deps.worlds.newId(), deps.worlds.now());
  if (changed) await saveFingerprint(store, fingerprint, deps.worlds.now());
  return { changed, uploaded, referenceRows: rows, worlds, livePhones: phones, demoRecipients: overrides.demoEmails.length, signupSwitch };
}
