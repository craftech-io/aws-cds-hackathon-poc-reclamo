// The models' spend of a self-signup account (`W#<w>#SPENDCAP`, leads/limits.ts `GUEST_SPEND_LIMITS`):
// US$1 over the account's life, reserved before every turn on the real clock with a conditional `ADD`,
// settled with the turn's real tokens, and charged by every image read and classifier call.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { GUEST_SPEND_LIMITS } from "../leads/limits";
import { HarnessError } from "../agent/harness-client";
import { MICRO_USD_PER_USD, countTurn, microUsd, spendBucket, worldBuckets } from "./caps";
import { SPEND_PRICES_USD_PER_MILLION, callCeilingUsd, chargeSpend, settleTurnSpend, tokenCostUsd } from "./spend";
import { TEST_NOW, completed, eventOf, recordOf, workerKit, type WorkerKit } from "./testing";
import { processRecord } from "./worker";

const WORLD = "gs-abcdefghij";
const LIMIT = microUsd(GUEST_SPEND_LIMITS.usdPerAccount);
const RESERVATION = microUsd(GUEST_SPEND_LIMITS.turnReservationUsd);
const SPEND_KEY = keys.runtime(WORLD, "SPENDCAP");
const USAGE = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 20_000, cacheWriteTokens: 2_000 };

async function prime(kit: WorkerKit, count: number): Promise<void> {
  await kit.connector.write({ kind: "update", table: "Runtime", key: SPEND_KEY, update: { add: { count }, set: { entity: "CapCounter", updatedAt: TEST_NOW.toISOString() } } });
}

async function customerTurn(kit: WorkerKit, eventId: string) {
  const eventAtSim = "2026-10-07T10:10:00-03:00";
  await kit.addInbound(`msg-${eventId}`, "¿Y mi pago?", { atSim: eventAtSim });
  return processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: `msg-${eventId}`, messageAtSim: eventAtSim, complaintIds: [] }, { worldId: kit.worldId, eventId, eventAtSim }), { queue: "SignupCustomerEvents" }));
}

describe("the cost of the models", () => {
  it("charges the verified rate card of every model it uses", () => {
    const card = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../scripts/seed/data/ratecard.json", import.meta.url)), "utf8")) as {
      readonly models: Readonly<Record<"agent" | "classifier" | "reader", { readonly modelId: string; readonly usdPerMillionTokens: unknown }>>;
    };
    expect(card.models.agent.usdPerMillionTokens).toEqual(SPEND_PRICES_USD_PER_MILLION.agent);
    expect(card.models.reader.usdPerMillionTokens).toEqual(SPEND_PRICES_USD_PER_MILLION.receipt);
    expect(card.models.classifier.usdPerMillionTokens).toEqual(SPEND_PRICES_USD_PER_MILLION.classifier);
    expect([card.models.agent.modelId, card.models.reader.modelId, card.models.classifier.modelId]).toEqual(["global.anthropic.claude-sonnet-5-5", "global.anthropic.claude-opus-5-5", "global.anthropic.claude-haiku-5-5"]);
  });

  it("prices every kind of token, the cache included", () => {
    const prices = SPEND_PRICES_USD_PER_MILLION.agent;
    const expected = (10_000 * prices.input + 1_000 * prices.output + 20_000 * prices.cacheRead + 2_000 * prices.cacheWrite) / 1_000_000;
    expect(tokenCostUsd(prices, USAGE)).toBeCloseTo(expected, 12);
  });

  it("charges an image read and a classifier call at least their ceiling", () => {
    expect(GUEST_SPEND_LIMITS.imageReadUsd).toBeGreaterThanOrEqual(callCeilingUsd("receipt"));
    expect(GUEST_SPEND_LIMITS.classifierCallUsd).toBeGreaterThanOrEqual(callCeilingUsd("classifier"));
  });

  it("rounds a charge up, never down", () => {
    expect(microUsd(0.0000001)).toBe(1);
    expect(microUsd(1)).toBe(MICRO_USD_PER_USD);
  });
});

describe("[FL-125] the spend bucket of a self-signup account", () => {
  it("is one lifetime bucket per account, last among the world's buckets, and only in self-signup worlds", () => {
    const buckets = worldBuckets(WORLD, 3, { turnCaps: { perHour: 200, perDay: 60 } }, TEST_NOW);
    expect(buckets.at(-1)).toEqual(spendBucket(WORLD));
    expect(spendBucket(WORLD)).toMatchObject({ window: "LIFETIME", key: SPEND_KEY, limit: LIMIT, units: RESERVATION });
    // No epoch in the key: a new epoch or a new world of the same account finds the same counter.
    expect(worldBuckets(WORLD, 7, { turnCaps: { perHour: 200, perDay: 60 } }, TEST_NOW).at(-1)?.key).toEqual(SPEND_KEY);
    for (const worldId of ["demo", "g01", "gtest", "qa-run1-su1"]) {
      expect(worldBuckets(worldId, 1, { turnCaps: { perHour: 200, perDay: 60 } }, TEST_NOW).some((bucket) => bucket.window === "LIFETIME"), worldId).toBe(false);
    }
  });

  it("admits simultaneous turns at the edge only while every reservation fits under US$1", async () => {
    const kit = await workerKit({ worldId: WORLD });
    // Room for two reservations and one micro-dollar short of a third.
    await prime(kit, LIMIT - 3 * RESERVATION + 1);
    const admitted = (await Promise.all(Array.from({ length: 6 }, () => countTurn(kit.connector, spendBucket(WORLD), TEST_NOW)))).filter(Boolean);
    expect(admitted).toHaveLength(2);
    expect(await kit.counter(SPEND_KEY)).toBe(LIMIT - RESERVATION + 1);
  });

  it("never lets reservations pass the cap however many turns race from zero", async () => {
    const kit = await workerKit({ worldId: WORLD });
    const admitted = (await Promise.all(Array.from({ length: 20 }, () => countTurn(kit.connector, spendBucket(WORLD), TEST_NOW)))).filter(Boolean);
    expect(admitted).toHaveLength(Math.floor(LIMIT / RESERVATION));
    expect(await kit.counter(SPEND_KEY)).toBe(admitted.length * RESERVATION);
  });

  it("settles a turn's reservation with the real cost of its tokens", async () => {
    const kit = await workerKit({ worldId: WORLD });
    kit.harness.script = () => completed({ usage: USAGE });
    await customerTurn(kit, "evt-settled");
    expect(kit.harness.requests).toHaveLength(1);
    expect(await kit.counter(SPEND_KEY)).toBe(microUsd(tokenCostUsd(SPEND_PRICES_USD_PER_MILLION.agent, USAGE)));
  });

  it("refuses the turn once the reservation does not fit: TURN_CAP, the handoff notice and no Harness, even a real day later", async () => {
    const kit = await workerKit({ worldId: WORLD });
    await prime(kit, LIMIT - RESERVATION + 1);
    kit.advanceReal(24 * 60 * 60_000);
    await customerTurn(kit, "evt-spent");
    expect(kit.harness.requests).toHaveLength(0);
    expect(kit.g1.texts).toHaveLength(0);
    expect((await kit.connector.audit.listByAction(WORLD, "TURN_CAP"))[0]?.detail).toMatchObject({ window: "LIFETIME", cap: LIMIT });
    expect(kit.gate.requests.map((request) => request.kind)).toEqual(["HANDOFF_NOTICE"]);
    expect(await kit.counter(SPEND_KEY)).toBe(LIMIT - RESERVATION + 1);
  });

  it("gives the reservation back when the Harness is throttled (the event is retried and reserves again)", async () => {
    const kit = await workerKit({ worldId: WORLD });
    kit.harness.script = () => {
      throw new HarnessError("THROTTLED", "throttled");
    };
    await expect(customerTurn(kit, "evt-throttled")).rejects.toBeDefined();
    expect(await kit.counter(SPEND_KEY)).toBe(0);
  });

  it("an image read charges its ceiling and is refused once it does not fit", async () => {
    const kit = await workerKit({ worldId: WORLD });
    const read = microUsd(GUEST_SPEND_LIMITS.imageReadUsd);
    await prime(kit, LIMIT - 2 * read);
    expect(await chargeSpend(kit.connector, WORLD, GUEST_SPEND_LIMITS.imageReadUsd, TEST_NOW)).toBe(true);
    expect(await chargeSpend(kit.connector, WORLD, GUEST_SPEND_LIMITS.imageReadUsd, TEST_NOW)).toBe(true);
    expect(await chargeSpend(kit.connector, WORLD, GUEST_SPEND_LIMITS.imageReadUsd, TEST_NOW)).toBe(false);
    expect(await kit.counter(SPEND_KEY)).toBe(LIMIT);
  });

  it("a settlement above the reservation is recorded in full and then nothing more is admitted", async () => {
    const kit = await workerKit({ worldId: WORLD });
    await prime(kit, LIMIT - RESERVATION);
    expect(await countTurn(kit.connector, spendBucket(WORLD), TEST_NOW)).toBe(true);
    const expensive = { inputTokens: 200_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await settleTurnSpend(kit.connector, WORLD, expensive, TEST_NOW);
    expect(await kit.counter(SPEND_KEY)).toBe(LIMIT - RESERVATION + microUsd(tokenCostUsd(SPEND_PRICES_USD_PER_MILLION.agent, expensive)));
    expect(await chargeSpend(kit.connector, WORLD, GUEST_SPEND_LIMITS.classifierCallUsd, TEST_NOW)).toBe(false);
  });

  it("never charges a world outside the cap (staff, invited guests, QA)", async () => {
    const kit = await workerKit();
    expect(await chargeSpend(kit.connector, "demo", 5, TEST_NOW)).toBe(true);
    await settleTurnSpend(kit.connector, "demo", USAGE, TEST_NOW);
    expect(await kit.counter(keys.runtime("demo", "SPENDCAP"))).toBe(0);
  });
});
