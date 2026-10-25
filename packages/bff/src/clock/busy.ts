// Busy worlds (`WORLD_BUSY`, docs/architecture.md §7 "Quiescencia" and §10). A world is quiet when
// `WORLDSTATE.inFlight` is empty, no SCHEDULED timer is due (`dueAtSim ≤ simNow`) and no pending email
// or scan is still current. A pending item older than 10 real minutes is reported `stale` and no longer
// waited for. An event token is waited for as long as its message may still be alive in the queue
// (`EVENT_MAX_LIFE_MS`, about 78 minutes: a THROTTLED turn waits 36 minutes for its redelivery); only
// beyond that is it reported stale, as a last-resort net for a token nobody will remove. From the
// console, a move of the clock in a busy world changes nothing and answers the list of what it waits
// for; `force` ("Avanzar igual") is accepted only once the oldest pending item waited 5 real minutes,
// and is audited `CLOCK_FORCED`. The QaDriver passes no gate (it settles first).
import { ToolError } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import type { Actor } from "../domain/common";
import { EVENT_MAX_LIFE_MS, parseInFlightToken } from "../worker/events";
import { type TimerDeps, newIdOf } from "../timers/deps";
import type { ClockView } from "./state";

/** "Avanzar igual" is accepted once the oldest pending item waited this long. */
export const FORCE_AFTER_MS = 5 * 60_000;
/** A pending email or scan older than this is reported stale and no longer waited for. */
export const PENDING_STALE_MS = 10 * 60_000;
/** An event token older than this cannot belong to a live message any more (worker/queue-limits.ts). */
export const EVENT_STALE_MS = EVENT_MAX_LIFE_MS;

export const WORLD_BUSY = "WORLD_BUSY";

export interface WorldPending {
  readonly kind: "EVENT" | "MAIL" | "SCAN" | "TIMER";
  /** An event id, a pending id or a timer kind and id: never an address, a phone or a body. */
  readonly detail: string;
  readonly complaintId?: string;
  /** Real instant the wait started. */
  readonly sinceReal: string;
  readonly stale: boolean;
}

/** A busy world's refusal: nothing changed; here is what it waits for. */
export class WorldBusyError extends ToolError {
  constructor(
    readonly pending: readonly WorldPending[],
    readonly forceAllowedAtReal: string,
  ) {
    super("CONFLICT", "the world is busy: wait until it is quiet", WORLD_BUSY);
  }
}

/** What the world waits for at `realNow` (stale items included, flagged). */
export async function worldPending(connector: Pick<Connector, "runtime" | "timers">, view: ClockView, realNow: Date): Promise<WorldPending[]> {
  const worldId = view.stored.worldId;
  const [state, pending, due] = await Promise.all([
    connector.runtime.getWorldState(worldId),
    connector.runtime.listPending(worldId),
    connector.timers.listDue(worldId, { untilSim: view.simNow.toISOString() }),
  ]);
  const now = realNow.getTime();
  const events = state.inFlight.map((token): WorldPending => {
    const { eventId, addedAtMs } = parseInFlightToken(token);
    if (addedAtMs === undefined) return { kind: "EVENT", detail: eventId, sinceReal: state.updatedAt ?? realNow.toISOString(), stale: false };
    return { kind: "EVENT", detail: eventId, sinceReal: new Date(addedAtMs).toISOString(), stale: now - addedAtMs > EVENT_STALE_MS };
  });
  const waits = pending.map(
    (item): WorldPending => ({
      kind: item.kind,
      detail: item.pendingId,
      ...(item.complaintId ? { complaintId: item.complaintId } : {}),
      sinceReal: item.openedAtReal,
      stale: now - Date.parse(item.openedAtReal) > PENDING_STALE_MS,
    }),
  );
  const timers = due.map(
    (timer): WorldPending => ({
      kind: "TIMER",
      detail: `${timer.kind}#${timer.timerId}`,
      sinceReal: new Date(Math.max(Date.parse(view.stored.updatedAt ?? realNow.toISOString()), Date.parse(timer.updatedAt ?? realNow.toISOString()))).toISOString(),
      stale: false,
    }),
  );
  return [...events, ...waits, ...timers];
}

export interface GateRequest {
  readonly view: ClockView;
  readonly actor: Actor;
  readonly force: boolean;
}

/** Returns when the world is quiet or `force` is accepted (audited); throws `WorldBusyError` otherwise. */
export async function assertWorldQuiet(request: GateRequest, deps: TimerDeps): Promise<{ readonly forced: boolean }> {
  const realNow = deps.realNow();
  const pending = (await worldPending(deps.connector, request.view, realNow)).filter((item) => !item.stale);
  if (pending.length === 0) return { forced: false };
  const oldest = Math.min(...pending.map((item) => Date.parse(item.sinceReal)));
  const forceAllowedAtReal = new Date(oldest + FORCE_AFTER_MS);
  if (!request.force || realNow.getTime() < forceAllowedAtReal.getTime()) throw new WorldBusyError(pending, forceAllowedAtReal.toISOString());
  const { stored } = request.view;
  await deps.connector.audit.append({
    worldId: stored.worldId,
    epoch: stored.worldEpoch,
    auditId: newIdOf(deps, "aud"),
    ts: realNow.toISOString(),
    atSim: request.view.simNow.toISOString(),
    action: "CLOCK_FORCED",
    actor: request.actor,
    refs: { worldId: stored.worldId, pending: String(pending.length) },
    detail: { pending: pending.slice(0, 20).map((item) => `${item.kind}:${item.detail}`) },
  });
  return { forced: true };
}
