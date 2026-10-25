// The world template file (`data/worlds/<template>.json`, docs/seed-spec.md §1, §4) as the world
// factory reads it: items with their definitive keys relative to the world (every partition key
// starts with `W#<worldId>#`), the settlement files, the receipts and the settings. The factory only
// substitutes `<worldId>` and `<epoch>` (`instantiate`), recomputes the hash chains with
// RegisterChainKey and derives the phone and email hashes with PhoneHashKey.
import { z } from "zod";
import { EPOCH_PLACEHOLDER, WORLD_PLACEHOLDER } from "./constants";

export const SEED_TABLES = ["Worlds", "Core", "Networks", "Complaints", "Register", "Timers", "Conversations", "ComplianceTape", "AuditLog", "Runtime"] as const;

export const TemplateItem = z
  .object({
    table: z.enum(SEED_TABLES),
    pk: z.string().startsWith(`W#${WORLD_PLACEHOLDER}#`),
    sk: z.string().min(1),
    entity: z.string().regex(/^[A-Z][A-Za-z]+$/),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type TemplateItem = z.infer<typeof TemplateItem>;

export const SettlementFileRef = z
  .object({
    network: z.enum(["NORTE", "SUR"]),
    businessDate: z.string(),
    status: z.enum(["PUBLISHED", "PENDING"]),
    publishAtSim: z.string(),
    lineCount: z.number().int().nonnegative(),
    /** Under `data/settlements/<template>/` and `Seed/settlements/<template>/` (published batches only). */
    seedPath: z.string().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
export type SettlementFileRef = z.infer<typeof SettlementFileRef>;

export const ReceiptRef = z
  .object({
    id: z.string(),
    personaId: z.string().regex(/^C\d{2}$/),
    variant: z.string(),
    seq: z.number().int().positive(),
    /** Key under `Seed/` (`receipts/<variant>/<id>.png`). */
    seedKey: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ReceiptRef = z.infer<typeof ReceiptRef>;

export const PersonaRef = z
  .object({ id: z.string().regex(/^C\d{2}$/), customerId: z.string(), scenario: z.string(), flows: z.array(z.string()) })
  .strict();

export const WorldTemplateFile = z
  .object({
    format: z.literal("reclamo-seed-template/1"),
    template: z.enum(["demo", "guest", "qa-min"]),
    startAtSim: z.string(),
    placeholders: z.object({ worldId: z.literal(WORLD_PLACEHOLDER), epoch: z.literal(EPOCH_PLACEHOLDER) }).strict(),
    settings: z.record(z.string(), z.unknown()),
    /** `guest` only: the caps the factory picks by the origin of the world id (ADR-0020). */
    settingsByOrigin: z.record(z.enum(["INVITED", "SIGNUP"]), z.record(z.string(), z.unknown())).optional(),
    personas: z.array(PersonaRef),
    receipts: z.array(ReceiptRef),
    settlements: z.array(SettlementFileRef),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    items: z.array(TemplateItem),
  })
  .strict();
export type WorldTemplateFile = z.infer<typeof WorldTemplateFile>;

export const ModelPersona = z
  .object({
    persona: PersonaRef,
    receipts: z.array(ReceiptRef),
    items: z.array(TemplateItem),
    /** The persona's register events without `seq`/`prevHash`/`hash`: the clone appends them to its own chain. */
    registerEvents: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

/** `models`: each persona as a model `world.create` clones, plus what every clone shares (payers, batches). */
export const ModelsTemplateFile = z
  .object({
    format: z.literal("reclamo-seed-template/1"),
    template: z.literal("models"),
    startAtSim: z.string(),
    placeholders: z.object({ worldId: z.literal(WORLD_PLACEHOLDER), epoch: z.literal(EPOCH_PLACEHOLDER) }).strict(),
    settings: z.record(z.string(), z.unknown()),
    settlements: z.array(SettlementFileRef),
    shared: z.array(TemplateItem),
    personas: z.record(z.string().regex(/^C\d{2}$/), ModelPersona),
  })
  .strict();
export type ModelsTemplateFile = z.infer<typeof ModelsTemplateFile>;

function substitute(value: unknown, worldId: string, epoch: number): unknown {
  if (value === EPOCH_PLACEHOLDER) return epoch;
  if (typeof value === "string") return value.replaceAll(WORLD_PLACEHOLDER, worldId).replaceAll(EPOCH_PLACEHOLDER, String(epoch));
  if (Array.isArray(value)) return value.map((member) => substitute(member, worldId, epoch));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, substitute(member, worldId, epoch)]));
  }
  return value;
}

/** A template item for a concrete world and epoch: the only substitution the factory makes. */
export function instantiate<T>(value: T, worldId: string, epoch: number): T {
  return substitute(value, worldId, epoch) as T;
}
