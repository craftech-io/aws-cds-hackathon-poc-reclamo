// What the shell reads of the world's clock and reset (docs/tool-catalog.md, `clock.get`,
// `clock.resetStatus`, `tour.steps`), parsed with zod at the edge: the answers cross the network,
// and the shell must degrade to "no bar" instead of breaking a view when a field is missing.
import { ClockMode, IsoInstant, formatSimInstant } from "@reclamo/shared";
import { z } from "zod";
import type { ApiError } from "./api-error";

/** How often the fixed "we are resetting your world" screen asks `clock.resetStatus`. */
export const RESET_POLL_MS = 3_000;

export const WORLD_RESETTING_REASON = "WORLD_RESETTING";

/** The only procedure that answers while the world is being reset. */
export const RESET_STATUS_PATH = "clock.resetStatus";

export const ClockSnapshot = z.looseObject({
  mode: ClockMode,
  simNow: IsoInstant,
  rate: z.number().positive().optional(),
  /** Why the world is not quiet (a turn in flight, a queued event, an email without its SES event). */
  busy: z.looseObject({ reason: z.string().min(1) }).nullish(),
});
export type ClockSnapshot = z.infer<typeof ClockSnapshot>;

export const ResetStatus = z.looseObject({
  status: z.enum(["REGISTERED", "CREATING", "READY", "RESETTING"]),
  phase: z.string().optional(),
  startedAtReal: IsoInstant.optional(),
});
export type ResetStatus = z.infer<typeof ResetStatus>;

export const TourSteps = z.looseObject({
  totalMinutes: z.number().nonnegative(),
  steps: z.array(z.looseObject({ id: z.string().min(1), title: z.string().min(1), minutes: z.number().nonnegative().optional() })),
});
export type TourSteps = z.infer<typeof TourSteps>;

export interface ClockView {
  readonly simNowText: string;
  readonly mode: ClockMode;
  readonly rate: number;
  readonly busyReason: string | undefined;
}

/** The bar's props from a `clock.get` answer, or `undefined` when it does not look like one. */
export function clockViewOf(answer: unknown): ClockView | undefined {
  const parsed = ClockSnapshot.safeParse(answer);
  if (!parsed.success) return undefined;
  const { mode, simNow, rate, busy } = parsed.data;
  return { simNowText: formatSimInstant(simNow), mode, rate: rate ?? 1, busyReason: busy?.reason };
}

/** True once a `clock.resetStatus` answer says the world is back. */
export function resetFinished(answer: unknown): boolean {
  const parsed = ResetStatus.safeParse(answer);
  return parsed.success && parsed.data.status === "READY";
}

export function isWorldResetting(error: Pick<ApiError, "reason">): boolean {
  return error.reason === WORLD_RESETTING_REASON;
}
