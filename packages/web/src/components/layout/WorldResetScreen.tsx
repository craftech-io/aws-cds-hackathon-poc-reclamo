// The fixed screen of a world being reset (docs/architecture.md §10): every procedure but
// `clock.resetStatus` answers `WORLD_RESETTING`, so the shell stops rendering views and asks
// `clock.resetStatus` every 3 s until `READY`; then the views mount again and load their data.
import { useEffect, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { RESET_POLL_MS, ResetStatus, resetFinished } from "../../lib/world-clock";
import { FullScreenMessage } from "../FullScreenMessage";

export function WorldResetScreen() {
  const { trpc, worldReady } = useSession();
  const [phase, setPhase] = useState<string | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const answer: unknown = await trpc.clock.resetStatus.query();
        if (stopped) return;
        if (resetFinished(answer)) {
          worldReady();
          return;
        }
        const parsed = ResetStatus.safeParse(answer);
        setPhase(parsed.success ? parsed.data.phase : undefined);
      } catch {
        // A failed poll (network, a deploy in progress) just waits for the next one.
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), RESET_POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), RESET_POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [trpc, worldReady]);

  return (
    <FullScreenMessage title={copy.shell.resettingTitle} lead={copy.shell.resettingLead}>
      <p role="status" aria-live="polite" className="text-sm text-slate">
        {phase ? `${copy.shell.resettingPhase}: ${phase}` : copy.app.loading}
      </p>
    </FullScreenMessage>
  );
}
