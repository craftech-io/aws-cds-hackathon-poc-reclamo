// The turn caps the worker counts BEFORE every turn, before G1 and before the Harness (docs/architecture.md
// §9.1 and §13, ADR-0017 and its ADR-0020 amendment, docs/architecture-guests.md §7). Every window is on
// the REAL clock: the guest drives the world clock, so "+1 h" never opens a new bucket. Each bucket is
// one counter incremented with a conditional `ADD` only while it is below its cap, so the count never
// passes it however many workers race. A bucket whose units are more than one (the spend bucket)
// admits only while the count plus those units fits under its cap.
//
//   world        W#<w>#TURNCAP#<realHour|realDay>        SETTINGS.turnCaps (demo 200/h · 1,000/d; gNN 150/d)
//   self-signup  W#<w>#TURNCAPEPOCH#e<epoch>             150 per epoch (the day cap of a gs-* is 60, in SETTINGS)
//   self-signup  W#<w>#SPENDCAP                          US$1 of models over the account's life, in micro-dollars:
//                                                        the turn reserves its share and is settled (worker/spend.ts)
//   pool         GLOBALCAP#<pool>#<realMinute|Hour|Day>  PUBLIC (demo, gNN, gtest, gprobe) 300/h · 1,500/d
//                                                        SIGNUP (gs-*) 5/min · 60/h · 400/d
//                                                        QA (qa-*, qamin, sim-*) 500/h · 1,500/d
//
// The world's caps are counted first and the pool's after: a turn the world refuses never spends a
// unit of the pool. A refusal is `TURN_CAP` or `GLOBAL_CAP`: no turn, the handoff notice, a person.
import { guestOriginOf, worldKindOf } from "@reclamo/shared";
import { realDayStamp, realHourStamp } from "../connector/repos/caps";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import type { Connector } from "../connector/port";
import { type Key, cond } from "../connector/store";
import type { WorldSettings } from "../domain/world";
import { GUEST_SPEND_LIMITS, GUEST_WORLD_LIMITS, LEADS_TTL_SECONDS } from "../leads/limits";

export type CapPool = "PUBLIC" | "SIGNUP" | "QA";
export type CapWindow = "MINUTE" | "HOUR" | "DAY" | "EPOCH" | "LIFETIME";

/** The pool of a world, from its id only. */
export function poolOf(worldId: string): CapPool {
  const kind = worldKindOf(worldId);
  if (kind === "QA" || kind === "SIM") return "QA";
  if (guestOriginOf(worldId) === "SIGNUP") return "SIGNUP";
  return "PUBLIC";
}

/** Caps of every pool, per real window (docs/architecture.md §13, docs/architecture-guests.md §7). */
export const GLOBAL_TURN_CAPS: Readonly<Record<CapPool, Partial<Record<RealWindow, number>>>> = {
  PUBLIC: { HOUR: 300, DAY: 1_500 },
  SIGNUP: { MINUTE: 5, HOUR: 60, DAY: 400 },
  QA: { HOUR: 500, DAY: 1_500 },
};

type RealWindow = Exclude<CapWindow, "EPOCH" | "LIFETIME">;

/** A self-signup world's turns per epoch, apart from its day cap (ADR-0020). */
export const SIGNUP_TURNS_PER_EPOCH = GUEST_WORLD_LIMITS.turnsPerEpoch;

const DAY_SECONDS = 86_400;
/** One US dollar in the spend bucket's units. */
export const MICRO_USD_PER_USD = 1_000_000;

/** US dollars in micro-dollars, rounded up: a charge never comes out smaller than its price. */
export function microUsd(usd: number): number {
  return Math.ceil(usd * MICRO_USD_PER_USD);
}

/**
 * Counters of a minute, an hour or a day live 48 real hours; an epoch's lives as long as a gs-* world can
 * (7 days) plus one; the spend bucket as long as the account's lead, renewed on every charge.
 */
export const CAP_COUNTER_TTL_SECONDS: Readonly<Record<CapWindow, number>> = {
  MINUTE: 2 * DAY_SECONDS,
  HOUR: 2 * DAY_SECONDS,
  DAY: 2 * DAY_SECONDS,
  EPOCH: 8 * DAY_SECONDS,
  LIFETIME: LEADS_TTL_SECONDS.lead,
};

export interface CapBucket {
  readonly scope: "WORLD" | "POOL";
  readonly window: CapWindow;
  readonly key: Key;
  readonly limit: number;
  /** What one admission adds (1 turn, or a spend reservation in micro-dollars); 1 when absent. */
  readonly units?: number;
}

/** What one admission of `bucket` adds. */
export function unitsOf(bucket: Pick<CapBucket, "units">): number {
  return bucket.units ?? 1;
}

/** True while `bucket`, at `count`, still has room for one more admission. */
export function hasRoom(bucket: Pick<CapBucket, "limit" | "units">, count: number): boolean {
  return count + unitsOf(bucket) <= bucket.limit;
}

/** The condition of an admission: no counter yet, or room for its units (DynamoDB evaluates it atomically). */
export function roomCondition(bucket: Pick<CapBucket, "limit" | "units">) {
  return cond.or(cond.notExists("count"), cond.lt("count", bucket.limit - unitsOf(bucket) + 1));
}

/** Whether a bucket can ever admit: a positive integer cap at least as large as its units. */
export function admissible(bucket: Pick<CapBucket, "limit" | "units">): boolean {
  const units = unitsOf(bucket);
  return Number.isInteger(bucket.limit) && bucket.limit > 0 && Number.isInteger(units) && units > 0 && units <= bucket.limit;
}

/** `W#<w>#SPENDCAP`: the models' spend of a self-signup account, admitted a turn's reservation at a time. */
export function spendBucket(worldId: string): CapBucket {
  return {
    scope: "WORLD",
    window: "LIFETIME",
    key: keys.runtime(worldId, "SPENDCAP"),
    limit: microUsd(GUEST_SPEND_LIMITS.usdPerAccount),
    units: microUsd(GUEST_SPEND_LIMITS.turnReservationUsd),
  };
}

function stamp(window: RealWindow, at: Date): string {
  if (window === "MINUTE") return at.toISOString().slice(0, 16);
  return window === "HOUR" ? realHourStamp(at) : realDayStamp(at);
}

/** The world's buckets for one turn at real instant `at`. */
export function worldBuckets(worldId: string, epoch: number, settings: Pick<WorldSettings, "turnCaps">, at: Date): CapBucket[] {
  const buckets: CapBucket[] = [
    { scope: "WORLD", window: "HOUR", key: keys.runtime(worldId, "TURNCAP", stamp("HOUR", at)), limit: settings.turnCaps.perHour },
    { scope: "WORLD", window: "DAY", key: keys.runtime(worldId, "TURNCAP", stamp("DAY", at)), limit: settings.turnCaps.perDay },
  ];
  if (poolOf(worldId) === "SIGNUP") {
    buckets.push({ scope: "WORLD", window: "EPOCH", key: keys.runtime(worldId, "TURNCAPEPOCH", keys.epochPart(epoch)), limit: SIGNUP_TURNS_PER_EPOCH });
    // Last: a turn another world bucket refuses never holds a reservation.
    buckets.push(spendBucket(worldId));
  }
  return buckets;
}

/** The pool's buckets for one turn of `worldId` at real instant `at`. */
export function poolBuckets(worldId: string, at: Date): CapBucket[] {
  const pool = poolOf(worldId);
  return (Object.entries(GLOBAL_TURN_CAPS[pool]) as [RealWindow, number][]).map(([window, limit]) => ({
    scope: "POOL",
    window,
    key: keys.global("GLOBALCAP", pool, stamp(window, at)),
    limit,
  }));
}

export type CapCount = { readonly allowed: true } | { readonly allowed: false; readonly bucket: CapBucket };

/** One more turn in `bucket` (its units) unless that would pass its cap. */
export async function countTurn(data: Pick<Connector, "write">, bucket: CapBucket, at: Date): Promise<boolean> {
  if (!admissible(bucket)) return false;
  try {
    await data.write({
      kind: "update",
      table: "Runtime",
      key: bucket.key,
      condition: roomCondition(bucket),
      update: { add: { count: unitsOf(bucket) }, set: { entity: "CapCounter", updatedAt: at.toISOString(), expiresAt: Math.floor(at.getTime() / 1000) + CAP_COUNTER_TTL_SECONDS[bucket.window] } },
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

/** Counts the turn in every bucket in order; the first one at its cap refuses (and the rest are not touched). */
export async function countTurnIn(data: Pick<Connector, "write">, buckets: readonly CapBucket[], at: Date): Promise<CapCount> {
  for (const bucket of buckets) {
    if (!(await countTurn(data, bucket, at))) return { allowed: false, bucket };
  }
  return { allowed: true };
}
