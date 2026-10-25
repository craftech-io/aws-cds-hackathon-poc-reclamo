// `advance_clock` (docs/tool-catalog.md, docs/architecture.md §10, FL-082): the console's and the
// QaDriver's way to move a world's simulated time.
//
//   advance(minutes)                 forward by at most 20 days
//   advanceTo(iso)                   forward only, at most 20 days ahead
//   advanceToNext()                  to the next SCHEDULED timer, together with those due within the
//                                    5 simulated minutes after it
//   advanceToNext({complaintId})     to the next timer of that complaint (`ByOwner CMP#<id>`), firing in
//                                    order everything due before it
//   advanceBusinessDay()             the same local time of the next business day (holidays counted)
//
// The move keeps the mode (a paused world gets a new `pausedSimNow`; a running one a new anchor, same
// rate and window), is written pinned to the clock's version, then fires every timer that fell due in
// `dueAtSim` and `seq` order, `firedBy CLOCK` at its own `dueAtSim`, and in a running world
// resynchronizes the schedules of the rest. The clock never goes back; only "Reiniciar mundo" reloads
// it. From the console the world must be quiet (busy.ts); the QaDriver passes no gate.
import { ToolError } from "@reclamo/shared";
import { complaintOwnerKey, loadHolidays } from "../complaints/sla";
import type { Actor } from "../domain/common";
import { nthBusinessDay } from "../services/business-days";
import { type TimerDeps, newIdOf } from "../timers/deps";
import { fireTimer } from "../timers/fire";
import { type ResyncSummary, resyncWorld } from "../timers/resync";
import { assertWorldQuiet } from "./busy";
import { type ClockView, currentClock, movedTo, simIso, viewOf, writeClock } from "./state";

/** No single move goes further than this. */
export const MAX_MOVE_MS = 20 * 24 * 60 * 60_000;
/** `advanceToNext()` also fires what falls due this soon after the next timer. */
export const NEXT_WINDOW_MS = 5 * 60_000;
/** Fires one move may make (a guard against a loop, far above any template). */
const MAX_FIRES_PER_MOVE = 1_000;

export type ClockMove =
  | { readonly kind: "advance"; readonly minutes: number }
  | { readonly kind: "advanceTo"; readonly to: string }
  | { readonly kind: "advanceToNext"; readonly complaintId?: string }
  | { readonly kind: "advanceBusinessDay" };

/** Who moves the clock; `gate` is the console's (`WORLD_BUSY`), absent for the QaDriver. */
export interface ClockCaller {
  readonly actor: Actor;
  readonly gate?: { readonly force: boolean };
  readonly correlationId?: string;
}

export interface ClockDeps extends TimerDeps {
  /** The Argentine holidays (`Reference/HOLIDAY#AR`); loaded from the connector when absent. */
  readonly holidays?: () => Promise<readonly string[]>;
}

export interface FiredRef {
  readonly kind: string;
  readonly timerId: string;
  readonly dueAtSim: string;
  readonly status: "FIRED" | "RACE" | "FAILED";
}

export interface ClockMoved {
  readonly worldId: string;
  readonly mode: "PAUSED" | "RUNNING";
  readonly fromSim: string;
  readonly simNow: string;
  readonly worldEpoch: number;
  readonly fired: readonly FiredRef[];
  /** "Avanzar igual" was accepted for a busy world. */
  readonly forced: boolean;
  readonly resync?: ResyncSummary;
}

function invalid(message: string, reason: string): ToolError {
  return new ToolError("INVALID", message, reason);
}

function within(from: Date, to: number): Date {
  if (to < from.getTime()) throw invalid("the clock never goes back", "CLOCK_BACKWARDS");
  if (to - from.getTime() > MAX_MOVE_MS) throw invalid("a move goes at most 20 days ahead", "CLOCK_MOVE_TOO_LONG");
  return new Date(to);
}

async function targetOf(worldId: string, move: ClockMove, simNow: Date, deps: ClockDeps): Promise<Date> {
  const from = simNow.getTime();
  switch (move.kind) {
    case "advance":
      if (!Number.isInteger(move.minutes) || move.minutes <= 0) throw invalid("a move is a whole, positive number of minutes", "CLOCK_INVALID_MOVE");
      return within(simNow, from + move.minutes * 60_000);
    case "advanceTo": {
      const to = Date.parse(move.to);
      if (Number.isNaN(to)) throw invalid("the target is not an instant", "CLOCK_INVALID_MOVE");
      return within(simNow, to);
    }
    case "advanceBusinessDay": {
      const holidays = deps.holidays ? await deps.holidays() : await loadHolidays(deps.connector);
      return within(simNow, nthBusinessDay(simNow, 1, simIso(simNow).slice(11, 19), holidays).getTime());
    }
    case "advanceToNext": {
      if (move.complaintId !== undefined) {
        const owned = (await deps.connector.timers.listByOwner(worldId, complaintOwnerKey(move.complaintId))).filter((timer) => timer.status === "SCHEDULED");
        const next = owned.map((timer) => Date.parse(timer.dueAtSim)).sort((a, b) => a - b)[0];
        if (next === undefined) throw invalid("this complaint has no pending milestone", "CLOCK_NOTHING_PENDING");
        return new Date(Math.max(from, next));
      }
      const next = await deps.connector.timers.next(worldId);
      if (!next) throw invalid("nothing is pending in this world", "CLOCK_NOTHING_PENDING");
      const first = Date.parse(next.dueAtSim);
      const window = await deps.connector.timers.listDue(worldId, { untilSim: new Date(first + NEXT_WINDOW_MS).toISOString() });
      const last = Math.max(first, ...window.map((timer) => Date.parse(timer.dueAtSim)));
      return new Date(Math.max(from, last));
    }
  }
}

/**
 * Fires every SCHEDULED timer due at or before `untilSim`, oldest first, until none is left (a
 * publication fires its rechecks along; a fire that failed and was undone is not retried in this move).
 */
export async function dispatchDue(worldId: string, untilSim: Date, deps: TimerDeps, correlationId?: string): Promise<FiredRef[]> {
  const fired: FiredRef[] = [];
  const tried = new Set<string>();
  while (fired.length < MAX_FIRES_PER_MOVE) {
    const due = (await deps.connector.timers.listDue(worldId, { untilSim: untilSim.toISOString() })).filter((timer) => !tried.has(`${timer.kind}#${timer.timerId}`));
    const timer = due[0];
    if (!timer) break;
    tried.add(`${timer.kind}#${timer.timerId}`);
    const outcome = await fireTimer({ timer, firedBy: "CLOCK", ...(correlationId ? { correlationId } : {}) }, deps);
    fired.push({ kind: timer.kind, timerId: timer.timerId, dueAtSim: timer.dueAtSim, status: outcome.status });
    if (outcome.status === "FIRED") for (const timerId of outcome.effect.alsoFired) tried.add(`SETTLEMENT_RECHECK#${timerId}`);
  }
  return fired;
}

export async function auditClock(deps: TimerDeps, view: ClockView, actor: Actor, action: string, detail: Record<string, string | number | boolean>): Promise<void> {
  await deps.connector.audit.append({
    worldId: view.stored.worldId,
    epoch: view.stored.worldEpoch,
    auditId: newIdOf(deps, "aud"),
    ts: deps.realNow().toISOString(),
    atSim: simIso(view.simNow),
    action,
    actor,
    refs: { worldId: view.stored.worldId },
    detail,
  });
}

/** `advance`, `advanceTo`, `advanceToNext` or `advanceBusinessDay` of one world. */
export async function advanceClock(input: { readonly worldId: string; readonly move: ClockMove; readonly caller: ClockCaller }, deps: ClockDeps): Promise<ClockMoved> {
  const realNow = deps.realNow();
  const { view: before } = await currentClock(deps.connector, input.worldId, realNow);
  const { forced } = input.caller.gate ? await assertWorldQuiet({ view: before, actor: input.caller.actor, force: input.caller.gate.force }, deps) : { forced: false };
  const target = await targetOf(input.worldId, input.move, before.simNow, deps);
  const stored = target.getTime() === before.simNow.getTime() ? before.stored : await writeClock(deps.connector, before.stored, movedTo(before, target, realNow));
  const after = viewOf(stored, realNow);
  const fired = await dispatchDue(input.worldId, target, deps, input.caller.correlationId);
  const resync = after.running ? await resyncWorld(input.worldId, deps, { view: after }) : undefined;
  await auditClock(deps, after, input.caller.actor, "CLOCK_ADVANCED", { move: input.move.kind, fromSim: simIso(before.simNow), toSim: simIso(target), fired: fired.length, forced });
  return {
    worldId: input.worldId,
    mode: after.running ? "RUNNING" : "PAUSED",
    fromSim: simIso(before.simNow),
    simNow: simIso(target),
    worldEpoch: stored.worldEpoch,
    fired,
    forced,
    ...(resync ? { resync } : {}),
  };
}

