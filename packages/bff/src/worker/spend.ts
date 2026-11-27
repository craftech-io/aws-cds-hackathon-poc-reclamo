// The models' spend of a self-signup account (`W#<w>#SPENDCAP`, leads/limits.ts `GUEST_SPEND_LIMITS`):
// one counter in micro-dollars over the account's whole life, on the same conditional `ADD` as the turn
// caps, so concurrent workers never admit past it.
//
//   turn          worldBuckets reserves `turnReservationUsd` before G1 and the Harness; once the Harness
//                 answered, `settleTurnSpend` adds the difference to the real cost of its tokens (cache
//                 included). A turn that never reached the Harness's answer keeps its reservation.
//   image read    `chargeSpend` of `imageReadUsd` (the ceiling of one read) before `Converse`
//   classifier    `chargeSpend` of `classifierCallUsd` (the ceiling of one call) before `Converse`
//
// Reservations never pass the cap; a settlement may, by what a turn cost above its reservation, and
// then no further call is admitted. Only `SIGNUP` worlds (`gs-*`) have the bucket.
import type { TokenUsage } from "../agent/harness-client";
import { isConflict } from "../connector/errors";
import type { Connector } from "../connector/port";
import { GUEST_SPEND_LIMITS } from "../leads/limits";
import { CAP_COUNTER_TTL_SECONDS, admissible, microUsd, poolOf, roomCondition, spendBucket, unitsOf } from "./caps";

/**
 * Prices in US dollars per million tokens used to charge the cap, one per model of
 * `infra/agentcore-spec.ts` (all through `global.*` profiles): the verified rate card of
 * `scripts/seed/data/ratecard.json` (AWS Price List, us-east-1). `spend.test.ts` keeps them equal.
 */
export const SPEND_PRICES_USD_PER_MILLION = {
  /** The Harness: `global.anthropic.claude-sonnet-5-5` (its application profile bills the global price). */
  agent: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  /** The receipt reader: `global.anthropic.claude-opus-5-5`. */
  receipt: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  /** The intake classifier: `global.anthropic.claude-haiku-5-5`. */
  classifier: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
} as const;

type Prices = (typeof SPEND_PRICES_USD_PER_MILLION)[keyof typeof SPEND_PRICES_USD_PER_MILLION];

/** What one call may cost at most: the bound `imageReadUsd` and `classifierCallUsd` must cover. */
export const CALL_TOKEN_CEILINGS = {
  /** An image (at most ~1,600 tokens after Bedrock's resize), the instruction and the schema, with margin; `maxTokens` 800. */
  receipt: { input: 5_000, output: 800 },
  /** A message, the instruction and the schema, with margin; `MODEL_MAX_TOKENS` 200. */
  classifier: { input: 3_000, output: 200 },
} as const;

/** The cost of a call's tokens, in US dollars. */
export function tokenCostUsd(prices: Prices, usage: TokenUsage): number {
  return (usage.inputTokens * prices.input + usage.outputTokens * prices.output + usage.cacheReadTokens * prices.cacheRead + usage.cacheWriteTokens * prices.cacheWrite) / 1_000_000;
}

/** The ceiling of one call of `model`, in US dollars. */
export function callCeilingUsd(model: keyof typeof CALL_TOKEN_CEILINGS): number {
  const tokens = CALL_TOKEN_CEILINGS[model];
  return tokenCostUsd(SPEND_PRICES_USD_PER_MILLION[model], { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

/** Whether `worldId` is charged at all: only self-signup worlds. */
export function spendCapped(worldId: string): boolean {
  return poolOf(worldId) === "SIGNUP";
}

function ttl(at: Date): number {
  return Math.floor(at.getTime() / 1000) + CAP_COUNTER_TTL_SECONDS.LIFETIME;
}

/**
 * Charges `usd` to the account of `worldId` unless it would pass the cap; `true` when charged. A world
 * outside the cap is always admitted and never written.
 */
export async function chargeSpend(data: Pick<Connector, "write">, worldId: string, usd: number, at: Date): Promise<boolean> {
  if (!spendCapped(worldId)) return true;
  const bucket = { ...spendBucket(worldId), units: microUsd(usd) };
  if (!admissible(bucket)) return false;
  try {
    await data.write({
      kind: "update",
      table: "Runtime",
      key: bucket.key,
      condition: roomCondition(bucket),
      update: { add: { count: unitsOf(bucket) }, set: { entity: "CapCounter", updatedAt: at.toISOString(), expiresAt: ttl(at) } },
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

/** Adds `delta` micro-dollars whatever the count: a settlement or a release, never an admission. */
async function adjust(data: Pick<Connector, "write">, worldId: string, delta: number, at: Date): Promise<void> {
  if (delta === 0) return;
  await data.write({
    kind: "update",
    table: "Runtime",
    key: spendBucket(worldId).key,
    update: { add: { count: delta }, set: { entity: "CapCounter", updatedAt: at.toISOString(), expiresAt: ttl(at) } },
  });
}

/** The turn's reservation becomes the real cost of its tokens (the difference, up or down). */
export async function settleTurnSpend(data: Pick<Connector, "write">, worldId: string, usage: TokenUsage, at: Date): Promise<void> {
  if (!spendCapped(worldId)) return;
  const cost = microUsd(tokenCostUsd(SPEND_PRICES_USD_PER_MILLION.agent, usage));
  await adjust(data, worldId, cost - microUsd(GUEST_SPEND_LIMITS.turnReservationUsd), at);
}

/** Gives back the reservation of a turn that a later gate refused before anything ran. */
export async function releaseTurnReservation(data: Pick<Connector, "write">, worldId: string, at: Date): Promise<void> {
  if (!spendCapped(worldId)) return;
  await adjust(data, worldId, -microUsd(GUEST_SPEND_LIMITS.turnReservationUsd), at);
}
