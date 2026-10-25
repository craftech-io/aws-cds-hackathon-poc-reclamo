// The simulated-time bar of the shell (docs/design-brief.md §9): "Hora simulada · mié 07/10 10:15 ·
// reloj en pausa", with "Avanzar al próximo evento", "+1 h" and "+1 día hábil", disabled with the
// reason while the world is busy (a turn in flight, an event in the queue, an email waiting for its
// terminal SES event). Presentational: the clock view and the shell pass the state and the actions.
import type { ClockMode } from "@reclamo/shared";
import { Button } from "./Button";

export interface ClockBannerProps {
  /** Simulated "now", already formatted for es-AR ("mié 07/10 10:15"). */
  readonly simNowText: string;
  readonly mode: ClockMode;
  /** Simulated seconds per real second while RUNNING. */
  readonly rate?: number;
  /** Why the actions are disabled now; undefined when the world is idle. */
  readonly busyReason?: string;
  readonly onAdvanceToNext: () => void;
  readonly onAdvanceHour: () => void;
  readonly onAdvanceBusinessDay: () => void;
}

export const CLOCK_TEXT = {
  label: "Hora simulada · Simulated time",
  paused: "reloj en pausa",
  running: (rate: number) => `reloj en vivo ×${rate}`,
  next: "Avanzar al próximo evento · Next event",
  hour: "+1 h",
  businessDay: "+1 día hábil",
} as const;

export function ClockBanner({ simNowText, mode, rate = 1, busyReason, onAdvanceToNext, onAdvanceHour, onAdvanceBusinessDay }: ClockBannerProps) {
  const busy = busyReason !== undefined;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-mist bg-brass-soft px-6 py-2 text-sm text-ink">
      <span className="font-semibold text-brass">{CLOCK_TEXT.label}</span>
      <span className="tabular-nums">{simNowText}</span>
      <span className="text-slate">{mode === "PAUSED" ? CLOCK_TEXT.paused : CLOCK_TEXT.running(rate)}</span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {busy ? <span className="text-xs text-slate">{busyReason}</span> : null}
        <Button variant="secondary" disabled={busy} onClick={onAdvanceToNext}>
          {CLOCK_TEXT.next}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onAdvanceHour}>
          {CLOCK_TEXT.hour}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onAdvanceBusinessDay}>
          {CLOCK_TEXT.businessDay}
        </Button>
      </span>
    </div>
  );
}
