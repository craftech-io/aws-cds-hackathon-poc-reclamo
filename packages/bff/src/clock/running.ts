// The two modes of a world's clock (ADR-0011, docs/architecture.md §10, FL-082):
//
//   setRunning({rate})   "Reloj en vivo": RUNNING from the instant the world had, at `rate` simulated
//                        seconds per real second (1 = real time, 288 = a day every 5 minutes, 1440 by
//                        default = a day per minute), for 30 real minutes; its schedules (up to 50) are
//                        created in the same call. `rate` is 1 to 2,880 from the console; only the
//                        QaDriver goes beyond, and only in a `qa-*` world.
//   pause()              PAUSED at the instant reached; every schedule is deleted.
//   refreshClock()       the clock as it is now: a world past its live window goes back to PAUSED on its
//                        own (written back, schedules deleted). The console's poll and the janitor call it.
import { z } from "zod";
import { ToolError, worldKindOf } from "@reclamo/shared";
import { MAX_CONSOLE_RATE } from "../lib/clock";
import { type ResyncSummary, resyncWorld } from "../timers/resync";
import { type ClockCaller, type ClockDeps, auditClock } from "./advance";
import { assertWorldQuiet } from "./busy";
import { type ClockView, DEFAULT_RATE, currentClock, pausedAt, runningFrom, simIso, viewOf, writeClock } from "./state";

/** The QaDriver's ceiling in its own worlds: one simulated day per real second. */
export const QA_MAX_RATE = 86_400;

export const ConsoleRate = z.number().int().min(1).max(MAX_CONSOLE_RATE);
const QaRate = z.number().int().min(1).max(QA_MAX_RATE);

export interface ClockModeChanged {
  readonly worldId: string;
  readonly mode: "PAUSED" | "RUNNING";
  readonly simNow: string;
  readonly rate?: number;
  readonly runningUntilReal?: string;
  readonly resync: ResyncSummary;
}

/** `rate` is validated by who asks: the console up to 2,880; the QaDriver beyond only in `qa-*`. */
export function validRate(rate: number | undefined, worldId: string, caller: ClockCaller): number {
  const value = rate ?? DEFAULT_RATE;
  const qaWorld = worldKindOf(worldId) === "QA" && worldId.startsWith("qa-");
  const parsed = (caller.actor === "QA" && qaWorld ? QaRate : ConsoleRate).safeParse(value);
  if (!parsed.success) throw new ToolError("INVALID", `rate must be a whole number from 1 to ${caller.actor === "QA" && qaWorld ? QA_MAX_RATE : MAX_CONSOLE_RATE}`, "CLOCK_INVALID_RATE");
  return parsed.data;
}

function changed(worldId: string, view: ClockView, resync: ResyncSummary): ClockModeChanged {
  const { stored } = view;
  return {
    worldId,
    mode: view.running ? "RUNNING" : "PAUSED",
    simNow: simIso(view.simNow),
    ...(view.running && stored.rate !== undefined ? { rate: stored.rate } : {}),
    ...(view.running && stored.runningUntilReal !== undefined ? { runningUntilReal: stored.runningUntilReal } : {}),
    resync,
  };
}

/** "Reloj en vivo" at `rate` (also a change of rate of a running world: a new anchor, a new window). */
export async function setRunning(input: { readonly worldId: string; readonly rate?: number; readonly caller: ClockCaller }, deps: ClockDeps): Promise<ClockModeChanged> {
  const rate = validRate(input.rate, input.worldId, input.caller);
  const realNow = deps.realNow();
  const { view: before } = await currentClock(deps.connector, input.worldId, realNow);
  if (input.caller.gate) await assertWorldQuiet({ view: before, actor: input.caller.actor, force: input.caller.gate.force }, deps);
  const stored = await writeClock(deps.connector, before.stored, runningFrom(before.simNow, realNow, rate));
  const after = viewOf(stored, realNow);
  const resync = await resyncWorld(input.worldId, deps, { view: after });
  await auditClock(deps, after, input.caller.actor, "CLOCK_RUNNING", { rate, wasRunning: before.running, runningUntilReal: stored.runningUntilReal ?? "" });
  return changed(input.worldId, after, resync);
}

/** Back to PAUSED at the instant reached; no schedule left. */
export async function pause(input: { readonly worldId: string; readonly caller: ClockCaller }, deps: ClockDeps): Promise<ClockModeChanged> {
  const realNow = deps.realNow();
  const { view: before } = await currentClock(deps.connector, input.worldId, realNow);
  const stored = before.running ? await writeClock(deps.connector, before.stored, pausedAt(before.simNow)) : before.stored;
  const after = viewOf(stored, realNow);
  const resync = await resyncWorld(input.worldId, deps, { view: after });
  if (before.running) await auditClock(deps, after, input.caller.actor, "CLOCK_PAUSED", { reason: "REQUESTED" });
  return changed(input.worldId, after, resync);
}

/** The clock now; a world whose live window ended is written back PAUSED and loses its schedules. */
export async function refreshClock(input: { readonly worldId: string }, deps: ClockDeps): Promise<ClockModeChanged> {
  const { view, autoPaused } = await currentClock(deps.connector, input.worldId, deps.realNow());
  if (!autoPaused) return changed(input.worldId, view, { put: 0, deleted: 0, direct: 0, skipped: 0 });
  const resync = await resyncWorld(input.worldId, deps, { view });
  await auditClock(deps, view, "SYSTEM", "CLOCK_PAUSED", { reason: "WINDOW_ENDED" });
  return changed(input.worldId, view, resync);
}
