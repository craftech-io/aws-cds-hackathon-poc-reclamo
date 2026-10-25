// Rules of the world-not-ready screen without React (docs/landing-spec.md §9.4, docs/architecture-guests.md
// §4-§6; FL-117, FL-120, FL-124, FL-125): the answer of `guest.status` and `guest.requestWorld`
// parsed at the edge, which text each status gets, how often to ask again, and when the wait is
// "longer than expected": 600 real seconds from the first wait out of the queue (the confirmation, or
// `CREATING` after a turn in line). The screen never promises an email: the guest's address only
// gets Cognito's mails (ADR-0020).
import { z } from "zod";

export const GuestStatus = z.object({
  worldStatus: z.string().min(1),
  queuePosition: z.number().int().nonnegative(),
  readyAtReal: z.string().optional(),
  expiresAtReal: z.string().optional(),
  usage: z.object({ turnsToday: z.number().int().nonnegative(), turnsPerDay: z.number().int().nonnegative(), limitReached: z.boolean() }).optional(),
});
export type GuestStatus = z.infer<typeof GuestStatus>;

export const RequestWorldResult = z.object({ status: z.enum(["REGISTERED", "ALREADY_ACTIVE", "RATE_LIMITED"]) });

/** Ask again this often while the world is being prepared… */
export const WAITING_POLL_MS = 5_000;
/** …and this often once it is open (the day's usage, and an expiry that happens meanwhile). */
export const READY_POLL_MS = 60_000;
/** Provisional threshold of "taking longer than expected" (FL-120), never above the 600 s budget of a world. */
export const SLOW_AFTER_MS = 600_000;

export type Phase =
  | { readonly kind: "ready" }
  | { readonly kind: "preparing" }
  | { readonly kind: "queued"; readonly position: number }
  | { readonly kind: "creating" }
  | { readonly kind: "expired" };

/** `READY` opens the console; a reset in progress is the console's own screen (WorldResetScreen). */
export function phaseOf(status: GuestStatus): Phase {
  switch (status.worldStatus) {
    case "READY":
    case "RESETTING":
      return { kind: "ready" };
    case "EXPIRING":
    case "EXPIRED":
      return { kind: "expired" };
    case "CREATING":
      return { kind: "creating" };
    default:
      return status.queuePosition > 0 ? { kind: "queued", position: status.queuePosition } : { kind: "preparing" };
  }
}

export function pollDelay(status: GuestStatus | undefined): number {
  return status !== undefined && phaseOf(status).kind === "ready" ? READY_POLL_MS : WAITING_POLL_MS;
}

/** When the current wait out of the queue started (`since`), and whether the guest was in line before. */
export interface WaitClock {
  readonly since?: number;
  readonly queued: boolean;
}

export const IDLE_WAIT: WaitClock = { queued: false };

export function nextWait(clock: WaitClock, phase: Phase, now: number): WaitClock {
  switch (phase.kind) {
    case "queued":
      return { queued: true };
    case "preparing":
      return clock.since === undefined ? { since: now, queued: clock.queued } : clock;
    case "creating":
      return clock.queued || clock.since === undefined ? { since: now, queued: false } : clock;
    case "ready":
    case "expired":
      return IDLE_WAIT;
  }
}

export function isSlow(clock: WaitClock, now: number): boolean {
  return clock.since !== undefined && now - clock.since >= SLOW_AFTER_MS;
}
