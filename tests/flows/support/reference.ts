// The `Reference` rows every world reads, written from the seed (`scripts/seed/data/reference.json` and
// the manifest's `seedReceiptHashes`) with the record schemas the code parses them with: the holidays
// the deadlines count with (`HOLIDAY/AR`), the four WhatsApp templates (`TEMPLATE/WHATSAPP`, written
// `LOCAL_ONLY` as the seed does), the terms and the fee schedule in force, the lender's identification
// for a formal notice and the hashes of the synthetic receipts. Shared by every world of the process.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { HolidayRecord } from "@reclamo/bff/complaints/sla";
import { ClauseRecord, FEES_REFERENCE, FeeRecord, TERMS_REFERENCE } from "@reclamo/bff/agent-tools/account/reference";
import { TEMPLATE_REFERENCE, TemplateRecord } from "@reclamo/bff/channels/whatsapp/template-records";
import { CREDITOR_REFERENCE, CreditorRecord } from "@reclamo/bff/outbound/documents";
import { SEED_RECEIPT_HASH_REFERENCE, SeedReceiptHashRecord } from "@reclamo/bff/receipts/seed-hash";
import { keys } from "@reclamo/bff/connector/keys";
import type { Connector } from "@reclamo/bff/connector/port";
import { seedPaths } from "../../../scripts/seed/lib/constants";

const SeedReference = z.looseObject({
  holidays: z.object({ entries: z.array(z.looseObject({ date: z.string() })) }),
  terms: z.object({ clauses: z.array(z.unknown()) }),
  fees: z.object({ fees: z.array(z.unknown()) }),
  lender: z.looseObject({ cuit: z.string(), address: z.string() }),
  whatsappTemplates: z.record(z.string(), z.unknown()),
});
const SeedManifest = z.looseObject({ seedReceiptHashes: z.record(z.string(), z.string()) });

interface Row {
  readonly type: string;
  readonly scope: string;
  readonly key: string;
  readonly entity: string;
  readonly value: object;
}

function rows(): Row[] {
  const paths = seedPaths();
  const reference = SeedReference.parse(JSON.parse(readFileSync(paths.reference, "utf8")));
  const manifest = SeedManifest.parse(JSON.parse(readFileSync(paths.manifest, "utf8")));
  const holidays = reference.holidays.entries.map((entry) => ({ type: "HOLIDAY", scope: "AR", key: entry.date, entity: "Holiday", value: HolidayRecord.parse(entry) }));
  const templates = Object.keys(reference.whatsappTemplates).map((name) => ({
    ...TEMPLATE_REFERENCE,
    key: name,
    entity: "WhatsAppTemplate",
    value: TemplateRecord.parse({ name, status: "LOCAL_ONLY", category: "UTILITY", language: "es_AR" }),
  }));
  const clauses = reference.terms.clauses.map((clause) => ClauseRecord.parse(clause)).map((clause) => ({ ...TERMS_REFERENCE, key: clause.id, entity: "Clause", value: clause }));
  const fees = reference.fees.fees.map((fee) => FeeRecord.parse(fee)).map((fee) => ({ ...FEES_REFERENCE, key: fee.code, entity: "Fee", value: fee }));
  const creditor = { ...CREDITOR_REFERENCE, entity: "Creditor", value: CreditorRecord.parse(reference.lender) };
  const receipts = Object.entries(manifest.seedReceiptHashes).map(([seedKey, sha256]) => ({
    ...SEED_RECEIPT_HASH_REFERENCE,
    key: sha256,
    entity: "SeedReceiptHash",
    value: SeedReceiptHashRecord.parse({ sha256, seedKey }),
  }));
  return [...holidays, ...templates, ...clauses, ...fees, creditor, ...receipts];
}

/** Writes the seed's reference rows (idempotent: the same key is simply rewritten). */
export async function seedReference(connector: Pick<Connector, "write">): Promise<number> {
  const all = rows();
  for (const row of all) {
    const key = keys.reference(row.type, row.scope, row.key);
    await connector.write({ kind: "put", table: "Reference", item: { ...row.value, pk: key.pk, sk: key.sk, entity: row.entity } });
  }
  return all.length;
}
