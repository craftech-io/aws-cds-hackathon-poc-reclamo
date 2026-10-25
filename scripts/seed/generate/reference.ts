// `data/reference.json` (docs/seed-spec.md §1-§3, §11): what `seed:load` writes to `Reference`: the
// fictitious lender, holidays, product terms, fee schedule, block categories, WhatsApp templates and
// their status phrases, default channel rules, the collection lexicon's version, the rate card
// (unverified until it is measured), the NameCheck of every invented name in use and the synthetic
// reference rate. Fixed texts are imported from copy/, never rewritten here.
import { ACCOUNT_BLOCK_CATEGORY_TEXT, ChannelRuleId, CollectionCategory, TEMPLATE_STATUS_PHRASES, WHATSAPP_TEMPLATES } from "@reclamo/bff/copy/index";
import { syntheticCuit } from "../lib/codes";
import { HOLIDAYS } from "./holidays";
import { REFERENCE_RATE } from "./history-money";
import { RULE_SET_VERSION } from "./conversations";
import type { CustomerRecord } from "./ledger";
import { CLAUSES, FEES, FEE_SCHEDULE_VERSION, TERMS_VERSION } from "./terms";

export const LENDER = {
  name: "Jarilla — préstamos y billetera",
  label: "prestamista ficticio",
  cuit: syntheticCuit(),
  cuitLabel: "sintético",
  address: "Av. de los Tilos 1400, Ciudad Ficticia",
  serviceName: "Servicio de atención al usuario de Jarilla (ficticio)",
  products: ["Préstamo personal en pesos de 3 a 18 cuotas mensuales", "Billetera con CVU sintético"],
} as const;

export const NETWORKS = {
  NORTE: { name: "Red de cobro Norte", cutoff: "18:00", settlement: "D+1 hábil", publishAt: "08:30" },
  SUR: { name: "Red de cobro Sur", cutoff: "16:00", settlement: "D+2 hábiles", publishAt: "11:00" },
  TRANSFER: { name: "Red de transferencias" },
} as const;

interface NameCheckEntry {
  readonly name: string;
  readonly kind: "LENDER" | "NETWORK" | "PERSON" | "PLACE";
  readonly checkedAt: string;
  readonly result: string;
}

const SEARCHED = "Sin prestamistas, billeteras ni fintechs con ese nombre en búsquedas de préstamos, billeteras, crédito y fintech";
const DESCRIPTIVE = "Descriptivo, sin marca";
const GENERIC = "Nombre y apellido de listas genéricas; validado contra la lista externa de términos prohibidos en seed:validate";

/** Only the invented names the seed uses (docs/seed-spec.md §2). */
export function nameCheck(customers: readonly CustomerRecord[]): NameCheckEntry[] {
  const people = [...new Set(customers.map((customer) => `${customer.firstName} ${customer.lastName}`))].sort();
  return [
    { name: "Jarilla", kind: "LENDER", checkedAt: "2026-09-26", result: SEARCHED },
    ...Object.values(NETWORKS).map((network): NameCheckEntry => ({ name: network.name, kind: "NETWORK", checkedAt: "2026-09-26", result: DESCRIPTIVE })),
    { name: "Ciudad Ficticia", kind: "PLACE", checkedAt: "2026-10-06", result: DESCRIPTIVE },
    ...people.map((name): NameCheckEntry => ({ name, kind: "PERSON", checkedAt: "2026-10-06", result: GENERIC })),
  ];
}

export const CHANNEL_RULE_SET = {
  version: RULE_SET_VERSION,
  rules: ChannelRuleId.options,
  params: {
    contactHours: { weekday: { from: "08:00", to: "20:00" }, saturday: { from: "09:00", to: "13:00" }, sunday: null, holidays: null },
    formalNoticeHours: { weekday: { from: "09:00", to: "18:00" } },
    maxProactivePerDay: 3,
    formalNoticeEveryDays: 7,
    whatsappWindowHours: 24,
    label: "supuesto · nuestra lectura de las reglas, no asesoramiento legal",
  },
} as const;

export function reference(customers: readonly CustomerRecord[]): Record<string, unknown> {
  return {
    lender: LENDER,
    networks: NETWORKS,
    holidays: { scope: "AR", entries: HOLIDAYS },
    terms: { version: TERMS_VERSION, clauses: CLAUSES },
    fees: { version: FEE_SCHEDULE_VERSION, fees: FEES },
    blockCategories: ACCOUNT_BLOCK_CATEGORY_TEXT,
    whatsappTemplates: WHATSAPP_TEMPLATES,
    templateStatusPhrases: TEMPLATE_STATUS_PHRASES,
    channelRuleSet: CHANNEL_RULE_SET,
    collectionLexicon: { version: "v001", categories: CollectionCategory.options, corpus: "evals/collection-corpus.json" },
    referenceRate: { annualRate: REFERENCE_RATE, label: "Tasa de referencia sintética (supuesto)" },
    nameCheck: nameCheck(customers),
  };
}
