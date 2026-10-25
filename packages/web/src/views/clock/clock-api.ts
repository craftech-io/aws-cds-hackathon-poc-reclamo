// What the demo clock reads and does (docs/tool-catalog.md, `clock.*`), parsed with zod at the edge.
// Every move goes through the BFF, which refuses it with `WORLD_BUSY` while the world is not quiet (and
// accepts `force` only once the oldest pending item waited 5 real minutes) and with `INVALID` for a
// rate out of range.
import { ClockMode, IsoInstant } from "@reclamo/shared";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import { announceClockMoved } from "../../lib/clock-events";

export const PendingItem = z.looseObject({
  kind: z.string().min(1),
  sinceReal: IsoInstant,
  complaintId: z.string().optional(),
  stale: z.boolean().optional(),
});

export const UpcomingTimer = z.looseObject({
  kind: z.string().min(1),
  timerId: z.string().min(1),
  dueAtSim: IsoInstant,
  ownerKey: z.string().nullable(),
  complaintId: z.string().nullable(),
});
export type UpcomingTimer = z.infer<typeof UpcomingTimer>;

export const ClockAnswer = z.looseObject({
  worldId: z.string().min(1),
  worldEpoch: z.number().int().nonnegative(),
  mode: ClockMode,
  simNow: IsoInstant,
  rate: z.number().positive().optional(),
  runningUntilReal: IsoInstant.optional(),
  upcoming: z.array(UpcomingTimer),
  busy: z.looseObject({ reason: z.string().min(1), pending: z.array(PendingItem), forceAllowedAtReal: IsoInstant }).nullable(),
});
export type ClockAnswer = z.infer<typeof ClockAnswer>;

/** What a move answered: where the clock went and what it fired. */
export const ClockMoved = z.looseObject({
  fromSim: IsoInstant,
  simNow: IsoInstant,
  fired: z.array(z.looseObject({ kind: z.string(), timerId: z.string() })),
});
export type ClockMoved = z.infer<typeof ClockMoved>;

export async function fetchClock(trpc: ConsoleClient, signal: AbortSignal): Promise<ClockAnswer> {
  return ClockAnswer.parse(await trpc.clock.get.query(undefined, { signal }));
}

export type ClockCommand =
  | { readonly kind: "next"; readonly force?: boolean }
  | { readonly kind: "hour"; readonly force?: boolean }
  | { readonly kind: "businessDay"; readonly force?: boolean }
  | { readonly kind: "fire"; readonly timer: Pick<UpcomingTimer, "kind" | "timerId">; readonly force?: boolean }
  | { readonly kind: "live"; readonly rate: number }
  | { readonly kind: "pause" }
  | { readonly kind: "reset" };

const HOUR_MINUTES = 60;

/** Runs one command and announces it to the shell's bar; a move answers where the clock went, the rest `undefined`. */
export async function runClockCommand(trpc: ConsoleClient, command: ClockCommand): Promise<ClockMoved | undefined> {
  try {
    return await clockCommand(trpc, command);
  } finally {
    announceClockMoved();
  }
}

async function clockCommand(trpc: ConsoleClient, command: ClockCommand): Promise<ClockMoved | undefined> {
  const force = "force" in command && command.force === true ? { force: true } : {};
  switch (command.kind) {
    case "next":
      return ClockMoved.parse(await trpc.clock.advanceToNext.mutate(force));
    case "hour":
      return ClockMoved.parse(await trpc.clock.advance.mutate({ minutes: HOUR_MINUTES, ...force }));
    case "businessDay":
      return ClockMoved.parse(await trpc.clock.advanceBusinessDay.mutate(force));
    case "fire":
      return ClockMoved.parse(await trpc.clock.fireNow.mutate({ kind: command.timer.kind, timerId: command.timer.timerId, ...force }));
    case "live":
      await trpc.clock.setRunning.mutate({ rate: command.rate });
      return undefined;
    case "pause":
      await trpc.clock.pause.mutate();
      return undefined;
    case "reset":
      await trpc.clock.reset.mutate();
      return undefined;
  }
}
