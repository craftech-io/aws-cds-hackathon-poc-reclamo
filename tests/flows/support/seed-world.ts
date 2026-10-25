// A world of the seed in memory (docs/seed-spec.md §1, §4, §15): one template of
// `scripts/seed/data/worlds/<template>.json`, instantiated for a world id and epoch exactly as the world
// factory does (only `<worldId>` and `<epoch>` substituted, `scripts/seed/lib/template.ts`), then
// written where the stage keeps it:
//
//   Core          the core mock's store, with `phoneHash`/`emailHash` recomputed with the local
//                 `PhoneHashKey` and the `PHONE#` claims the factory writes
//   Networks      the network mock's store (`rawItem`), and every published settlement file of the
//                 template at its `s3Key`
//   Seed          the template's synthetic receipts (`receipts/<variant>/<id>.png`)
//   Worlds        `META` (`READY`), `SETTINGS` (the template's, by origin for a guest world) and the
//                 staff rows of the console
//   the rest      complaints, case items, chains, audit, counter, timers, conversations and the paused
//                 clock through the repositories (seed-history.ts)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type GuestOrigin, type StaffRole, guestOriginOf, worldKindOf } from "@reclamo/shared";
import { rawItem, type EntityName } from "@reclamo/network-mock/store/items";
import type { NewOf } from "@reclamo/bff/connector/codec";
import type { Connector } from "@reclamo/bff/connector/port";
import type { AnchorRequester } from "@reclamo/bff/complaints/anchors";
import type { WorldSettings, WorldTemplate } from "@reclamo/bff/domain/world";
import { createLogger } from "@reclamo/bff/lib/log";
import { seedPaths } from "../../../scripts/seed/lib/constants";
import { type ReceiptRef, type TemplateItem, WorldTemplateFile, instantiate } from "../../../scripts/seed/lib/template";
import { LOCAL_KEYS, phoneHashOf } from "./keys";
import { writeBffItems } from "./seed-history";
import { type InProcessMocks, hashEmail } from "./mocks";
import type { FakeS3 } from "./fakes/s3";

export type SeedTemplate = "demo" | "guest" | "qa-min";

export type SeedPersona = WorldTemplateFile["personas"][number];

/** A console user of a seeded world: its row in `Worlds` and the Cognito `sub` it is bound to. */
export interface SeedStaff {
  readonly staffId: string;
  readonly role: StaffRole;
  readonly username: string;
  readonly sub: string;
}

export interface SeededWorld {
  readonly worldId: string;
  readonly epoch: number;
  readonly template: SeedTemplate;
  /** The paused simulated instant the world starts at. */
  readonly startAtSim: string;
  readonly personas: readonly SeedPersona[];
  readonly receipts: readonly ReceiptRef[];
  readonly staff: readonly SeedStaff[];
}

export interface SeedTargets {
  readonly connector: Connector;
  /** `AnchorWriter` of the world: the factory anchors every chain entry it writes. */
  readonly anchors: AnchorRequester;
  readonly mocks: InProcessMocks;
  readonly s3: FakeS3;
  /** Real time of the stamps. */
  readonly now: () => Date;
}

export interface SeedWorldInput {
  readonly worldId: string;
  readonly template: SeedTemplate;
  readonly epoch?: number;
  /** The console users; by default the ones of the world's class (`defaultStaff`). */
  readonly staff?: readonly SeedStaff[];
}

const paths = seedPaths();
const templates = new Map<SeedTemplate, WorldTemplateFile>();

/** The template file, parsed once per process (the large ones are several megabytes). */
export function templateFile(template: SeedTemplate): WorldTemplateFile {
  let file = templates.get(template);
  if (file === undefined) {
    file = WorldTemplateFile.parse(JSON.parse(readFileSync(join(paths.worlds, `${template}.json`), "utf8")));
    templates.set(template, file);
  }
  return file;
}

function staffRow(worldId: string, staffId: string, role: StaffRole, username: string): SeedStaff {
  return { staffId, role, username, sub: `local-sub-${worldId}-${staffId}` };
}

/** Operator, supervisor and compliance in `demo` and QA worlds; the guest of a guest world. */
export function defaultStaff(worldId: string): SeedStaff[] {
  const kind = worldKindOf(worldId);
  if (kind === "GUEST") {
    const number = /^g(\d{2})$/.exec(worldId)?.[1];
    return [staffRow(worldId, number === undefined ? `stf-guest-${worldId}` : `stf-guest-${number}`, "GUEST", number === undefined ? `guest-${worldId}` : `guest-${number}`)];
  }
  const prefix = kind === "DEMO" ? "" : "qa-";
  const suffix = kind === "DEMO" ? "-01" : "";
  return (["OPERATOR", "SUPERVISOR", "COMPLIANCE"] as const).map((role) => {
    const name = `${prefix}${role.toLowerCase()}${suffix}`;
    return staffRow(worldId, `stf-${name}`, role, kind === "DEMO" ? name : `${prefix}${worldId}-${role.toLowerCase()}`);
  });
}

function settingsOf(file: WorldTemplateFile, worldId: string, origin: GuestOrigin | undefined): NewOf<typeof WorldSettings> {
  const byOrigin = origin === undefined ? undefined : file.settingsByOrigin?.[origin];
  const { version: _version, synthetic: _synthetic, ...settings } = { ...file.settings, ...(byOrigin ?? {}) } as Record<string, unknown>;
  return { ...settings, worldId } as NewOf<typeof WorldSettings>;
}

async function coreItems(items: readonly TemplateItem[]): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const item of items) {
    const row: Record<string, unknown> = { pk: item.pk, sk: item.sk, entity: item.entity, ...item.data };
    if (item.entity === "Customer" && typeof row.phoneE164 === "string" && typeof row.email === "string") {
      row.phoneHash = await phoneHashOf(row.phoneE164);
      row.emailHash = hashEmail(row.email);
      const world = item.pk.slice(0, item.pk.indexOf("#CUS#") + 1);
      rows.push({ pk: `${world}PHONE#${row.phoneHash}`, sk: "CLAIM", entity: "PhoneClaim", customerId: row.customerId });
    }
    rows.push(row);
  }
  return rows;
}

function readSeedFile(...parts: string[]): Buffer {
  return readFileSync(join(...parts));
}

/** Writes one template as `worldId` into the stores of an in-process world. */
export async function seedWorld(targets: SeedTargets, input: SeedWorldInput): Promise<SeededWorld> {
  const file = templateFile(input.template);
  const epoch = input.epoch ?? 1;
  const { worldId } = input;
  const kind = worldKindOf(worldId);
  if (kind === undefined) throw new RangeError(`not a world id: ${worldId}`);
  const items = instantiate(file.items, worldId, epoch);
  const now = targets.now();

  targets.mocks.coreStore.seed((await coreItems(items.filter((item) => item.table === "Core"))) as never);
  for (const item of items.filter((candidate) => candidate.table === "Networks")) {
    targets.mocks.networkStore.putRaw(rawItem(item.entity as EntityName, worldId, item, item.data, now));
  }
  for (const settlement of file.settlements) {
    if (settlement.seedPath === undefined) continue;
    targets.mocks.settlementFiles.set(`W/${worldId}/${settlement.seedPath}`, readSeedFile(paths.settlements, input.template, settlement.seedPath).toString("utf8"));
  }
  for (const receipt of file.receipts) targets.s3.put("Seed", receipt.seedKey, readSeedFile(paths.media, receipt.seedKey), "image/png");

  const origin = guestOriginOf(worldId);
  const template: WorldTemplate = input.template;
  await targets.connector.worlds.register({ worldId, kind, template, epoch, status: "READY", ...(origin === undefined ? {} : { origin, readyAtReal: now.toISOString() }) });
  await targets.connector.worlds.putSettings(settingsOf(file, worldId, origin));
  await targets.connector.transact([targets.connector.counters.initEpochOp(worldId, epoch)]);
  const staff = input.staff ?? defaultStaff(worldId);
  for (const row of staff) {
    await targets.connector.worlds.putStaff({ worldId, staffId: row.staffId, role: row.role, displayName: row.username, cognitoSubKey: `SUB#${row.sub}`, active: true });
  }
  const history = { connector: targets.connector, chainKey: LOCAL_KEYS.registerChain, anchors: targets.anchors, log: createLogger({ sink: () => undefined }), realNow: targets.now };
  await writeBffItems(targets.connector, history, { worldId, epoch, items: items.filter((item) => item.table !== "Core" && item.table !== "Networks" && item.table !== "Worlds") });
  return { worldId, epoch, template: input.template, startAtSim: file.startAtSim, personas: file.personas, receipts: file.receipts, staff };
}
