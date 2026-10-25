// Reloj de demo (`/app/clock`, docs/design-brief.md §6 and §9, ADR-0011, FL-082, FL-100): the
// simulated hour of the user's own world, its mode and compression, the jumps ("Avanzar al próximo
// evento", "+1 h", "+1 día hábil"), "Reloj en vivo" and its slow variant with a bounded rate, the
// upcoming events with "Disparar ahora", and "Reiniciar este mundo". Every move is refused while the
// world is busy (`WORLD_BUSY`, with what it waits for) until "Avanzar igual" is allowed. A reset only
// asks for it: the next answer of the BFF says `WORLD_RESETTING` and the shell shows "Estamos
// reiniciando tu mundo" until `clock.resetStatus` says `READY`.
import { formatSimInstant } from "@reclamo/shared";
import { useState } from "react";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { dataOf, useAction, useRemote } from "../../lib/use-remote";
import { type ClockAnswer, type ClockCommand, type ClockMoved, fetchClock, runClockCommand } from "./clock-api";
import { clockCopy } from "./copy";
import { BusyNotice, ClockRefusal } from "./parts";
import { LiveSection, MoveSection, NowSection, ResetSection, UpcomingSection } from "./Sections";
import { useNowMs, usePoll } from "./use-poll";

/** How often the clock is read while the world is busy or running. */
const POLL_MS = 3_000;

function outcomeText(command: ClockCommand, moved: ClockMoved | undefined): string | undefined {
  if (moved !== undefined) return clockCopy.move.moved(formatSimInstant(moved.fromSim), formatSimInstant(moved.simNow), moved.fired.length);
  if (command.kind === "live") return clockCopy.live.started(command.rate);
  if (command.kind === "pause") return clockCopy.live.paused;
  return undefined;
}

function Clock({ clock, reload }: { readonly clock: ClockAnswer; readonly reload: () => void }) {
  const { trpc } = useSession();
  const nowMs = useNowMs();
  const [done, setDone] = useState<string | undefined>(undefined);
  const action = useAction(async (command: ClockCommand) => {
    const moved = await runClockCommand(trpc, command);
    setDone(outcomeText(command, moved));
    return true;
  });
  const run = (command: ClockCommand) => {
    setDone(undefined);
    void action.run(command).then(reload);
  };
  const busy = clock.busy;
  const blocked = busy !== null || action.state.status === "running";
  const failure = action.state.status === "error" ? action.state.error : undefined;
  return (
    <div className="space-y-6">
      <NowSection clock={clock} nowMs={nowMs} />
      {busy === null ? null : <BusyNotice busy={busy} nowMs={nowMs} onForce={() => run({ kind: "next", force: true })} disabled={action.state.status === "running"} />}
      {failure ? <ClockRefusal error={failure} /> : done ? <Callout tone="success" title={done} /> : null}
      <MoveSection blocked={blocked} run={run} />
      <LiveSection clock={clock} blocked={blocked} run={run} />
      <UpcomingSection clock={clock} blocked={blocked} run={run} />
      <ResetSection blocked={action.state.status === "running"} run={run} />
    </div>
  );
}

export function ClockView() {
  const { trpc } = useSession();
  const remote = useRemote<ClockAnswer>("clock.get", (signal) => fetchClock(trpc, signal));
  const current = dataOf(remote.state);
  usePoll(remote.reload, current !== undefined && (current.busy !== null || current.mode === "RUNNING") ? POLL_MS : null);
  const view = consoleCopy.views.clock;
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <p className="mb-6 max-w-3xl text-sm text-slate">{clockCopy.lead}</p>
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(clock) => <Clock clock={clock} reload={remote.reload} />}
      </RemoteBlock>
    </div>
  );
}
