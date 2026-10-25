// `Reference` of the stage (docs/architecture.md §5, docs/seed-spec.md §3, §11, §15): the read-only
// documents the code reads deterministically, one row per record under `REF#<type>#<scope>`. The row
// shapes are the readers' (agent-tools/account/reference.ts, complaints/sla.ts, receipts/seed-hash.ts,
// outbound/documents.ts, channels/whatsapp/template-records.ts, and metrics/assumptions.ts for the
// verified rate card of data/ratecard.json). A WhatsApp template keeps the status
// and Meta id that scripts/channels/whatsapp-templates.ts recorded: the load only fills them when absent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { encode } from "../../../packages/bff/src/connector/codec";
import { keys, segment } from "../../../packages/bff/src/connector/keys";
import { RATE_CARD_REFERENCE, RateCard } from "../../../packages/bff/src/metrics/assumptions";
import type { StoredItem, TableStore, WriteOp } from "../../../packages/bff/src/connector/store";
import type { Manifest } from "./files";

const Section = z.record(z.string(), z.unknown());
const ReferenceFile = z.looseObject({
  holidays: z.looseObject({ scope: z.string(), entries: z.array(Section) }),
  terms: z.looseObject({ version: z.string(), clauses: z.array(Section) }),
  fees: z.looseObject({ version: z.string(), fees: z.array(Section) }),
  lender: Section,
  whatsappTemplates: z.record(z.string(), Section),
  blockCategories: z.record(z.string(), z.string()),
  templateStatusPhrases: z.record(z.string(), z.string()),
  networks: z.record(z.string(), Section),
  nameCheck: z.array(Section),
  channelRuleSet: z.looseObject({ version: z.union([z.string(), z.number()]).optional() }),
  collectionLexicon: z.looseObject({ version: z.string() }),
  referenceRate: Section,
});

export interface ReferenceRows {
  /** Unconditional puts: the seed owns these rows. */
  readonly puts: readonly StoredItem[];
  /** Upserts that keep the fields another script owns. */
  readonly upserts: readonly WriteOp[];
}

function row(now: Date, type: string, scope: string, key: string, entity: string, value: Record<string, unknown>): StoredItem {
  return encode({ ...value, synthetic: true }, { entity, key: keys.reference(type, scope, segment(key, "reference key")), now });
}

/** Every `Reference` row of the seed (see the header). */
export function referenceRows(root: string, manifest: Manifest, now: Date): ReferenceRows {
  const reference = ReferenceFile.parse(JSON.parse(readFileSync(join(root, "data", "reference.json"), "utf8")));
  const puts: StoredItem[] = [];
  for (const entry of reference.holidays.entries) puts.push(row(now, "HOLIDAY", reference.holidays.scope, String(entry.date), "Holiday", entry));
  for (const clause of reference.terms.clauses) puts.push(row(now, "TERMS", reference.terms.version, String(clause.id), "ProductTerms", clause));
  for (const fee of reference.fees.fees) puts.push(row(now, "FEES", reference.fees.version, String(fee.code), "FeeSchedule", fee));
  puts.push(row(now, "LENDER", "AR", "creditor", "Lender", reference.lender));
  for (const [category, text] of Object.entries(reference.blockCategories)) puts.push(row(now, "REASON", "AR", category, "ReasonCategory", { category, text }));
  for (const [key, phrase] of Object.entries(reference.templateStatusPhrases)) puts.push(row(now, "TEMPLATE_STATUS_PHRASE", "WHATSAPP", key, "TemplateStatusPhrase", { key, phrase }));
  for (const [network, value] of Object.entries(reference.networks)) puts.push(row(now, "NETWORK", "AR", network, "Network", { network, ...value }));
  reference.nameCheck.forEach((check, index) => puts.push(row(now, "NAME_CHECK", "AR", String(index + 1).padStart(3, "0"), "NameCheck", check)));
  const rateCard = RateCard.loose().parse(JSON.parse(readFileSync(join(root, "data", "ratecard.json"), "utf8")));
  puts.push(row(now, RATE_CARD_REFERENCE.type, RATE_CARD_REFERENCE.scope, RATE_CARD_REFERENCE.key, "RateCard", rateCard));
  puts.push(row(now, "CHANNEL_RULES", "CURRENT", String(reference.channelRuleSet.version ?? "v1"), "ChannelRuleSet", reference.channelRuleSet));
  puts.push(row(now, "COLLECTION_LEXICON", "CURRENT", reference.collectionLexicon.version, "CollectionLexicon", reference.collectionLexicon));
  puts.push(row(now, "REFERENCE_RATE", "AR", "current", "ReferenceRate", reference.referenceRate));
  for (const [seedKey, sha256] of Object.entries(manifest.seedReceiptHashes).sort()) puts.push(row(now, "SEED_RECEIPT_HASH", "SHA256", sha256, "SeedReceiptHash", { sha256, seedKey }));

  const upserts: WriteOp[] = Object.entries(reference.whatsappTemplates).map(([name, template]) => {
    const { status: _status, metaTemplateId: _meta, ...content } = template;
    return {
      kind: "update",
      table: "Reference",
      key: keys.reference("TEMPLATE", "WHATSAPP", segment(name, "template name")),
      update: { set: { ...content, name, entity: "Template", synthetic: true, updatedAt: now.toISOString() }, setIfNotExists: { status: "LOCAL_ONLY", createdAt: now.toISOString() } },
    };
  });
  return { puts, upserts };
}

/** Writes the rows: puts in batches, the template upserts one by one. */
export async function writeReference(store: TableStore, rows: ReferenceRows): Promise<number> {
  for (let start = 0; start < rows.puts.length; start += 200) await store.batchWrite("Reference", rows.puts.slice(start, start + 200).map((put) => ({ put })));
  for (const op of rows.upserts) await store.write(op);
  return rows.puts.length + rows.upserts.length;
}

export const LOAD_STATE_KEY = keys.reference("SEED", "LOAD", "fingerprint");

export async function storedFingerprint(store: TableStore): Promise<string | undefined> {
  const item = await store.get("Reference", LOAD_STATE_KEY, { consistent: true });
  return typeof item?.fingerprint === "string" ? item.fingerprint : undefined;
}

export async function saveFingerprint(store: TableStore, fingerprint: string, now: Date): Promise<void> {
  await store.write({ kind: "put", table: "Reference", item: { ...LOAD_STATE_KEY, entity: "SeedLoad", fingerprint, loadedAtReal: now.toISOString() } });
}
