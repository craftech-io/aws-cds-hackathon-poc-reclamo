// The `models` template (docs/seed-spec.md §4, `Seed/worlds/models.json`) cloned into one QA world
// (docs/tool-catalog.md `world.create`): the shared lender (other payers, networks, published and
// pending batches, the clock, the template's timers) plus the personas a scenario asks for, each with
// its whole history (loans, payments with their claims, in-person collections, complaints with their
// evidence and their `FILED` register entries).
//
//   customer id   `cus-<worldId>-<key>`: every occurrence of the model's id (`cus-00nn`) in its items,
//                 in the shared lines that name it and in the published files that list it
//   phone         a number of the QA range `+5491100009000`…`9999`, leased for 2 real hours (`LEASE#QAPHONE#`)
//   email         `success+<worldId>-<key>@simulator.amazonses.com` (or `bounce+` / `complaint+`)
//   register      the personas' historical entries re-sequenced in filing order; the factory rebuilds the
//                 chain and asks `AnchorWriter` for its anchors; the complaint counter starts above every
//                 historical number of the models, so a new number never repeats one
//   history       earlier money actions a scenario asks for (world-history.ts, FL-040), as closed
//                 complaints of the persona with their register entries
//
// A model may be cloned once per world: its loans, operation codes and lines keep their ids.
import { z } from "zod";
import { ConnectorError, ToolError } from "@reclamo/shared";
import { paddedSeq } from "../connector/keys";
import { EPOCH_TOKEN, type TemplateDocument, TemplateTable, WORLD_TOKEN } from "../worlds/template";
import { QA_REASON } from "./contract";
import type { HistoryEntry } from "./inputs";
import { highestNumbers, historyPlan } from "./world-history";

const Row = z.object({ table: TemplateTable, pk: z.string().min(1), sk: z.string().min(1), entity: z.string().min(1), data: z.record(z.string(), z.unknown()) });
type Row = z.infer<typeof Row>;

const ModelEntry = z.object({
  persona: z.looseObject({ id: z.string(), customerId: z.string() }),
  items: z.array(Row),
  receipts: z.array(z.unknown()),
  registerEvents: z.array(z.record(z.string(), z.unknown())),
});

export const ModelsDocument = z.object({
  format: z.literal("reclamo-seed-template/1"),
  template: z.literal("models"),
  startAtSim: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  settlements: z.array(z.looseObject({ network: z.string(), businessDate: z.string(), status: z.enum(["PUBLISHED", "PENDING"]), seedPath: z.string().optional() })),
  shared: z.array(Row),
  personas: z.record(z.string(), ModelEntry),
});
export type ModelsDocument = z.infer<typeof ModelsDocument>;

/** Reads the models, their published files and the batch inputs from `Seed` (docs/architecture.md §6). */
export interface ModelsSource {
  read(): Promise<ModelsDocument>;
  settlementCsv(seedPath: string): Promise<string>;
  /** `load/batch-inputs.jsonl`: the 30 presentations of `batch.run`. */
  batchInputs(): Promise<string>;
}

export const BATCH_INPUTS_SEED_KEY = "load/batch-inputs.jsonl";

export const MODELS_SEED_KEY = "worlds/models.json";

/** `settlements/models/<network>/<date>/batch-<n>.csv` in the `Seed` bucket. */
export function modelsSettlementKey(seedPath: string): string {
  return `settlements/models/${seedPath}`;
}

/** A persona as cloned into one world. */
export interface ClonedPersona {
  readonly key: string;
  readonly model: string;
  readonly customerId: string;
  readonly phoneE164: string;
  readonly email: string;
}

/** The first and last number of the QA phone range (docs/seed-spec.md §5). */
export const QA_PHONE_FIRST = 9000;
export const QA_PHONE_COUNT = 1000;

export function qaPhone(n: number): string {
  if (!Number.isInteger(n) || n < QA_PHONE_FIRST || n >= QA_PHONE_FIRST + QA_PHONE_COUNT) throw new RangeError(`not a QA phone: ${n}`);
  return `+549110000${n}`;
}

export function cloneCustomerId(worldId: string, key: string): string {
  return `cus-${worldId}-${key}`;
}

export function cloneEmail(worldId: string, key: string, override?: "bounce" | "complaint"): string {
  return `${override ?? "success"}+${worldId}-${key}@simulator.amazonses.com`;
}

function maskedPhone(phoneE164: string): string {
  return `+54 9 11 •••• ${phoneE164.slice(-4)}`;
}

/** Every occurrence of a model customer id in a value (a whole id: `cus-0001` never matches `cus-00011`). */
function swapper(pairs: readonly (readonly [string, string])[]): (value: unknown) => unknown {
  if (pairs.length === 0) return (value) => value;
  const map = new Map(pairs);
  const pattern = new RegExp(`(${pairs.map(([from]) => from).join("|")})(?![0-9])`, "g");
  const swap = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(pattern, (found) => map.get(found) ?? found);
    if (Array.isArray(value)) return value.map(swap);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, member]) => [name, swap(member)]));
    return value;
  };
  return swap;
}

/** The persona's own customer row with the clone's contact data (cleared by the factory after hashing). */
function contactOf(row: Row, persona: ClonedPersona): Row {
  if (row.table !== "Core" || row.entity !== "Customer") return row;
  const mailbox = persona.email.split("+")[0] ?? "s";
  return { ...row, data: { ...row.data, phoneE164: persona.phoneE164, phoneMasked: maskedPhone(persona.phoneE164), email: persona.email, emailMasked: `${mailbox.charAt(0)}***@simulator.amazonses.com` } };
}

/** The highest complaint number per year (the models' and the history's): new numbers start above it. */
function counterRows(events: readonly Record<string, unknown>[]): Row[] {
  return [...highestNumbers(events)].map(([year, value]) => ({
    table: "Runtime" as const,
    pk: `W#${WORLD_TOKEN}#COUNTER#CMP#e${EPOCH_TOKEN}#${year}`,
    sk: "META",
    entity: "Counter",
    data: { synthetic: true, value },
  }));
}

/** The personas' `FILED` and later entries, in filing order, as register rows of the world. */
function registerRows(events: readonly Record<string, unknown>[]): Row[] {
  const ordered = [...events].sort((a, b) => String(a.atReal).localeCompare(String(b.atReal)));
  return ordered.map((event, index) => ({
    table: "Register" as const,
    pk: `W#${WORLD_TOKEN}#REG#e${EPOCH_TOKEN}`,
    sk: paddedSeq(index + 1),
    entity: "RegisterEntry",
    data: { ...event, seq: index + 1 },
  }));
}

/**
 * The world's template: the models' lender with the asked personas cloned (see the header). The
 * document is shaped as the factory reads any template; its `template` is a stand-in the factory only
 * logs, and the published files are listed apart (`files`), since they live under `settlements/models/`.
 */
export function cloneModels(doc: ModelsDocument, personas: readonly ClonedPersona[], history: readonly HistoryEntry[] = []): { readonly template: TemplateDocument; readonly swap: (value: unknown) => unknown } {
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const persona of personas) {
    if (seen.has(persona.model)) throw new ToolError("INVALID", `${persona.model} is cloned twice in one world`, QA_REASON.DUPLICATE_MODEL);
    seen.add(persona.model);
    const model = doc.personas[persona.model];
    if (model === undefined) throw new ToolError("NOT_FOUND", `the models have no ${persona.model}`);
    pairs.push([model.persona.customerId, persona.customerId]);
  }
  const swap = swapper(pairs);
  const own = personas.flatMap((persona) => {
    const model = doc.personas[persona.model];
    if (model === undefined) return [];
    return model.items.map((row) => contactOf(swap(row) as Row, persona));
  });
  const modelEvents = Object.values(doc.personas).flatMap((entry) => entry.registerEvents);
  const past = historyPlan({ history, startAtSim: doc.startAtSim, customerIdOf: (key) => personas.find((persona) => persona.key === key)?.customerId, modelEvents });
  const events = [...personas.flatMap((persona) => (doc.personas[persona.model]?.registerEvents ?? []).map((event) => swap(event) as Record<string, unknown>)), ...past.events];
  const items = [...doc.shared.map((row) => swap(row) as Row), ...own, ...past.rows, ...registerRows(events), ...counterRows([...modelEvents, ...past.events])];
  for (const row of items) {
    if (!row.pk.startsWith(`W#${WORLD_TOKEN}#`)) throw new ConnectorError("VALIDATION", "a model row outside the world", "Seed");
  }
  const template: TemplateDocument = {
    format: doc.format,
    template: "qa-min",
    startAtSim: doc.startAtSim,
    settings: doc.settings,
    // The published files are copied apart (world-build.ts): the factory would look for them under the stand-in.
    settlements: [],
    items,
  };
  return { template, swap };
}

/** The published files of the models (`network/date/batch-n.csv`). */
export function publishedFiles(doc: ModelsDocument): string[] {
  return doc.settlements.flatMap((file) => (file.status === "PUBLISHED" && file.seedPath !== undefined ? [file.seedPath] : []));
}
