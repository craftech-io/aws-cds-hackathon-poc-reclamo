// Re-reads the AWS Price List offer files the rate card cites and compares every price line by SKU:
// usage type, unit, USD and effective date (docs/build-plan.md WP-46). The offer files are public (no
// credentials, no AWS account call); each fetch has a timeout and retries with exponential backoff.
// `compareOffer` is pure so the comparison is tested without the network.
import { z } from "zod";
import { OFFERS, type Offer, PRICE_LINES, type PriceLine, offerUrl } from "./price-list";

const PriceDimension = z.looseObject({ unit: z.string(), pricePerUnit: z.looseObject({ USD: z.string() }) });
const Term = z.looseObject({ effectiveDate: z.string(), priceDimensions: z.record(z.string(), PriceDimension) });
export const OfferFile = z.looseObject({
  publicationDate: z.string(),
  products: z.record(z.string(), z.looseObject({ attributes: z.looseObject({ usagetype: z.string().optional() }) })),
  terms: z.looseObject({ OnDemand: z.record(z.string(), z.record(z.string(), Term)) }),
});
export type OfferFile = z.infer<typeof OfferFile>;

export interface LineCheck {
  readonly id: string;
  readonly problems: readonly string[];
}

/** Problems of each line of `offer` against the offer file as published now (empty when it still holds). */
export function compareOffer(offer: Offer, file: OfferFile, lines: readonly PriceLine[] = PRICE_LINES): LineCheck[] {
  return lines
    .filter((line) => line.offer === offer)
    .map((line) => {
      const problems: string[] = [];
      const product = file.products[line.sku];
      const terms = Object.values(file.terms.OnDemand[line.sku] ?? {});
      if (product === undefined || terms.length === 0) return { id: line.id, problems: [`SKU ${line.sku} is no longer in ${offer}`] };
      if (product.attributes.usagetype !== line.usageType) problems.push(`usage type is now ${product.attributes.usagetype ?? "(none)"}`);
      const dimensions = terms.flatMap((term) => Object.values(term.priceDimensions).map((dimension) => ({ term, dimension })));
      if (dimensions.length !== 1) problems.push(`has ${dimensions.length} price dimensions (the card prices one)`);
      const first = dimensions[0];
      if (first !== undefined) {
        if (first.dimension.unit !== line.unit) problems.push(`unit is now ${first.dimension.unit}`);
        const usd = Number(first.dimension.pricePerUnit.USD);
        if (!(Math.abs(usd - line.usd) < 1e-12)) problems.push(`price is now ${usd} USD (card: ${line.usd})`);
        if (first.term.effectiveDate !== line.effectiveDate) problems.push(`effective date is now ${first.term.effectiveDate}`);
      }
      return { id: line.id, problems };
    });
}

export interface FetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The offer file of `offer`, parsed; timeout per attempt and exponential backoff between attempts. */
export async function fetchOffer(offer: Offer, options: FetchOptions = {}): Promise<OfferFile> {
  const { fetchImpl = fetch, timeoutMs = 30_000, attempts = 3, baseDelayMs = 1_000, sleep = defaultSleep } = options;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(offerUrl(offer), { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`${offer}: HTTP ${response.status}`);
      return OfferFile.parse(await response.json());
    } catch (error) {
      last = error;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${offer}: the offer file could not be read after ${attempts} attempts (${last instanceof Error ? last.message : String(last)})`);
}

export interface LiveReport {
  readonly published: Readonly<Partial<Record<Offer, string>>>;
  readonly problems: readonly string[];
}

/** Every line of the card against the offer files as published now. */
export async function checkLive(options: FetchOptions = {}): Promise<LiveReport> {
  const published: Partial<Record<Offer, string>> = {};
  const problems: string[] = [];
  for (const offer of OFFERS) {
    const file = await fetchOffer(offer, options);
    published[offer] = file.publicationDate;
    for (const check of compareOffer(offer, file)) for (const problem of check.problems) problems.push(`${check.id}: ${problem}`);
  }
  return { published, problems };
}
