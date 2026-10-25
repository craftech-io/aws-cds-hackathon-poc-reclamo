import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGENT_MODEL_ID, CLASSIFIER_MODEL_ID, RECEIPT_MODEL_ID } from "../../infra/agentcore-spec";
import { RateCard, complaintCost, isVerified } from "../../packages/bff/src/metrics/assumptions";
import { RATE_CARD_FILE, RateCardDocument, buildRateCard, rateCardDrift } from "./card";
import { BOUNDS, agentCalls, complaintBreakdown, estimate, gateEstimate, perTurnUsd, poolWorstDay, previousAssumptionAtVerifiedRates, proposedThresholdUsd, tokenUsd } from "./estimate";
import { type OfferFile, compareOffer, fetchOffer } from "./live";
import { OFFERS, PRICES_READ_ON, PRICE_LINES, modelLineId, modelRates, offerUrl } from "./price-list";
import { rateCardFileContent } from "./ratecard";
import { type ComplaintWorkload, GATE, HAPPY_PATH, POOL_WORST_DAY, agentPrefixChars, tokensOf } from "./workload";

const committedText = (): string => readFileSync(join(process.cwd(), RATE_CARD_FILE), "utf8");
const committed = (): unknown => JSON.parse(committedText()) as unknown;

describe("verified rate card (WP-46): every price with its official source and the day it was read", () => {
  it("cites the AWS Price List offer file, the pricing page, the SKU and the dates of every line", () => {
    const card = buildRateCard();
    expect(card.rates.map((rate) => rate.rateId)).toEqual(PRICE_LINES.map((line) => line.id));
    expect(new Set(card.rates.map((rate) => rate.rateId)).size).toBe(card.rates.length);
    expect(new Set(card.rates.map((rate) => rate.sku)).size).toBe(card.rates.length);
    for (const rate of card.rates) {
      expect(rate.source).toBe(offerUrl(rate.offer as (typeof OFFERS)[number]));
      expect(new URL(rate.source).hostname).toBe("pricing.us-east-1.amazonaws.com");
      expect(new URL(rate.page).hostname).toBe("aws.amazon.com");
      expect(rate.readOn).toBe(PRICES_READ_ON);
      expect(rate.effectiveDate.slice(0, 10) <= PRICES_READ_ON, rate.rateId).toBe(true);
      expect(rate.offerPublishedAt.slice(0, 10) <= PRICES_READ_ON, rate.rateId).toBe(true);
    }
    expect(new Set(card.rates.map((rate) => rate.offer))).toEqual(new Set(OFFERS));
  });

  it("prices the three models through the profiles infra/agentcore-spec.ts names (ADR-0016, ADR-0021 §6)", () => {
    const card = buildRateCard();
    expect(card.model).toBe(AGENT_MODEL_ID);
    expect([card.models.agent.modelId, card.models.classifier.modelId, card.models.reader.modelId]).toEqual([AGENT_MODEL_ID, CLASSIFIER_MODEL_ID, RECEIPT_MODEL_ID]);
    // ADR-0021 §6 fixed US$ 2 / 10 and cache 0.2 / 2.5; the Price List read on PRICES_READ_ON has cache reads at 0.1 (effective 2026-10-01).
    expect(card.usdPerMillionTokens).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(card.models.classifier.usdPerMillionTokens).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
    expect(card.models.reader.usdPerMillionTokens).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(modelRates("agent").input).toBe(PRICE_LINES.find((line) => line.id === modelLineId("agent", "input"))?.usd);
  });

  it("prices SES per recipient and WhatsApp valued as live with the AWS fee plus Meta's utility fee", () => {
    const card = buildRateCard();
    expect(card.usdPerEmail).toBe(0.0001);
    expect(card.usdPerWhatsAppMessage).toBe(0.0256);
    expect(card.whatsappFlatBasis).toMatch(/cota superior/);
  });
});

describe("ratecard.json is what the cost KPI reads (metrics/assumptions.ts)", () => {
  it("is committed byte for byte as --write produces it, with no drift", () => {
    expect(committedText()).toBe(rateCardFileContent());
    expect(rateCardDrift(committed())).toEqual([]);
    expect(RateCardDocument.parse(committed())).toEqual(buildRateCard());
  });

  it("parses as the KPI's RateCard and counts as verified, so the cost KPI stops saying 'sin verificar'", () => {
    const card = RateCard.parse(committed());
    expect(isVerified(card)).toBe(true);
    expect(card.status).not.toMatch(/supuesto|sin verificar|unverified/i);
    expect(card).toMatchObject({ model: AGENT_MODEL_ID, usdPerEmail: 0.0001, usdPerWhatsAppMessage: 0.0256 });
    expect(complaintCost(card, { tokens: { in: 1_000_000, out: 100_000, cached: 1_000_000 }, messages: { wa: 2, email: 1 } })).toEqual({
      model: 2 + 1 + 0.1,
      email: 0.0001,
      whatsapp: 0.0512,
      total: 2 + 1 + 0.1 + 0.0001 + 0.0512,
    });
  });

  it("reports drift: a changed price, a missing or extra line, an unverified status or an unreadable file", () => {
    const card = buildRateCard();
    const changed = { ...card, rates: card.rates.map((rate) => (rate.rateId === "ses:recipient" ? { ...rate, usd: 0.0002 } : rate)) };
    expect(rateCardDrift(changed)).toEqual(["ratecard.json ses:recipient differs from the verified price line"]);
    expect(rateCardDrift({ ...card, rates: card.rates.slice(1) })).toEqual([`ratecard.json is missing ${modelLineId("agent", "input")}`]);
    expect(rateCardDrift({ ...card, rates: [...card.rates, { ...card.rates[0], rateId: "ses:inbound" }] })).toEqual(["ratecard.json ses:inbound is not a verified price line"]);
    expect(rateCardDrift({ ...card, status: "supuesto · sin verificar" })).toEqual(["ratecard.json status differs from the verified price lines"]);
    expect(rateCardDrift({ unreadable: "x" }).length).toBeGreaterThan(0);
  });
});

describe("cost per complaint of the happy path, caching on (WP-46, ADR-0021 §6-§7)", () => {
  it("prices the assumption it replaces at the verified rates: 30,000 to 60,000 uncached input + 1,000 output = US$ 0.07 to 0.13", () => {
    expect(previousAssumptionAtVerifiedRates()).toEqual({ low: 0.07, high: 0.13 });
  });

  it("measures the cached prefix from the system prompt and the Gateway schemas that ship", () => {
    const chars = agentPrefixChars();
    expect(chars).toBeGreaterThan(10_000);
    expect(estimate().prefixTokens).toBe(tokensOf(chars));
  });

  it("counts two model calls per turn and the cache: the prefix is written once and read by every other call", () => {
    const tiny: ComplaintWorkload = { ...HAPPY_PATH, turns: { low: 2, high: 2 }, prefixCacheWrites: { low: 1, high: 2 }, envelopeTokens: { low: 100, high: 100 }, historyTokensPerPriorTurn: { low: 50, high: 50 }, toolRoundTripTokens: { low: 10, high: 10 }, outputTokensPerCall: { low: 5, high: 5 } };
    // low, incremental: turn 1 writes prefix + envelope then reads them; turn 2 reads prefix + history (+ envelope on call 2).
    expect(agentCalls(tiny, "low", 1_000).tokens).toEqual({ input: 0, output: 20, cacheRead: 1_000 + 100 + (1_000 + 50) + (1_000 + 50 + 100), cacheWrite: 1_000 + 100 + 10 + 100 + 10 });
    // high, prefix only: both turns write the prefix on their first call; history, envelope and tool results are input.
    expect(agentCalls(tiny, "high", 1_000).tokens).toEqual({ input: 100 + 110 + (50 + 100) + (50 + 110), output: 20, cacheRead: 2_000, cacheWrite: 2_000 });
  });

  it("breaks the cost down into agent, classifier, reader, guardrails, platform, SES and WhatsApp valued as live, low <= high", () => {
    for (const bound of BOUNDS) {
      const parts = complaintBreakdown(HAPPY_PATH, bound);
      const { total, ...rest } = parts;
      expect(total).toBeCloseTo(Object.values(rest).reduce((sum, value) => sum + value, 0), 5);
      expect(parts.agent).toBeGreaterThan(0);
      expect(parts.reader).toBeGreaterThan(0);
      expect(parts.ses).toBeGreaterThan(0);
      expect(parts.whatsappValuedAsLive).toBeGreaterThan(0);
    }
    const [low, high] = [complaintBreakdown(HAPPY_PATH, "low"), complaintBreakdown(HAPPY_PATH, "high")];
    for (const key of Object.keys(low) as (keyof typeof low)[]) expect(low[key], key).toBeLessThanOrEqual(high[key]);
  });

  it("is cheaper with the prefix cached than the same calls with every token as fresh input", () => {
    const calls = agentCalls(HAPPY_PATH, "high", tokensOf(agentPrefixChars())).tokens;
    const uncached = { input: calls.input + calls.cacheRead + calls.cacheWrite, output: calls.output, cacheRead: 0, cacheWrite: 0 };
    expect(tokenUsd("agent", calls)).toBeLessThan(tokenUsd("agent", uncached));
  });

  it("prices the turn, the gate and the worst day of each pool with the same per-turn figure", () => {
    for (const bound of BOUNDS) {
      const turn = perTurnUsd(HAPPY_PATH, bound);
      const gate = gateEstimate(HAPPY_PATH, bound);
      expect(gate.turns).toBe(GATE.turnsPerSuite * GATE.fullRuns + GATE.batchComplaints * HAPPY_PATH.turns[bound] + GATE.ev1Turns);
      expect(gate.parts.ev1).toBeCloseTo(GATE.ev1Turns * turn, 2);
      expect(gate.usd).toBeCloseTo(Object.values(gate.parts).reduce((sum, value) => sum + value, 0), 2);
      expect(poolWorstDay(HAPPY_PATH, bound).signupUsd).toBeGreaterThanOrEqual(POOL_WORST_DAY.SIGNUP.turns * turn - 0.01);
    }
    expect(POOL_WORST_DAY.SIGNUP).toEqual({ turns: 400, imageReads: 200 });
    expect(POOL_WORST_DAY.PUBLIC.sharedUnits).toBe(1_500);
  });

  it("proposes a threshold above the high bound, rounded to US$ 0.05, for the CTO to fix", () => {
    const threshold = proposedThresholdUsd();
    expect(threshold).toBeGreaterThan(complaintBreakdown(HAPPY_PATH, "high").total);
    expect(Math.round(threshold * 100) % 5).toBe(0);
  });
});

describe("live check against the AWS Price List (offline: fixture and fake fetch)", () => {
  const line = PRICE_LINES.find((entry) => entry.id === "ses:recipient");
  if (line === undefined) throw new Error("ses:recipient is a price line");
  const offerFile = (usd: string, unit = line.unit): OfferFile => ({
    publicationDate: "2026-10-09T00:00:00Z",
    products: { [line.sku]: { attributes: { usagetype: line.usageType } } },
    terms: { OnDemand: { [line.sku]: { [`${line.sku}.T`]: { effectiveDate: line.effectiveDate, priceDimensions: { d: { unit, pricePerUnit: { USD: usd } } } } } } },
  });

  it("accepts a line that still holds and names what changed otherwise", () => {
    expect(compareOffer("AmazonSES", offerFile("0.0001000000"), [line])).toEqual([{ id: "ses:recipient", problems: [] }]);
    expect(compareOffer("AmazonSES", offerFile("0.0002000000", "Messages"), [line])[0]?.problems).toEqual(["unit is now Messages", "price is now 0.0002 USD (card: 0.0001)"]);
    expect(compareOffer("AmazonSES", { ...offerFile("0.0001"), products: {} }, [line])[0]?.problems).toEqual([`SKU ${line.sku} is no longer in AmazonSES`]);
  });

  it("retries a failed read with exponential backoff and a timeout per attempt, then gives up", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let calls = 0;
    const flaky = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (calls < 3) throw new Error("socket hang up");
      return new Response(JSON.stringify(offerFile("0.0001")), { status: 200 });
    });
    await expect(fetchOffer("AmazonSES", { fetchImpl: flaky as typeof fetch, sleep })).resolves.toMatchObject({ publicationDate: "2026-10-09T00:00:00Z" });
    expect(flaky.mock.calls[0]?.[0]).toBe(offerUrl("AmazonSES"));
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
    const down = vi.fn(async () => new Response("", { status: 503 }));
    await expect(fetchOffer("AmazonSES", { fetchImpl: down as typeof fetch, sleep, attempts: 2 })).rejects.toThrow("could not be read after 2 attempts (AmazonSES: HTTP 503)");
  });
});
