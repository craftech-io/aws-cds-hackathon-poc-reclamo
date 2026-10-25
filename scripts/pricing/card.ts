// The verified rate card (docs/build-plan.md WP-46): `scripts/seed/data/ratecard.json`, built only from
// the price lines of price-list.ts. Its top level has the shape the cost KPI reads
// (packages/bff/src/metrics/assumptions.ts `RateCard`: version, status, agent model, USD per million
// tokens, per email and per WhatsApp message valued as live), so `seed:load` can write the file as it
// is; the rest says where every number came from: one entry per price line with its offer file URL,
// pricing page, SKU, usage type, effective date and the day it was read.
import { z } from "zod";
import { MODEL_USES, type ModelUse, OFFER_PUBLISHED_AT, PRICES_READ_ON, PRICE_LINES, PRICE_REGION, PRICING_PAGES, modelRates, offerUrl, priceOf } from "./price-list";

export const RATE_CARD_FILE = "scripts/seed/data/ratecard.json";
export const RATE_CARD_VERSION = `rc-${PRICES_READ_ON}`;
/** Never matches the "supuesto · sin verificar" test of `isVerified` (metrics/assumptions.ts). */
export const RATE_CARD_STATUS = `verificada · AWS Price List ${PRICE_REGION}, leída el ${PRICES_READ_ON}`;

/**
 * WhatsApp valued as live, per outbound message: the AWS fee plus Meta's utility-template fee. Replies
 * inside the customer's 24-hour window carry no Meta fee, so this flat figure is an upper bound; the
 * estimate prices service replies and templates apart.
 */
export const WHATSAPP_FLAT_BASIS = "cota superior: cada saliente valorizado como plantilla utility (cargo de AWS + cargo de Meta, Argentina)";

const Usd = z.number().nonnegative();
const TokenRates = z.object({ input: Usd, output: Usd, cacheRead: Usd, cacheWrite: Usd }).strict();
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

export const RateEntry = z
  .object({
    rateId: z.string().min(1),
    usd: Usd,
    unit: z.string().min(1),
    offer: z.string().min(1),
    sku: z.string().regex(/^[A-Z0-9]{16}$/),
    usageType: z.string().min(1),
    description: z.string().min(1),
    effectiveDate: IsoInstant,
    offerPublishedAt: IsoInstant,
    source: z.url(),
    page: z.url(),
    readOn: IsoDate,
  })
  .strict();
export type RateEntry = z.infer<typeof RateEntry>;

const ModelEntry = z.object({ modelId: z.string().min(1), priceListModel: z.string().min(1), usdPerMillionTokens: TokenRates }).strict();

export const RateCardDocument = z
  .object({
    version: z.string().min(1).max(40),
    status: z.string().min(1).max(80),
    asOf: IsoDate,
    region: z.literal(PRICE_REGION),
    currency: z.literal("USD"),
    model: z.string().min(1).max(120),
    usdPerMillionTokens: TokenRates,
    usdPerEmail: Usd,
    usdPerWhatsAppMessage: Usd,
    whatsappFlatBasis: z.string().min(1),
    models: z.object({ agent: ModelEntry, classifier: ModelEntry, reader: ModelEntry }).strict(),
    rates: z.array(RateEntry).min(1),
  })
  .strict();
export type RateCardDocument = z.infer<typeof RateCardDocument>;

function modelEntry(use: ModelUse): z.infer<typeof ModelEntry> {
  return { ...MODEL_USES[use], usdPerMillionTokens: { ...modelRates(use) } };
}

const micro = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

/** The rate card, from the verified price lines only. */
export function buildRateCard(): RateCardDocument {
  return RateCardDocument.parse({
    version: RATE_CARD_VERSION,
    status: RATE_CARD_STATUS,
    asOf: PRICES_READ_ON,
    region: PRICE_REGION,
    currency: "USD",
    model: MODEL_USES.agent.modelId,
    usdPerMillionTokens: { ...modelRates("agent") },
    usdPerEmail: priceOf("ses:recipient"),
    usdPerWhatsAppMessage: micro(priceOf("whatsapp:awsMessageAR") + priceOf("whatsapp:metaUtilityAR")),
    whatsappFlatBasis: WHATSAPP_FLAT_BASIS,
    models: { agent: modelEntry("agent"), classifier: modelEntry("classifier"), reader: modelEntry("reader") },
    rates: PRICE_LINES.map(
      (line): RateEntry => ({
        rateId: line.id,
        usd: line.usd,
        unit: line.unit,
        offer: line.offer,
        sku: line.sku,
        usageType: line.usageType,
        description: line.description,
        effectiveDate: line.effectiveDate,
        offerPublishedAt: OFFER_PUBLISHED_AT[line.offer],
        source: offerUrl(line.offer),
        page: PRICING_PAGES[line.offer],
        readOn: PRICES_READ_ON,
      }),
    ),
  });
}

/** Differences between a committed `ratecard.json` and the card built from the price lines (empty when in step). */
export function rateCardDrift(committed: unknown): string[] {
  const parsed = RateCardDocument.safeParse(committed);
  if (!parsed.success) return parsed.error.issues.map((issue) => `ratecard.json ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const expected = buildRateCard();
  const problems: string[] = [];
  const { rates: committedRates, ...committedTop } = parsed.data;
  const { rates: expectedRates, ...expectedTop } = expected;
  for (const key of Object.keys(expectedTop) as (keyof typeof expectedTop)[]) {
    if (JSON.stringify(committedTop[key]) !== JSON.stringify(expectedTop[key])) problems.push(`ratecard.json ${key} differs from the verified price lines`);
  }
  const byId = new Map(committedRates.map((rate) => [rate.rateId, rate] as const));
  for (const rate of expectedRates) {
    const found = byId.get(rate.rateId);
    if (found === undefined) problems.push(`ratecard.json is missing ${rate.rateId}`);
    else if (JSON.stringify(found) !== JSON.stringify(rate)) problems.push(`ratecard.json ${rate.rateId} differs from the verified price line`);
  }
  for (const rateId of byId.keys()) if (!expectedRates.some((rate) => rate.rateId === rateId)) problems.push(`ratecard.json ${rateId} is not a verified price line`);
  return problems;
}
