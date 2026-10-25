// Content of the two Bedrock Guardrails (docs/design-brief.md §8.5, docs/architecture.md §9.1 and
// §9.4), as plain data:
//
//   G1  the worker's pre-filter (`ApplyGuardrail`, source INPUT, over the customer's text the
//       normalizer already masked) and the Harness `guardrailConfig`: the three inbound denied
//       topics, prompt attack HIGH and PII (cards blocked, CUIT/CUIL, DNI and CBU/CVU anonymized).
//   G2  the outbound gate (`ApplyGuardrail`, source OUTPUT) over every free text of the agent and of
//       the operator: the five outbound denied topics, contextual grounding (provisional 0.75,
//       calibrated with EV-1 and recorded in ADR-0008) and relevance 0.5. The gate adds the
//       grounding qualifiers only to a REPLY with figures or facts and to a FORMAL_ANSWER draft, and
//       builds the relevance query itself (outbound/g2-query.ts, ADR-0021 §10): a fixed status
//       question when the customer asked nothing. The thresholds do not change for that query.
//
// Only three G1 findings may block a turn: a denied topic, PROMPT_ATTACK and a card number. The worker
// maps each one to a fixed reply and a GUARDRAIL_BLOCK handoff, so G1 carries no other content filter
// and no word filter: any other block would be one nobody can classify. The document numbers are
// ANONYMIZE, input only, and never block: the normalizer masked them already with mask.ts, so G1 is
// the second layer. Emails and phones are NONE: registered contacts are legitimate data.
//
// The document regexes come from packages/bff/src/lib/mask.ts (`MASK_PATTERNS`), never copied: mask.ts
// writes its boundaries as lookarounds, which Bedrock custom regexes do not support, so
// `bedrockPattern` swaps exactly those two boundaries for consuming ASCII groups and `\d` for `[0-9]`.
// It throws when a pattern does not have the shape it knows, so a change in mask.ts fails the test and
// the deploy instead of shipping a different regex.
//
// Definitions and examples are in Spanish and English (the customer writes Spanish; the CLASSIC tier
// covers both). The FL-056 and FL-057 triggers are examples of their topic. No SST dependency:
// infra/guardrail.ts turns this into resources and guardrail-policies.test.ts checks it offline.
import { createHash } from "node:crypto";
import { MASK_PATTERNS, type MaskLabel } from "../packages/bff/src/lib/mask";

export interface DeniedTopic {
  /** `[0-9a-zA-Z-_ !?.]+`, at most 100 characters; the audit names the topic that intervened. */
  readonly name: string;
  /** `<es> (<en>).`, at most 200 characters (CLASSIC tier). */
  readonly definition: string;
  /** At most 5 in total, 100 characters each. */
  readonly examples: { readonly es: readonly string[]; readonly en: readonly string[] };
}

const CREDIT_OFFERS: DeniedTopic = {
  name: "CreditOffers",
  definition: "Pedidos u ofertas de crédito nuevo: otro préstamo, más plata prestada, un aumento de límite o una refinanciación (asking for or offering another loan, a higher limit or refinancing).",
  examples: {
    es: ["¿Me dan otro préstamo?", "¿Puedo refinanciar?", "¿Querés un préstamo nuevo con tasa preferencial?"],
    en: ["Can you give me another loan?", "Can I refinance?"],
  },
};

const LEGAL_ADVICE: DeniedTopic = {
  name: "LegalAdvice",
  definition: "Asesoramiento legal: si conviene hacer juicio, demandar, iniciar acciones legales o contratar un abogado (legal advice: whether to sue, take legal action or hire a lawyer for a case).",
  examples: {
    es: ["¿Les puedo hacer juicio?", "¿Me conviene demandarlos o ir a un abogado?"],
    en: ["Can I sue you?", "Should I take legal action against you for this?"],
  },
};

const INVESTMENT_ADVICE: DeniedTopic = {
  name: "InvestmentAdvice",
  definition: "Asesoramiento de inversión: dónde o en qué invertir o ahorrar la plata, como plazos fijos, dólares, acciones o cripto (investment advice: where or what to invest in).",
  examples: {
    es: ["¿Dónde invierto la plata?", "¿Me conviene comprar dólares o hacer un plazo fijo?"],
    en: ["Where do I invest the money?", "Which stocks or crypto should I buy with my savings?"],
  },
};

const DEBT_COLLECTION: DeniedTopic = {
  name: "DebtCollection",
  definition: "Cobranza: exigir, recordar o presionar para que el cliente pague una deuda o una cuota vencida, o pasarle un medio para pagar (debt collection: urging the customer to pay what is owed).",
  examples: {
    es: ["Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos", "Regularizá tu deuda hoy o vamos a iniciar acciones legales", "Podés pagar el saldo vencido con este link de pago"],
    en: ["Your instalment is overdue, please pay it today to avoid late fees.", "Pay what you owe now or we will report you."],
  },
};

const CREDENTIAL_REQUEST: DeniedTopic = {
  name: "CredentialRequest",
  definition: "Pedirle al cliente claves, PIN, códigos de verificación, contraseñas o datos de su tarjeta (asking the customer for passwords, PINs, verification codes or card data).",
  examples: {
    es: ["Pasame la clave del home banking así reviso tu cuenta", "Decime el código que te llegó por SMS", "Mandame los números de tu tarjeta y el código de seguridad"],
    en: ["Please send me your PIN so I can check your account.", "Tell me the verification code you got by SMS."],
  },
};

/** Inbound denied topics (G1, pre-filter and Harness): credit and refinancing, legal advice, investment advice. */
export const INBOUND_TOPICS: readonly DeniedTopic[] = [CREDIT_OFFERS, LEGAL_ADVICE, INVESTMENT_ADVICE];

/** Outbound denied topics (G2, outbound gate): collection, credit, legal, investment, credential requests. */
export const OUTBOUND_TOPICS: readonly DeniedTopic[] = [DEBT_COLLECTION, CREDIT_OFFERS, LEGAL_ADVICE, INVESTMENT_ADVICE, CREDENTIAL_REQUEST];

export type FilterStrength = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface ContentFilter {
  readonly type: "PROMPT_ATTACK";
  readonly inputStrength: FilterStrength;
  readonly outputStrength: FilterStrength;
}

/** Content filters of G1: prompt attack only, HIGH. Bedrock evaluates it on input only, so its output strength is NONE. */
export const CONTENT_FILTERS: readonly ContentFilter[] = [{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" }];

export type PiiAction = "BLOCK" | "ANONYMIZE" | "NONE";

export interface PiiEntity {
  readonly type: "CREDIT_DEBIT_CARD_NUMBER" | "EMAIL" | "PHONE";
  readonly inputAction: PiiAction;
  readonly outputAction: PiiAction;
}

/** Managed PII types of G1: a card blocks on both sides (it is never legitimate); emails and phones are left alone. */
export const PII_ENTITIES: readonly PiiEntity[] = [
  { type: "CREDIT_DEBIT_CARD_NUMBER", inputAction: "BLOCK", outputAction: "BLOCK" },
  { type: "EMAIL", inputAction: "NONE", outputAction: "NONE" },
  { type: "PHONE", inputAction: "NONE", outputAction: "NONE" },
];

/** The mask.ts kinds G1 anonymizes with a custom regex (CUIT/CUIL, DNI, CBU/CVU). */
export const GUARDRAIL_KINDS = ["CUIT", "DNI", "CBU"] as const satisfies readonly MaskLabel[];
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

const REGEX_INFO: Readonly<Record<GuardrailKind, { readonly name: string; readonly description: string }>> = {
  CUIT: { name: "AR_CUIT_CUIL", description: "Argentine tax id (CUIT/CUIL) as lib/mask.ts writes it; the normalizer masked it first." },
  DNI: { name: "AR_DNI", description: "Argentine national id (DNI) as lib/mask.ts writes it; the normalizer masked it first." },
  CBU: { name: "AR_CBU_CVU", description: "Argentine account number (CBU/CVU) as lib/mask.ts writes it; the normalizer masked it first." },
};

// mask.ts's boundaries ("not glued to a letter, a digit or an id separator"), as they appear in
// `RegExp.source`, and the lookaround-free groups Bedrock gets instead. The groups consume the
// neighbouring character, which only widens what an ANONYMIZE replaces; they are ASCII, so a letter
// with an accent counts as a boundary (mask.ts would not), which only matters for text the normalizer
// left unmasked.
// DNI also refuses a peso amount (`$ 1.500.000`, `1.180.640,00`): mask.ts adds a lookbehind on `$` and
// a lookahead on `,<digit>`, and the Bedrock groups exclude the same neighbours without lookarounds.
// The separators between groups (` - `, repeated spaces) come with the core unchanged; they are ASCII
// spaces because the normalizer turns every Unicode space (a no-break space) into one before G1.
const LOOKBEHIND = "(?<![\\p{L}\\p{N}_#/-])";
const LOOKAHEAD = "(?![\\p{L}\\p{N}_#/])";
interface Boundaries {
  readonly mask: readonly [start: string, end: string];
  readonly bedrock: readonly [start: string, end: string];
}
const DEFAULT_BOUNDARIES: Boundaries = { mask: [LOOKBEHIND, LOOKAHEAD], bedrock: ["(?:^|[^A-Za-z0-9_#/-])", "(?:$|[^A-Za-z0-9_#/])"] };
const BOUNDARIES: Readonly<Record<GuardrailKind, Boundaries>> = {
  CUIT: DEFAULT_BOUNDARIES,
  CBU: DEFAULT_BOUNDARIES,
  DNI: {
    mask: [`${LOOKBEHIND}(?<!\\$\\s?)`, `${LOOKAHEAD}(?!,\\d)`],
    bedrock: ["(?:^|[^A-Za-z0-9_#/$\\s-]|(?:^|[^$])\\s)", "(?:$|[^A-Za-z0-9_#/,]|,(?:$|[^0-9]))"],
  },
};

/** The part of mask.ts's pattern of `kind` between its boundaries, with `[0-9]` for `\d`. */
export function bedrockCore(kind: GuardrailKind): string {
  const pattern = MASK_PATTERNS.find(([label]) => label === kind)?.[1];
  if (!pattern) throw new Error(`lib/mask.ts has no ${kind} pattern for G1.`);
  const { source } = pattern;
  const [start, end] = (BOUNDARIES[kind] ?? DEFAULT_BOUNDARIES).mask;
  if (!source.startsWith(start) || !source.endsWith(end)) {
    throw new Error(`lib/mask.ts changed the boundaries of ${kind}: update bedrockPattern in infra/guardrail-policies.ts.`);
  }
  const core = source.slice(start.length, source.length - end.length).replaceAll("\\d", "[0-9]");
  if (/\(\?<?[=!]|\\p\{|\\[dDwWsS]/.test(core)) throw new Error(`lib/mask.ts's ${kind} pattern uses syntax Bedrock does not support.`);
  return core;
}

/** mask.ts's pattern of `kind`, rewritten for Bedrock: no lookarounds, no `\d`, no Unicode classes. */
export function bedrockPattern(kind: GuardrailKind): string {
  const [start, end] = (BOUNDARIES[kind] ?? DEFAULT_BOUNDARIES).bedrock;
  return `${start}${bedrockCore(kind)}${end}`;
}

export interface GuardrailRegex {
  readonly kind: GuardrailKind;
  readonly name: string;
  readonly description: string;
  readonly pattern: string;
}

/** G1's custom regexes, derived from mask.ts on every synth. */
export const G1_REGEXES: readonly GuardrailRegex[] = GUARDRAIL_KINDS.map((kind) => ({ kind, ...REGEX_INFO[kind], pattern: bedrockPattern(kind) }));

export interface GroundingFilter {
  readonly type: "GROUNDING" | "RELEVANCE";
  readonly threshold: number;
}

/**
 * Contextual grounding of G2. Grounding 0.75 is provisional (calibrated with EV-1, value recorded in
 * ADR-0008); relevance 0.5. The fixed small-talk query of ADR-0021 §10 changes neither.
 */
export const GROUNDING_FILTERS: readonly GroundingFilter[] = [
  { type: "GROUNDING", threshold: 0.75 },
  { type: "RELEVANCE", threshold: 0.5 },
];

/** What the gate may hand G2 in one call (docs/architecture.md §9.4); the gate truncates longer inputs first. */
export const G2_LIMITS = {
  queryMaxChars: 1_000,
  groundingSourceMaxChars: 100_000,
  contentMaxChars: 5_000,
} as const;

/** Tier of the topic and content policies; CLASSIC covers Spanish and English with no cross-region profile. */
export const GUARDRAIL_TIER = "CLASSIC";

/**
 * What Bedrock returns instead of a blocked text. It never reaches a channel: the worker and the gate
 * act on the assessment (a fixed reply from copy/, a handoff, `GROUNDING_FAIL`/`POLICY_DENIED`). A
 * token and not a sentence, so it is recognisable in any log and easy to refuse at the gate.
 */
export const BLOCKED_MESSAGES = {
  g1Input: "GUARDRAIL_G1_INPUT_BLOCKED",
  g1Output: "GUARDRAIL_G1_OUTPUT_BLOCKED",
  g2Input: "GUARDRAIL_G2_INPUT_BLOCKED",
  g2Output: "GUARDRAIL_G2_OUTPUT_BLOCKED",
} as const;

// ---- Provider-shaped configuration (aws.bedrock.GuardrailArgs), built here so the test sees exactly
// what infra/guardrail.ts sends. Arrays stay mutable because the provider's input types are. -------

interface TierConfig {
  tierName: string;
}

interface TopicPolicyConfig {
  tierConfigs: TierConfig[];
  topicsConfigs: { name: string; definition: string; examples: string[]; type: "DENY" }[];
}

interface ContentPolicyConfig {
  tierConfigs: TierConfig[];
  filtersConfigs: { type: string; inputStrength: FilterStrength; outputStrength: FilterStrength; inputModalities: string[]; outputModalities: string[] }[];
}

interface SensitiveSide {
  action: PiiAction;
  inputAction: PiiAction;
  inputEnabled: boolean;
  outputAction: PiiAction;
  outputEnabled: boolean;
}

interface SensitiveInformationPolicyConfig {
  piiEntitiesConfigs: (SensitiveSide & { type: string })[];
  regexesConfigs: (SensitiveSide & { name: string; description: string; pattern: string })[];
}

export interface GuardrailPolicyConfig {
  topicPolicyConfig?: TopicPolicyConfig;
  contentPolicyConfig?: ContentPolicyConfig;
  sensitiveInformationPolicyConfig?: SensitiveInformationPolicyConfig;
  contextualGroundingPolicyConfig?: { filtersConfigs: { type: string; threshold: number }[] };
}

function topicPolicy(topics: readonly DeniedTopic[]): TopicPolicyConfig {
  return {
    tierConfigs: [{ tierName: GUARDRAIL_TIER }],
    topicsConfigs: topics.map((topic) => ({
      name: topic.name,
      definition: topic.definition,
      examples: [...topic.examples.es, ...topic.examples.en],
      type: "DENY",
    })),
  };
}

/** G1: inbound topics, prompt attack, cards blocked, document numbers anonymized on input, contacts left alone. */
export const G1_POLICIES: GuardrailPolicyConfig = {
  topicPolicyConfig: topicPolicy(INBOUND_TOPICS),
  contentPolicyConfig: {
    tierConfigs: [{ tierName: GUARDRAIL_TIER }],
    filtersConfigs: CONTENT_FILTERS.map((filter) => ({
      type: filter.type,
      inputStrength: filter.inputStrength,
      outputStrength: filter.outputStrength,
      inputModalities: ["TEXT"],
      outputModalities: ["TEXT"],
    })),
  },
  sensitiveInformationPolicyConfig: {
    piiEntitiesConfigs: PII_ENTITIES.map((entity) => ({
      type: entity.type,
      // `action` is the legacy single-side field the API still requires; it mirrors the input side.
      action: entity.inputAction,
      inputAction: entity.inputAction,
      inputEnabled: true,
      outputAction: entity.outputAction,
      outputEnabled: true,
    })),
    regexesConfigs: G1_REGEXES.map((regex) => ({
      name: regex.name,
      description: regex.description,
      pattern: regex.pattern,
      action: "ANONYMIZE",
      inputAction: "ANONYMIZE",
      inputEnabled: true,
      outputAction: "NONE",
      outputEnabled: false,
    })),
  },
};

/** G2: outbound topics plus contextual grounding and relevance; nothing that rewrites the outbound text. */
export const G2_POLICIES: GuardrailPolicyConfig = {
  topicPolicyConfig: topicPolicy(OUTBOUND_TOPICS),
  contextualGroundingPolicyConfig: { filtersConfigs: GROUNDING_FILTERS.map((filter) => ({ ...filter })) },
};

/**
 * Digest of a guardrail's policies. `aws.bedrock.GuardrailVersion` has no updatable field, so the
 * digest goes in its description: any policy change replaces the version and publishes a new number
 * on the same deploy.
 */
export function policiesDigest(policies: GuardrailPolicyConfig): string {
  return createHash("sha256").update(JSON.stringify(policies)).digest("hex").slice(0, 16);
}
