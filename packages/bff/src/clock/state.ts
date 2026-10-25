// What every move of a world's demo clock shares (ADR-0011, docs/architecture.md §10): reading the
// stored `Runtime/W#<worldId>#CLOCK`, the simulated "now" it gives at a real instant, the real instant
// a simulated one arrives at, and the three ways it changes, each written pinned to the version read:
//
//   PAUSED   simNow = pausedSimNow
//   RUNNING  simNow = anchorSim + (realNow − anchorReal) × rate, until `runningUntilReal` (30 real
//            minutes after it started): past it the world reads as PAUSED at the instant it reached,
//            and the next reader writes that pause back (`currentClock`)
//
// A move never goes back; only "Reiniciar mundo" reloads a clock (worlds/reset.ts).
import { ConnectorError, ToolError } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import type { ClockPatch } from "../connector/repos/runtime";
import type { StoredClock } from "../domain/runtime";
import { isoAr } from "../complaints/sla";

/** "Reloj en vivo" runs this long, then the world goes back to PAUSED on its own. */
export const RUNNING_WINDOW_MS = 30 * 60_000;

/** The rate a running clock gets by default: one simulated day per real minute. */
export const DEFAULT_RATE = 1_440;

export interface ClockView {
  readonly stored: StoredClock;
  readonly simNow: Date;
  /** RUNNING and still inside its window. */
  readonly running: boolean;
  /** RUNNING on paper but past `runningUntilReal`: to be written back as PAUSED. */
  readonly expired: boolean;
}

interface RunningFields {
  readonly anchorSim: string;
  readonly anchorReal: string;
  readonly rate: number;
}

function runningFields(stored: StoredClock): RunningFields {
  if (stored.anchorSim === undefined || stored.anchorReal === undefined || stored.rate === undefined) {
    throw new ConnectorError("VALIDATION", `the running clock of ${stored.worldId} has no anchor`, "Runtime");
  }
  return { anchorSim: stored.anchorSim, anchorReal: stored.anchorReal, rate: stored.rate };
}

function simAt(fields: RunningFields, realMs: number): Date {
  return new Date(Date.parse(fields.anchorSim) + Math.round((realMs - Date.parse(fields.anchorReal)) * fields.rate));
}

/** The simulated now of a stored clock at `realNow`, and whether it still runs. */
export function viewOf(stored: StoredClock, realNow: Date): ClockView {
  if (stored.mode === "PAUSED") {
    if (stored.pausedSimNow === undefined) throw new ConnectorError("VALIDATION", `the paused clock of ${stored.worldId} has no instant`, "Runtime");
    return { stored, simNow: new Date(stored.pausedSimNow), running: false, expired: false };
  }
  const fields = runningFields(stored);
  const until = stored.runningUntilReal === undefined ? Number.POSITIVE_INFINITY : Date.parse(stored.runningUntilReal);
  const now = realNow.getTime();
  if (now >= until) return { stored, simNow: simAt(fields, until), running: false, expired: true };
  return { stored, simNow: simAt(fields, now), running: true, expired: false };
}

/** Real instant a simulated one arrives at in a running clock: `anchorReal + (dueAtSim − anchorSim) / rate`. */
export function dueAtRealOf(stored: StoredClock, dueAtSim: string | Date): Date {
  const fields = runningFields(stored);
  const sim = typeof dueAtSim === "string" ? Date.parse(dueAtSim) : dueAtSim.getTime();
  return new Date(Date.parse(fields.anchorReal) + Math.round((sim - Date.parse(fields.anchorSim)) / fields.rate));
}

/** A simulated instant as the clock stores it: Argentine local time with its offset. */
export function simIso(instant: Date): string {
  return isoAr(instant);
}

export interface ClockChange {
  readonly patch: ClockPatch;
  readonly remove: readonly (keyof ClockPatch)[];
}

const RUNNING_ONLY: readonly (keyof ClockPatch)[] = ["anchorSim", "anchorReal", "rate", "runningUntilReal"];

/** PAUSED at `simNow`. */
export function pausedAt(simNow: Date): ClockChange {
  return { patch: { mode: "PAUSED", pausedSimNow: simIso(simNow) }, remove: RUNNING_ONLY };
}

/** RUNNING from `simNow` at `realNow`, for `RUNNING_WINDOW_MS`. */
export function runningFrom(simNow: Date, realNow: Date, rate: number): ClockChange {
  return {
    patch: { mode: "RUNNING", anchorSim: simIso(simNow), anchorReal: realNow.toISOString(), rate, runningUntilReal: new Date(realNow.getTime() + RUNNING_WINDOW_MS).toISOString() },
    remove: ["pausedSimNow"],
  };
}

/** The same mode at another simulated instant: a running world keeps its rate and its window. */
export function movedTo(view: ClockView, to: Date, realNow: Date): ClockChange {
  if (!view.running) return pausedAt(to);
  return { patch: { anchorSim: simIso(to), anchorReal: realNow.toISOString() }, remove: [] };
}

/** The stored clock of a world, strongly consistent. */
export async function readClock(connector: Pick<Connector, "runtime">, worldId: string): Promise<StoredClock> {
  const stored = await connector.runtime.getClock(worldId);
  if (!stored) throw new ToolError("NOT_FOUND", `world ${worldId} has no clock`, "CLOCK_MISSING");
  return stored;
}

/** Writes a change pinned to the version read; a move in between is a `CONFLICT` (`CLOCK_MOVED`). */
export async function writeClock(connector: Pick<Connector, "runtime" | "write">, stored: StoredClock, change: ClockChange): Promise<StoredClock> {
  try {
    await connector.write(connector.runtime.updateClockOp(stored.worldId, stored.version, change.patch, change.remove));
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") throw new ToolError("CONFLICT", "the clock moved in the meantime", "CLOCK_MOVED", { cause: error });
    throw error;
  }
  return readClock(connector, stored.worldId);
}

/** The clock as it is now: a running world past its window is written back as PAUSED first. */
export async function currentClock(connector: Pick<Connector, "runtime" | "write">, worldId: string, realNow: Date): Promise<{ readonly view: ClockView; readonly autoPaused: boolean }> {
  const stored = await readClock(connector, worldId);
  const view = viewOf(stored, realNow);
  if (!view.expired) return { view, autoPaused: false };
  try {
    const paused = await writeClock(connector, stored, pausedAt(view.simNow));
    return { view: viewOf(paused, realNow), autoPaused: true };
  } catch (error) {
    // Someone else wrote it in between (the same pause, or a move): read what they left.
    if (!(error instanceof ToolError && error.reason === "CLOCK_MOVED")) throw error;
    return { view: viewOf(await readClock(connector, worldId), realNow), autoPaused: false };
  }
}
