// The blocks of the demo clock: the world's hour and mode, the jumps, the live clock with its bounded
// compression, the upcoming events with "Disparar ahora" and the reset of this world. Each block only
// renders and hands its command to View.tsx, which runs one at a time.
import { formatSimInstant } from "@reclamo/shared";
import { useId, useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { type Column, Table } from "../../components/Table";
import { FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { Link } from "../../lib/router";
import { CONSOLE_PREFIX } from "../../routes";
import type { ClockAnswer, ClockCommand, UpcomingTimer } from "./clock-api";
import { LIVE_RATE, MAX_RATE, MIN_RATE, SLOW_LIVE_RATE, describeRate, liveMinutesLeft, parseRate, timerLabel } from "./clock-model";
import { clockCopy } from "./copy";

export interface SectionProps {
  readonly clock: ClockAnswer;
  readonly blocked: boolean;
  readonly run: (command: ClockCommand) => void;
}

export function NowSection({ clock, nowMs }: { readonly clock: ClockAnswer; readonly nowMs: number }) {
  const copy = clockCopy.now;
  const running = clock.mode === "RUNNING";
  const left = running ? liveMinutesLeft(clock.runningUntilReal, nowMs) : undefined;
  return (
    <Section id="clock-now" title={copy.title}>
      <div className="flex flex-wrap items-center gap-4">
        <p className="font-display text-3xl text-pine tabular-nums">{formatSimInstant(clock.simNow)}</p>
        <Badge tone={running ? "warning" : "neutral"}>{running ? copy.running(clock.rate ?? LIVE_RATE) : copy.paused}</Badge>
      </div>
      {running ? (
        <p className="mt-2 text-sm text-slate">
          {copy.pace(describeRate(clock.rate ?? LIVE_RATE))}. {left === undefined ? null : left === 0 ? copy.liveEnding : copy.liveFor(left)}
        </p>
      ) : null}
    </Section>
  );
}

export function MoveSection({ blocked, run }: Omit<SectionProps, "clock">) {
  const copy = clockCopy.move;
  return (
    <Section id="clock-move" title={copy.title} description={copy.lead}>
      <div className="flex flex-wrap gap-2">
        <Button disabled={blocked} onClick={() => run({ kind: "next" })}>
          {copy.next}
        </Button>
        <Button variant="secondary" disabled={blocked} onClick={() => run({ kind: "hour" })}>
          {copy.hour}
        </Button>
        <Button variant="secondary" disabled={blocked} onClick={() => run({ kind: "businessDay" })}>
          {copy.businessDay}
        </Button>
      </div>
    </Section>
  );
}

export function LiveSection({ clock, blocked, run }: SectionProps) {
  const copy = clockCopy.live;
  const [text, setText] = useState(String(clock.rate ?? LIVE_RATE));
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const rate = parseRate(text);
  return (
    <Section id="clock-live" title={copy.title} description={copy.lead}>
      <div className="flex flex-wrap items-start gap-2">
        <Button disabled={blocked} onClick={() => run({ kind: "live", rate: LIVE_RATE })}>
          {copy.live}
        </Button>
        <Button variant="secondary" disabled={blocked} onClick={() => run({ kind: "live", rate: SLOW_LIVE_RATE })}>
          {copy.slow}
        </Button>
        {clock.mode === "RUNNING" ? (
          <Button variant="secondary" disabled={blocked} onClick={() => run({ kind: "pause" })}>
            {copy.pause}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-slate">
        {copy.live}: {copy.liveHint} · {copy.slow}: {copy.slowHint}
      </p>
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (rate !== undefined) run({ kind: "live", rate });
        }}
      >
        <label htmlFor={inputId} className={LABEL_CLASS}>
          {copy.custom}
          <input id={inputId} className={`${FIELD_CLASS} w-32`} inputMode="numeric" value={text} aria-describedby={hintId} aria-invalid={rate === undefined} onChange={(event) => setText(event.target.value)} />
        </label>
        <Button type="submit" variant="secondary" disabled={blocked || rate === undefined}>
          {copy.apply}
        </Button>
        <p id={hintId} className={`${HINT_CLASS} basis-full`}>
          {rate === undefined ? <span className="text-danger">{copy.customInvalid(MIN_RATE, MAX_RATE)}</span> : `${copy.customHint(MIN_RATE, MAX_RATE)} ${describeRate(rate)}.`}
        </p>
      </form>
    </Section>
  );
}

export function UpcomingSection({ clock, blocked, run }: SectionProps) {
  const copy = clockCopy.upcoming;
  const columns: readonly Column<UpcomingTimer>[] = [
    { id: "when", header: copy.when, cell: (timer) => <span className="tabular-nums">{formatSimInstant(timer.dueAtSim)}</span> },
    { id: "what", header: copy.what, cell: (timer) => timerLabel(timer) },
    {
      id: "complaint",
      header: copy.complaint,
      cell: (timer) =>
        timer.complaintId === null ? (
          "—"
        ) : (
          <Link to={`${CONSOLE_PREFIX}/complaints/${encodeURIComponent(timer.complaintId)}`} className="font-semibold text-seal-deep underline">
            {copy.openComplaint}
          </Link>
        ),
    },
    {
      id: "fire",
      header: <span className="sr-only">{copy.fire}</span>,
      align: "right",
      cell: (timer) => (
        <Button variant="ghost" disabled={blocked} aria-label={copy.fireLabel(timerLabel(timer))} onClick={() => run({ kind: "fire", timer })}>
          {copy.fire}
        </Button>
      ),
    },
  ];
  return (
    <Section id="clock-upcoming" title={copy.title} description={copy.lead}>
      <Table columns={columns} rows={clock.upcoming} keyOf={(timer) => `${timer.kind}#${timer.timerId}`} emptyTitle={copy.empty} variant="plain" />
    </Section>
  );
}

export function ResetSection({ blocked, run }: Omit<SectionProps, "clock">) {
  const copy = clockCopy.reset;
  const [confirming, setConfirming] = useState(false);
  return (
    <Section id="clock-reset" title={copy.title} description={copy.lead}>
      {confirming ? (
        <div role="group" aria-label={copy.title} className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-ink">{copy.confirmLead}</p>
          <Button
            variant="danger"
            disabled={blocked}
            onClick={() => {
              setConfirming(false);
              run({ kind: "reset" });
            }}
          >
            {copy.confirm}
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            {copy.cancel}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" disabled={blocked} onClick={() => setConfirming(true)}>
          {copy.ask}
        </Button>
      )}
    </Section>
  );
}
