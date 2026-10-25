// A template made concrete for one world and one epoch (docs/architecture.md §10, docs/seed-spec.md §4):
//
//   - `<worldId>` and `<epoch>` are the only substitutions (an `"<epoch>"` value becomes the number);
//   - what a stage secret decides is recomputed: `phoneHash`/`emailHash` with `PhoneHashKey` (and the
//     `PHONE#` claim of every customer), the tape's `customerRef` with `RegisterChainKey`, and the three
//     hash chains, rebuilt entry by entry by the factory (the template only fixes their order);
//   - the clear phone, email, document and address the template keeps for that purpose never reach a
//     table;
//   - `SETTINGS` take the caps of the world's origin (`guest`: `INVITED` or `SIGNUP`, ADR-0020) and
//     WhatsApp is `simulated` in every world that may never run live (ADR-0002);
//   - object keys move under the world root (`W/<w>/`, `qa/<runId>/<w>/`, docs/architecture.md §6).
//
// The result is plain data in a fixed order; worlds/factory.ts writes it block by block.
import { ConnectorError, addressHash, guestOriginOf, mayRunLive, normalizeEmail, worldKindOf } from "@reclamo/shared";
import { worldObjectRoot } from "../channels/email/config";
import type { StoredItem } from "../connector/store";
import { hmacSha256Hex } from "../lib/crypto";
import { customerRefOf } from "../outbound/tape";
import type { WorldKeys } from "./deps";
import { EPOCH_TOKEN, type FactoryTemplate, type TemplateDocument, type TemplateRow, WORLD_TOKEN, settlementSeedKey } from "./template";

/**
 * Key of the tape's `customerRef` in the template (scripts/seed/lib/constants.ts
 * `TEST_CUSTOMER_REF_KEY`): only used to recognise which customer an entry names.
 */
export const TEMPLATE_CUSTOMER_REF_KEY = "seed-template-customer-ref-v1";

/** Fields of a template customer that exist only so the factory can hash them. */
const CLEAR_CUSTOMER_FIELDS = new Set(["phoneE164", "email", "docNumber", "address"]);

export type Modeled = { readonly entity: string; readonly data: Record<string, unknown> };
export type ChainName = "REG" | "RRI" | "TAPE";

export interface WorldBuild {
  readonly worldId: string;
  readonly epoch: number;
  readonly template: FactoryTemplate;
  readonly settings: Record<string, unknown>;
  /** Items of the mocks' tables, written as they are (`Core`, `Networks`) and the world's runtime rows. */
  readonly core: readonly StoredItem[];
  readonly networks: readonly StoredItem[];
  readonly runtime: readonly StoredItem[];
  readonly clock: Record<string, unknown>;
  /** Entities the BFF repositories write with their index attributes. */
  readonly complaints: readonly Modeled[];
  readonly timers: readonly Modeled[];
  readonly conversations: readonly Modeled[];
  /** Entries without `prevHash`/`hash`, in `seq` order. */
  readonly chains: Readonly<Record<ChainName, readonly Record<string, unknown>[]>>;
  readonly audit: readonly Record<string, unknown>[];
  /** Published settlement files: `Seed/` key → `Settlements/` key. */
  readonly files: readonly { readonly seedKey: string; readonly key: string }[];
  /** Every customer of the world (a reload clears their identity-challenge ledgers). */
  readonly customerIds: readonly string[];
  /** Phones of `SeedOverrides.personaPhones` (demo only): `LIVEPHONE#` rows `seed:load` writes. */
  readonly livePhones: readonly { readonly phoneHash: string; readonly customerId: string }[];
}

export interface InstantiateOptions {
  readonly worldId: string;
  readonly epoch: number;
  readonly keys: WorldKeys;
  /** `customerId → E.164` of a demo phone; refused for any world but `demo`. */
  readonly livePhones?: Readonly<Record<string, string>>;
}

function fill(value: unknown, worldId: string, epoch: number): unknown {
  if (value === EPOCH_TOKEN) return epoch;
  if (typeof value === "string") return value.split(WORLD_TOKEN).join(worldId).split(EPOCH_TOKEN).join(String(epoch));
  if (Array.isArray(value)) return value.map((member) => fill(member, worldId, epoch));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, member]) => [name, fill(member, worldId, epoch)]));
  return value;
}

function concrete(row: TemplateRow, worldId: string, epoch: number): { pk: string; sk: string; data: Record<string, unknown> } {
  return { pk: fill(row.pk, worldId, epoch) as string, sk: fill(row.sk, worldId, epoch) as string, data: fill(row.data, worldId, epoch) as Record<string, unknown> };
}

function stringField(data: Record<string, unknown>, name: string, entity: string): string {
  const value = data[name];
  if (typeof value !== "string" || value === "") throw new ConnectorError("VALIDATION", `template ${entity} has no ${name}`, "Seed");
  return value;
}

/** The settings of the world: the template's, the origin's caps on top, WhatsApp fenced. */
export function settingsFor(template: TemplateDocument, worldId: string, epoch: number): Record<string, unknown> {
  const base = fill(template.settings, worldId, epoch) as Record<string, unknown>;
  const origin = guestOriginOf(worldId) ?? (worldKindOf(worldId) === "QA" && /-su\d+$/.test(worldId) ? "SIGNUP" : undefined);
  const overlay = origin ? (template.settingsByOrigin?.[origin] ?? {}) : {};
  const { version: _version, createdAt: _created, updatedAt: _updated, ...rest } = { ...base, ...overlay } as Record<string, unknown>;
  const modes = (rest.channelModes ?? {}) as Record<string, unknown>;
  return { ...rest, worldId, channelModes: { ...modes, whatsapp: mayRunLive(worldId) ? (modes.whatsapp ?? "simulated") : "simulated" } };
}

async function customerItems(row: { pk: string; sk: string; data: Record<string, unknown> }, options: InstantiateOptions, livePhones: WorldBuild["livePhones"][number][]): Promise<StoredItem[]> {
  const customerId = stringField(row.data, "customerId", "Customer");
  const phone = stringField(row.data, "phoneE164", "Customer");
  const phoneHash = await addressHash("WHATSAPP", phone, options.keys.phoneHash);
  const email = typeof row.data.email === "string" ? row.data.email : undefined;
  const kept = Object.fromEntries(Object.entries(row.data).filter(([name]) => !CLEAR_CUSTOMER_FIELDS.has(name)));
  const claim = (hash: string): StoredItem => ({ pk: `W#${options.worldId}#PHONE#${hash}`, sk: "CLAIM", entity: "PhoneClaim", customerId, synthetic: true });
  const items: StoredItem[] = [];
  const live = options.livePhones?.[customerId];
  const customer: StoredItem = {
    ...kept,
    pk: row.pk,
    sk: row.sk,
    entity: "Customer",
    phoneHash,
    ...(email ? { emailHash: hmacSha256Hex(options.keys.emailHash, normalizeEmail(email)) } : {}),
    ...(live ? { liveE164: live } : {}),
  };
  items.push(customer, claim(phoneHash));
  if (live) {
    const liveHash = await addressHash("WHATSAPP", live, options.keys.phoneHash);
    if (liveHash !== phoneHash) items.push(claim(liveHash));
    livePhones.push({ phoneHash: liveHash, customerId });
  }
  return items;
}

/** `W/<w>/…` of a template object key under the world's real root. */
function rooted(key: string, worldId: string): string {
  const prefix = `W/${worldId}/`;
  return key.startsWith(prefix) ? `${worldObjectRoot(worldId)}${key.slice(prefix.length)}` : key;
}

function rawItem(row: { pk: string; sk: string; data: Record<string, unknown> }, entity: string, worldId: string): StoredItem {
  const data = { ...row.data };
  if (typeof data.s3Key === "string") data.s3Key = rooted(data.s3Key, worldId);
  return { ...data, pk: row.pk, sk: row.sk, entity };
}

/** `inFlight` is a string set that `ADD` creates: an empty list in the row would make every `ADD` fail. */
function worldStateItem(item: StoredItem): StoredItem {
  const { inFlight: _inFlight, ...rest } = item;
  return rest as StoredItem;
}

function bySeq(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.sort((a, b) => Number(a.seq) - Number(b.seq));
}

/** `customerRef` of the template (keyed with the template key) → the world's (keyed with `RegisterChainKey`). */
function customerRefs(customerIds: readonly string[], options: InstantiateOptions): Map<string, string> {
  return new Map(customerIds.map((customerId) => [hmacSha256Hex(TEMPLATE_CUSTOMER_REF_KEY, customerId), customerRefOf(options.keys.chainKey, options.worldId, customerId)]));
}

/**
 * The tape's key has no epoch (`W#<w>#TAPE#<day>` / `<atSim>#<tapeId>`) and the old epoch's entries stay
 * (append-only): from the second epoch on, the seeded ids carry it, and so do the messages citing them.
 */
export function tapeIdAt(tapeId: string, epoch: number): string {
  return epoch <= 1 ? tapeId : `${tapeId}-e${epoch}`;
}

function chainEntry(data: Record<string, unknown>): Record<string, unknown> {
  const { hash: _hash, prevHash: _prev, createdAt: _created, updatedAt: _updated, version: _version, ...entry } = data;
  return entry;
}

interface Sorted {
  core: StoredItem[];
  networks: StoredItem[];
  runtime: StoredItem[];
  clock?: Record<string, unknown>;
  complaints: Modeled[];
  timers: Modeled[];
  conversations: Modeled[];
  reg: Record<string, unknown>[];
  rri: Record<string, unknown>[];
  tape: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

function refused(row: TemplateRow): ConnectorError {
  return new ConnectorError("VALIDATION", `the factory does not write ${row.entity} into ${row.table}`, "Seed");
}

async function sortRows(template: TemplateDocument, options: InstantiateOptions, livePhones: WorldBuild["livePhones"][number][]): Promise<Sorted> {
  const sorted: Sorted = { core: [], networks: [], runtime: [], complaints: [], timers: [], conversations: [], reg: [], rri: [], tape: [], audit: [] };
  for (const row of template.items) {
    const item = concrete(row, options.worldId, options.epoch);
    switch (row.table) {
      case "Worlds":
        if (row.entity !== "WorldSettings") throw refused(row);
        break; // the settings come from `settings` + `settingsByOrigin`
      case "Core":
        if (row.entity === "Customer") sorted.core.push(...(await customerItems(item, options, livePhones)));
        else sorted.core.push(rawItem(item, row.entity, options.worldId));
        break;
      case "Networks":
        sorted.networks.push(rawItem(item, row.entity, options.worldId));
        break;
      case "Complaints":
        sorted.complaints.push({ entity: row.entity, data: item.data });
        break;
      case "Timers":
        sorted.timers.push({ entity: row.entity, data: item.data });
        break;
      case "Conversations": {
        const data = typeof item.data.tapeRef === "string" ? { ...item.data, tapeRef: tapeIdAt(item.data.tapeRef, options.epoch) } : item.data;
        sorted.conversations.push({ entity: row.entity, data });
        break;
      }
      case "Register":
        (row.entity === "RefundEntry" ? sorted.rri : sorted.reg).push(chainEntry(item.data));
        break;
      case "ComplianceTape": {
        const entry = chainEntry(item.data);
        sorted.tape.push(typeof entry.tapeId === "string" ? { ...entry, tapeId: tapeIdAt(entry.tapeId, options.epoch) } : entry);
        break;
      }
      case "AuditLog":
        sorted.audit.push(item.data);
        break;
      case "Runtime":
        if (row.entity === "StoredClock") sorted.clock = item.data;
        else if (row.entity === "Counter") sorted.runtime.push(rawItem(item, row.entity, options.worldId));
        else if (row.entity === "WorldState") sorted.runtime.push(worldStateItem(rawItem(item, row.entity, options.worldId)));
        else if (row.entity !== "ChainHead") throw refused(row); // chain heads move with every append
        break;
    }
  }
  return sorted;
}

/** The world of `template` for `options.worldId` at `options.epoch` (see the header). */
export async function instantiate(template: TemplateDocument, options: InstantiateOptions): Promise<WorldBuild> {
  if (options.livePhones && Object.keys(options.livePhones).length > 0 && options.worldId !== "demo") {
    throw new ConnectorError("VALIDATION", "persona phones apply only to the demo world", "Seed");
  }
  const livePhones: WorldBuild["livePhones"][number][] = [];
  const sorted = await sortRows(template, options, livePhones);
  if (!sorted.clock) throw new ConnectorError("VALIDATION", `template ${template.template} has no clock`, "Seed");
  const customerIds = sorted.core.filter((item) => item.entity === "Customer").map((item) => String(item.customerId));
  const refs = customerRefs(customerIds, options);
  const tape = sorted.tape.map((entry) => {
    const ref = typeof entry.customerRef === "string" ? refs.get(entry.customerRef) : undefined;
    if (entry.customerRef !== undefined && ref === undefined) throw new ConnectorError("VALIDATION", "a tape entry names a customer the template does not have", "Seed");
    return ref === undefined ? entry : { ...entry, customerRef: ref };
  });
  const files = template.settlements.flatMap((file) =>
    file.status === "PUBLISHED" && file.seedPath ? [{ seedKey: settlementSeedKey(template.template, file.seedPath), key: `${worldObjectRoot(options.worldId)}${file.seedPath}` }] : [],
  );
  return {
    worldId: options.worldId,
    epoch: options.epoch,
    template: template.template,
    settings: settingsFor(template, options.worldId, options.epoch),
    core: sorted.core,
    networks: sorted.networks,
    runtime: sorted.runtime,
    clock: sorted.clock,
    complaints: sorted.complaints,
    timers: sorted.timers,
    conversations: sorted.conversations,
    chains: { REG: bySeq(sorted.reg), RRI: bySeq(sorted.rri), TAPE: bySeq(tape) },
    audit: sorted.audit,
    files,
    customerIds,
    livePhones,
  };
}
