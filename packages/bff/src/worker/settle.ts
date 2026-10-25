// How an event leaves the world's quiescence (docs/architecture.md §7 "Quiescencia", "Mundos destruidos"
// and "Evento perdido"):
//
//   done        the event finished, ran before (`IDEMP#`) or was refused: `DELETE` every token of the event
//               (`<customerId>#<eventId>~<addedAtMs>`, one per enqueue of the same id) from
//               `WORLDSTATE.inFlight` (idempotent; a wiped world's missing row is nothing to remove)
//   tombstoned  an event of a destroyed world or of an old epoch (`TOMB#<epoch>`): discarded and audited
//               `TOMBSTONED_EVENT`, without error or retry, so it never reaches the dead letters nor an alarm
//   last try    the delivery that fails with `ApproximateReceiveCount ≥ 2` never finishes: before the error
//               is rethrown the event leaves `inFlight`, `Conversations/META.processError = {eventId, type,
//               atReal}` is written and `EVENT_DEAD_LETTERED` audited (FL-108), so an event in the DLQ never
//               keeps a world busy forever. Best effort: a failure here never hides the event's own error.
//
// What a world still waits for (in flight, due timers, pending emails and scans) is read by the clock's
// `WORLD_BUSY` gate and the QaDriver's `conv.settleProbe` from the same rows.
import { isConflict } from "../connector/errors";
import type { Connector } from "../connector/port";
import type { Logger } from "../lib/log";
import { WORKER_ACTIONS, auditOnce, countMetric } from "./audit";
import { type LooseIdentity, isInFlightTokenOf, legacyInFlightToken } from "./events";

export const DEAD_LETTER_METRIC = "EventDeadLettered";

type SettleData = Pick<Connector, "runtime" | "conversations" | "audit" | "claims" | "worlds">;

/** Takes the event out of `inFlight`; `false` when the world's row is gone (a wipe), never an error. */
export async function settleEvent(data: Pick<Connector, "runtime">, event: { readonly worldId: string; readonly customerId: string; readonly eventId: string }): Promise<boolean> {
  const state = await data.runtime.getWorldState(event.worldId);
  const tokens = state.inFlight.filter((token) => isInFlightTokenOf(token, event));
  return data.runtime.removeInFlight(event.worldId, tokens.length > 0 ? tokens : [legacyInFlightToken(event)]);
}

/** True when the event belongs to a destroyed world or to an epoch the world left behind. */
export async function isTombstoned(data: Pick<Connector, "runtime" | "worlds">, event: { readonly worldId: string; readonly epoch: number }): Promise<boolean> {
  const [tomb, meta] = await Promise.all([data.runtime.getTombstone(event.worldId, event.epoch), data.worlds.getMeta(event.worldId, { consistent: true })]);
  return tomb !== undefined || meta === undefined || meta.epoch !== event.epoch;
}

export interface DiscardInput {
  readonly worldId: string;
  readonly customerId: string;
  readonly eventId: string;
  readonly epoch: number;
  readonly type: string;
  readonly eventAtSim?: string;
}

/** A late event of a reset or destroyed world: audited once and settled, never retried. */
export async function discardTombstoned(deps: { readonly data: SettleData; readonly now: () => Date; readonly log: Logger }, event: DiscardInput): Promise<void> {
  const meta = await deps.data.worlds.getMeta(event.worldId);
  if (meta !== undefined) {
    // In the world's current epoch: the old epoch's partition may be gone with the wipe.
    await auditOnce(deps, { action: WORKER_ACTIONS.tombstoned, worldId: event.worldId, epoch: meta.epoch, eventId: event.eventId, ...(event.eventAtSim === undefined ? {} : { atSim: event.eventAtSim }), refs: { customerId: event.customerId, type: event.type, eventEpoch: String(event.epoch) } });
  }
  await settleEvent(deps.data, event);
  deps.log.info("event.tombstoned", { type: event.type, eventEpoch: event.epoch });
}

async function recordProcessError(data: SettleData, identity: Required<Pick<LooseIdentity, "worldId" | "customerId" | "eventId">> & { readonly type: string }, atReal: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const meta = await data.conversations.getMeta(identity.worldId, identity.customerId, { consistent: true });
    if (meta === undefined) return;
    try {
      await data.conversations.updateMeta(identity.worldId, identity.customerId, meta.version, { processError: { eventId: identity.eventId, type: identity.type.slice(0, 40), atReal } });
      return;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
}

/** The last delivery of a failing event: out of `inFlight`, `processError`, `EVENT_DEAD_LETTERED`. */
export async function deadLetter(deps: { readonly data: SettleData; readonly now: () => Date; readonly log: Logger }, identity: LooseIdentity): Promise<void> {
  countMetric(deps.log, DEAD_LETTER_METRIC, { type: identity.type ?? "UNKNOWN" });
  const { worldId, customerId, eventId } = identity;
  if (worldId === undefined || customerId === undefined || eventId === undefined) return;
  const type = identity.type ?? "UNKNOWN";
  try {
    await settleEvent(deps.data, { worldId, customerId, eventId });
    await recordProcessError(deps.data, { worldId, customerId, eventId, type }, deps.now().toISOString());
    const meta = await deps.data.worlds.getMeta(worldId);
    if (meta !== undefined) {
      await auditOnce(deps, { action: WORKER_ACTIONS.deadLettered, worldId, epoch: identity.epoch ?? meta.epoch, eventId, refs: { customerId, type } });
    }
  } catch (error) {
    deps.log.error("event.dead_letter_record_failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }
}
