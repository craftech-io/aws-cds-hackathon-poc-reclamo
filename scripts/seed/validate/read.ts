// Reads a seed from disk for `seed:validate` and the tests (docs/seed-spec.md §1): the world
// templates (parsed with lib/template.ts), the settlement CSVs, the receipts, evals, load inputs,
// reference data and the manifest, plus the raw bytes of every file for the checksum and term checks.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { type SettlementLine, parseSettlementCsv } from "@reclamo/core-contract";
import { join, relative } from "node:path";
import { type SeedPaths, seedPaths } from "../lib/constants";
import { type ModelsTemplateFile, ModelsTemplateFile as ModelsSchema, type WorldTemplateFile, WorldTemplateFile as TemplateSchema } from "../lib/template";

export type Json = Record<string, unknown>;

export interface SeedOnDisk {
  readonly paths: SeedPaths;
  readonly templates: Readonly<Record<"demo" | "guest" | "qa-min", WorldTemplateFile>>;
  readonly models: ModelsTemplateFile;
  readonly reference: Json;
  readonly manifest: Json;
  readonly evals: { readonly grounding: Json; readonly receipts: Json; readonly classifier: Json; readonly collectionCorpus: Json };
  readonly load: { readonly simulated: Json[]; readonly batch: Json[] };
  /** Every file under the seed root (`data/…`, `media/…`) → bytes. */
  readonly files: ReadonlyMap<string, Buffer>;
}

export function filesUnder(dir: string, root: string = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, root, out);
    else out.push(relative(root, path));
  }
  return out;
}

function lines(text: string): Json[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Json);
}

export function readSeed(root?: string): SeedOnDisk {
  const paths = seedPaths(root);
  const files = new Map<string, Buffer>();
  for (const dir of ["data", "media"]) for (const path of filesUnder(join(paths.root, dir))) files.set(`${dir}/${path}`, readFileSync(join(paths.root, dir, path)));
  const text = (path: string): string => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`missing scripts/seed/${path}`);
    return bytes.toString("utf8");
  };
  const json = (path: string): Json => JSON.parse(text(path)) as Json;
  const template = (name: string): WorldTemplateFile => TemplateSchema.parse(json(`data/worlds/${name}.json`));
  return {
    paths,
    templates: { demo: template("demo"), guest: template("guest"), "qa-min": template("qa-min") },
    models: ModelsSchema.parse(json("data/worlds/models.json")),
    reference: json("data/reference.json"),
    manifest: json("data/manifest.json"),
    evals: {
      grounding: json("data/evals/grounding.json"),
      receipts: json("data/evals/receipts.json"),
      classifier: json("data/evals/classifier.json"),
      collectionCorpus: json("data/evals/collection-corpus.json"),
    },
    load: { simulated: lines(text("data/load/simulated-complaints.jsonl")), batch: lines(text("data/load/batch-inputs.jsonl")) },
    files,
  };
}

/** The data of every item of `entity` in a template. */
export function entities(template: Pick<WorldTemplateFile, "items">, entity: string): Json[] {
  return template.items.filter((item) => item.entity === entity).map((item) => item.data as Json);
}

/** Lines of every published CSV of a template (parsed all-or-nothing by the contract's codec), with their file. */
export function publishedLines(seed: SeedOnDisk, template: string): Array<SettlementLine & { file: string }> {
  const prefix = `data/settlements/${template}/`;
  const out: Array<SettlementLine & { file: string }> = [];
  for (const [path, bytes] of seed.files) {
    if (!path.startsWith(prefix)) continue;
    const [network, businessDate] = path.slice(prefix.length).split("/");
    for (const line of parseSettlementCsv(bytes.toString("utf8"), { network: network as "NORTE" | "SUR", businessDate: businessDate ?? "" })) out.push({ ...line, file: path });
  }
  return out;
}

const WORLD_PREFIX = "W#<worldId>#";

/** Natural keys of the `ActionClaim` items of a template (`OPC#NORTE#<code>`, `REV#<chargeId>`). */
export function claimKeys(template: Pick<WorldTemplateFile, "items">): Set<string> {
  return new Set(template.items.filter((item) => item.entity === "ActionClaim").map((item) => item.pk.slice(WORLD_PREFIX.length)));
}

/** Every line the networks hold (published and pending batches), with the batch's status. */
export function networkLines(template: Pick<WorldTemplateFile, "items">): Array<Json & { status: string }> {
  const batches = entities(template, "SettlementBatch");
  return entities(template, "SettlementLine").map((stored) => {
    const line = stored.line as Json;
    const batch = batches.find((candidate) => candidate.network === line.network && candidate.businessDate === line.businessDate);
    return { ...line, status: String(batch?.status ?? "MISSING") };
  });
}

/** Automatic debits as the core reads them: `DEBIT` movements with their debit id and instalment, oldest first. */
export function debitsOf(template: Pick<WorldTemplateFile, "items">): Json[] {
  return entities(template, "Movement")
    .filter((movement) => movement.kind === "DEBIT" && (movement.ref as Json).debitId !== undefined)
    .map((movement) => {
      const ref = movement.ref as Json;
      return { debitId: ref.debitId, loanId: ref.loanId, instalment: ref.instalment, amount: movement.amount, atSim: movement.atSim, paymentId: ref.paymentId, customerId: movement.customerId, refunded: movement.status === "REVERSED" };
    })
    .sort((a, b) => Date.parse(String(a.atSim)) - Date.parse(String(b.atSim)) || (String(a.debitId) < String(b.debitId) ? -1 : 1));
}
