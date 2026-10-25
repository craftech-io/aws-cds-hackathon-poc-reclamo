// The simulated-time bar of the shell (docs/design-brief.md §9) over `clock.get`: the hour, the
// mode and the three jumps, disabled with the reason while the world is busy or for a read-only
// role. No bar when the clock does not answer (a view never breaks for it). It reads the clock again
// whenever a view announces a move (lib/clock-events.ts).
import type { StaffRole } from "@reclamo/shared";
import { useCallback, useEffect } from "react";
import { useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { dataOf, useAction, useRemote } from "../../lib/use-remote";
import { onClockMoved } from "../../lib/clock-events";
import { clockViewOf } from "../../lib/world-clock";
import { ClockBanner } from "../ClockBanner";

const HOUR_MINUTES = 60;

type Jump = "next" | "hour" | "businessDay";

export function ShellClock({ role }: { readonly role: StaffRole }) {
  const { trpc } = useSession();
  const remote = useRemote<unknown>("clock.get", (signal) => trpc.clock.get.query(undefined, { signal }));
  const { reload } = remote;
  // A view that moved the clock (a case's milestone, the clock page, the tour) announces it.
  useEffect(() => onClockMoved(reload), [reload]);
  const jump = useAction<Jump, unknown>((kind) => {
    if (kind === "next") return trpc.clock.advanceToNext.mutate({});
    if (kind === "hour") return trpc.clock.advance.mutate({ minutes: HOUR_MINUTES });
    return trpc.clock.advanceBusinessDay.mutate();
  });
  const { run: runJump } = jump;
  const run = useCallback((kind: Jump) => void runJump(kind).then(reload), [runJump, reload]);

  const view = clockViewOf(dataOf(remote.state));
  if (!view) return null;
  const blocked = role === "COMPLIANCE" ? copy.shell.readOnlyClock : jump.state.status === "running" ? copy.app.loading : view.busyReason;
  return (
    <ClockBanner
      simNowText={view.simNowText}
      mode={view.mode}
      rate={view.rate}
      {...(blocked !== undefined ? { busyReason: blocked } : {})}
      onAdvanceToNext={() => run("next")}
      onAdvanceHour={() => run("hour")}
      onAdvanceBusinessDay={() => run("businessDay")}
    />
  );
}
