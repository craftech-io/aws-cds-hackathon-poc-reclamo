// Test support of copy/ (Node only; the product never imports it). It lists every customer-facing
// text of copy/ and holds the outbound guard the copy tests run over them: collection (the five
// categories of docs/design-brief.md §7), payment requests, credit offers and requests for
// sensitive data. Its collection side is the product's own lexicon (channel-policy/collection-lexicon.ts)
// plus the patterns below, so the copy is held to what `CH-WA-NO-COLLECTION` reads; both are
// calibrated with the single collection corpus of the seed (scripts/seed/data/evals/collection-corpus.json,
// WP-14): 0 false negatives.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { classifyCollection } from "../channel-policy/collection-lexicon";
import { BUTTON_TITLES } from "./buttons";
import { EMAIL_CONSENT_VERSIONS } from "./consent";
import { ACCOUNT_BLOCK_CATEGORY_TEXT, COMPLAINT_OUTCOME_LABEL, COMPLAINT_TYPE_LABEL, DATA_CHANGE_FIELD_LABEL, EMAIL_TEXT, INSTALMENT_STATUS_TEXT, LOAN_STATUS_TEXT, WHATSAPP_TEXT } from "./es-AR";
import { PDF_CHANNEL_LABEL, PDF_COMMON, PDF_DOC, PDF_INSTALMENT_STATUS } from "./pdf-texts";
import { TEMPLATE_STATUS_PHRASES } from "./template-status";
import { WHATSAPP_TEMPLATES } from "./templates";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

export function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

export type GuardCategory = "PAYMENT_EXHORTATION" | "CONSEQUENCE_THREAT" | "DEBT_REMINDER" | "PAYMENT_INSTRUMENT" | "NEGOTIATION" | "CREDIT_OFFER" | "SENSITIVE_ASK";

// Whole words or phrases, Unicode-aware (`\b` does not see accented letters).
const phrase = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "iu");
const SENSITIVE = "claves?|pin|c[oó]digos?|contraseñas?|tarjetas?|cbu|cvu|dni|documentos?|cuit|cuil|tokens?|n[uú]mero de cuenta";

export const OUTBOUND_GUARD: Readonly<Record<GuardCategory, readonly RegExp[]>> = {
  PAYMENT_EXHORTATION: [
    phrase("(?:pag|abon|regulariz|cancel|sald)(?:á|a(?:la|lo|las|los))"),
    phrase("(?:ten[eé]s|deb[eé]s|necesit[aá]s|hay) que (?:pagar|abonar|cancelar|regularizar)"),
    phrase("no te olvides de (?:pagar|abonar)"),
    phrase("record[aá](?:te)? (?:de )?(?:pagar|abonar)"),
  ],
  CONSEQUENCE_THREAT: [
    phrase("evit[aá]r? (?:los |más |mayores )?(?:recargos|intereses|punitorios|acciones|problemas|inconvenientes)"),
    phrase("informaremos|te vamos a informar|acciones legales|embargos?|central de deudores|intimamos|intimaci[oó]n|iniciaremos|gesti[oó]n judicial|consecuencias"),
  ],
  DEBT_REMINDER: [
    phrase("te recordamos|record[aá]s que (?:tu|la|tus) (?:cuota|deuda|saldo)"),
    phrase("(?:cuotas?|deudas?|saldos?)(?: (?:est[aá]n?|sigue|siguen|figura|figuran))? (?:vencid[ao]s?|impag[ao]s?|atrasad[ao]s?|en mora)"),
    phrase("tu deuda|est[aá]s en mora|vence hoy|venci[oó] (?:tu|la) cuota"),
  ],
  PAYMENT_INSTRUMENT: [
    phrase("link de pago|c[oó]digo de pago|medios? de pago|(?:cvu|cbu|alias) para (?:pagar|abonar|transferir)"),
    phrase("pod[eé]s (?:pagar|abonar)|pag[aá]r? (?:en|con|desde|al|por) (?:el|la|tu|nuestra)|transfer[ií](?:nos)? (?:a|al)|deposit[aá]"),
  ],
  NEGOTIATION: [phrase("planes? de pagos?|refinanci\\p{L}*|quitas?|acuerdo de pago|condona\\p{L}*|descuento (?:por|si|para) pag\\p{L}*")],
  CREDIT_OFFER: [
    phrase("(?:pr[eé]stamo|cr[eé]dito) nuevo|nuevo (?:pr[eé]stamo|cr[eé]dito)|otro (?:pr[eé]stamo|cr[eé]dito)"),
    phrase("tasa preferencial|pre-?aprobad[ao]s?|te ofrecemos|ofertas?|promoci[oó]n|aument\\p{L}* (?:de |tu )?(?:l[ií]mite|cupo)"),
  ],
  SENSITIVE_ASK: [
    phrase(`(?:mand|pas|envi|ingres|escrib|compart|confirm|indic|dec)[aáií]me\\p{P}?(?:[^.?!]{0,40}?)(?:${SENSITIVE})`),
    phrase(`(?:necesitamos|necesito|pedimos|requerimos|precisamos) (?:tu|el|la|los|tus|una foto de tu) (?:${SENSITIVE})`),
  ],
};

/** Categories of the guard that `text` trips. */
export function guardFindings(text: string): GuardCategory[] {
  const normalized = text.normalize("NFC");
  const lexicon = new Set<GuardCategory>(classifyCollection(normalized).categories);
  return (Object.keys(OUTBOUND_GUARD) as GuardCategory[]).filter((category) => lexicon.has(category) || OUTBOUND_GUARD[category].some((pattern) => pattern.test(normalized)));
}

export interface CustomerText {
  readonly source: string;
  readonly text: string;
  /** Part of the formal debt notice by email: the one path that may state a debt (never exhort, threaten or negotiate). */
  readonly formalDebtNotice: boolean;
}

function fromRecord(source: string, record: Readonly<Record<string, string>>, formal: readonly string[] = []): CustomerText[] {
  return Object.entries(record).map(([key, text]) => ({ source: `${source}.${key}`, text, formalDebtNotice: formal.includes(key) }));
}

/** Every text of copy/ a customer can read: WhatsApp, email, templates, buttons, consent and PDFs. */
export function customerTexts(): CustomerText[] {
  const buttons = Object.entries(BUTTON_TITLES).flatMap(([action, forms]) => Object.entries(forms).map(([form, text]) => ({ source: `BUTTON_TITLES.${action}.${form}`, text, formalDebtNotice: false })));
  const pdf = Object.entries(PDF_DOC).flatMap(([kind, texts]) => fromRecord(`PDF_DOC.${kind}`, texts, kind === "COLLECTION_NOTICE" ? Object.keys(texts) : []));
  return [
    ...fromRecord("WHATSAPP_TEXT", WHATSAPP_TEXT),
    ...fromRecord("EMAIL_TEXT", EMAIL_TEXT, ["SUBJECT_COLLECTION_NOTICE", "COLLECTION_NOTICE_BODY", "COLLECTION_NOTICE_RIGHTS"]),
    ...fromRecord("COMPLAINT_TYPE_LABEL", COMPLAINT_TYPE_LABEL),
    ...fromRecord("COMPLAINT_OUTCOME_LABEL", COMPLAINT_OUTCOME_LABEL),
    ...fromRecord("ACCOUNT_BLOCK_CATEGORY_TEXT", ACCOUNT_BLOCK_CATEGORY_TEXT),
    ...fromRecord("DATA_CHANGE_FIELD_LABEL", DATA_CHANGE_FIELD_LABEL),
    ...fromRecord("LOAN_STATUS_TEXT", LOAN_STATUS_TEXT),
    ...fromRecord("INSTALMENT_STATUS_TEXT", INSTALMENT_STATUS_TEXT),
    ...Object.values(WHATSAPP_TEMPLATES).map((template) => ({ source: `WHATSAPP_TEMPLATES.${template.name}`, text: template.body, formalDebtNotice: false })),
    ...fromRecord("TEMPLATE_STATUS_PHRASES", TEMPLATE_STATUS_PHRASES),
    ...buttons,
    ...Object.values(EMAIL_CONSENT_VERSIONS).map((version) => ({ source: `EMAIL_CONSENT_VERSIONS.${version.version}`, text: version.question, formalDebtNotice: false })),
    ...fromRecord("PDF_COMMON", PDF_COMMON),
    ...fromRecord("PDF_CHANNEL_LABEL", PDF_CHANNEL_LABEL),
    ...fromRecord("PDF_INSTALMENT_STATUS", PDF_INSTALMENT_STATUS),
    ...pdf,
  ];
}

export const CORPUS_FILE = "scripts/seed/data/evals/collection-corpus.json";

const CorpusEntry = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  text: z.string().min(1),
  label: z.string().optional(),
  kind: z.string().optional(),
  category: z.string().optional(),
});
type CorpusEntry = z.infer<typeof CorpusEntry>;
const Corpus = z.union([z.array(CorpusEntry), z.object({ phrases: z.array(CorpusEntry) }), z.object({ entries: z.array(CorpusEntry) })]);

const COLLECTION_LABEL = /^(collection|cobranza)$/i;
const COLLECTION_CATEGORIES = new Set(["PAYMENT_EXHORTATION", "CONSEQUENCE_THREAT", "DEBT_REMINDER", "PAYMENT_INSTRUMENT", "NEGOTIATION"]);

export interface CollectionCorpus {
  /** Every collection sentence, the adversarial ones included. */
  readonly collection: readonly CorpusEntry[];
  /** The collection sentences written to slip past a reader (`col-adv-*`). */
  readonly adversarial: readonly CorpusEntry[];
  readonly service: readonly CorpusEntry[];
}

/** The seed's collection corpus split by label, or `undefined` while WP-14 has not written it. */
export function loadCollectionCorpus(): CollectionCorpus | undefined {
  const path = join(REPO_ROOT, CORPUS_FILE);
  if (!existsSync(path)) return undefined;
  const parsed = Corpus.parse(JSON.parse(readFileSync(path, "utf8")));
  const entries = Array.isArray(parsed) ? parsed : "phrases" in parsed ? parsed.phrases : parsed.entries;
  const isCollection = (entry: CorpusEntry) => COLLECTION_LABEL.test(entry.label ?? entry.kind ?? "") || COLLECTION_CATEGORIES.has(entry.category ?? "");
  const collection = entries.filter(isCollection);
  return { collection, adversarial: collection.filter((entry) => String(entry.id ?? "").startsWith("col-adv-")), service: entries.filter((entry) => !isCollection(entry)) };
}
