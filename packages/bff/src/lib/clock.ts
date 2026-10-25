// "Now" for every deterministic rule (ADR-0011). Nothing in services/, channel-policy/ or the tools
// reads the machine clock directly: they receive a `Clock`, so tests run with fixed dates and every
// business fact lives in the simulated time of its world, which the demo clock pauses, advances and
// runs at a `rate`. Abuse caps, token ages and TTLs use the real clock, never a world clock.
import { z } from "zod";
import { ClockMode, IsoInstant } from "@reclamo/shared";

export interface Clock {
  now(): Promise<Date>;
}

/** Real time. Only for what is real by definition: token ages, TTLs in real time, abuse caps, audit stamps. */
export const systemClock: Clock = { now: async () => new Date() };

export function fixedClock(instant: string | Date): Clock {
  const date = instant instanceof Date ? new Date(instant.getTime()) : new Date(IsoInstant.parse(instant));
  return { now: async () => new Date(date.getTime()) };
}

/** Largest `rate` the console may set (docs/architecture.md §10); only the QaDriver goes beyond, in qa-* worlds. */
export const MAX_CONSOLE_RATE = 2_880;

/** `Runtime/W#<worldId>#CLOCK`, the fields the simulated "now" depends on. */
export const ClockState = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal(ClockMode.enum.PAUSED), pausedSimNow: IsoInstant }),
  z.object({ mode: z.literal(ClockMode.enum.RUNNING), anchorSim: IsoInstant, anchorReal: IsoInstant, rate: z.number().positive() }),
]);
export type ClockState = z.infer<typeof ClockState>;

/** `pausedSimNow` in PAUSED; `anchorSim + (realNow − anchorReal) × rate` in RUNNING. */
export function simulatedNow(state: ClockState, realNow: Date): Date {
  if (state.mode === "PAUSED") return new Date(state.pausedSimNow);
  const elapsedReal = realNow.getTime() - Date.parse(state.anchorReal);
  return new Date(Date.parse(state.anchorSim) + Math.round(elapsedReal * state.rate));
}

/** Real instant at which a simulated instant arrives: `anchorReal + (dueAtSim − anchorSim) / rate`. */
export function realInstantOf(state: Extract<ClockState, { mode: "RUNNING" }>, dueAtSim: Date): Date {
  return new Date(Date.parse(state.anchorReal) + Math.round((dueAtSim.getTime() - Date.parse(state.anchorSim)) / state.rate));
}

/** Reads the stored clock of a world (the connector implements it over `Runtime`). */
export type ClockStateReader = (worldId: string) => Promise<ClockState>;

/** The simulated clock of one world: every `now()` re-reads the stored state, so a pause is seen at once. */
export function worldClock(worldId: string, read: ClockStateReader, real: Clock = systemClock): Clock {
  return {
    async now() {
      const [state, realNow] = await Promise.all([read(worldId), real.now()]);
      return simulatedNow(ClockState.parse(state), realNow);
    },
  };
}
