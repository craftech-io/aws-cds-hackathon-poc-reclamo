// Messages per sender and REAL hour of a world (docs/architecture.md §13, FL-105, FL-106):
// `Runtime/W#<w>#RATE#<phoneHash>#<realHour>`, with the limit `SETTINGS.rateLimitPerHour` of the world
// (20 by default). The guest drives the simulated clock, so the bucket is the real UTC hour: "+1 h" on
// the demo clock never opens a new one. A delivery is admitted in this order:
//
//   1. its provider id (`wamid`) already processed in this world → `DUPLICATE`, never counted (a
//      retried event or a doubled tap does not eat the sender's quota and never reaches the classifier);
//   2. else the counter goes up by one with a conditional `ADD`, so it never passes the limit however
//      many Lambdas race; at the limit → `RATE_LIMITED` (the adapter answers the fixed text once per
//      sender and hour, audits `DENY RATE_LIMIT`, and no turn runs).
//
// The provider id is only read here; the adapter marks it processed (`completeInbound`) after the
// message's effect is on record, so a delivery that failed half way comes back and runs again.
import type { Connector } from "../connector/port";
import { realHourStamp } from "../connector/repos/caps";
import { segment } from "../connector/keys";
import { sha256Hex } from "../lib/crypto";
import type { JsonObject } from "../domain/common";

/** Limit when a world's settings carry none (docs/architecture.md §13). */
export const DEFAULT_RATE_LIMIT_PER_HOUR = 20;

export interface InboundDelivery {
  /** Idempotency source of the channel (`WHATSAPP`). */
  readonly source: string;
  /** Provider id of the delivery (`wamid`). */
  readonly id: string;
}

/** A provider id as a key segment: as is when it fits, else its hash (a `wamid` may carry `/`). */
export function deliveryKey(id: string): string {
  try {
    return segment(id, "delivery id");
  } catch {
    return `h${sha256Hex(id).slice(0, 40)}`;
  }
}

export interface AdmitInput {
  readonly worldId: string;
  readonly delivery: InboundDelivery;
  /** Keyed hash of the sender's number; never the number. */
  readonly phoneHash: string;
  /** REAL time (never the world's clock). */
  readonly realNow: Date;
  readonly limitPerHour: number;
}

export type Admission =
  | { readonly outcome: "DUPLICATE" }
  | { readonly outcome: "ADMITTED"; readonly count: number; readonly limit: number; readonly realHour: string }
  | { readonly outcome: "RATE_LIMITED"; readonly limit: number; readonly realHour: string };

type Data = Pick<Connector, "claims" | "caps">;

/** The delivery's effect is already on record (`IDEMP#<source>#<id>`). */
export async function isProcessed(data: Pick<Connector, "claims">, worldId: string, delivery: InboundDelivery): Promise<boolean> {
  return (await data.claims.getIdempotency(worldId, delivery.source, deliveryKey(delivery.id))) !== undefined;
}

export async function admitInbound(data: Data, input: AdmitInput): Promise<Admission> {
  if (!Number.isInteger(input.limitPerHour) || input.limitPerHour < 1) throw new RangeError(`invalid rate limit ${input.limitPerHour}`);
  if (await isProcessed(data, input.worldId, input.delivery)) return { outcome: "DUPLICATE" };
  const realHour = realHourStamp(input.realNow);
  const counted = await data.caps.increment({ kind: "RATE", worldId: input.worldId, phoneHash: input.phoneHash, at: input.realNow }, input.limitPerHour);
  if (!counted.allowed) return { outcome: "RATE_LIMITED", limit: input.limitPerHour, realHour };
  return { outcome: "ADMITTED", count: counted.count, limit: input.limitPerHour, realHour };
}

/** Marks a delivery processed; called only once everything it caused is on record. */
export async function completeInbound(data: Pick<Connector, "claims">, worldId: string, delivery: InboundDelivery, result: JsonObject): Promise<void> {
  await data.claims.claimOnce(worldId, delivery.source, deliveryKey(delivery.id), result);
}

/** `IDEMP#<source>#<hash>-<realHour>`: true the first time only, so the "too many messages" reply goes once per hour. */
export async function firstNoticeOfHour(data: Pick<Connector, "claims">, worldId: string, source: string, phoneHash: string, realHour: string): Promise<boolean> {
  return (await data.claims.claimOnce(worldId, source, `${phoneHash.slice(0, 32)}-${realHour}`)).first;
}
