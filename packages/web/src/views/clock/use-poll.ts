// Re-runs a view's query every `intervalMs` while the tab is visible (`null` stops it): the demo
// clock while the world is busy or running, the phone while the agent is writing, the tour while a
// move settles. A hidden tab polls nothing, so a forgotten console costs no reads.
import { useEffect, useState } from "react";

export function usePoll(reload: () => void, intervalMs: number | null): void {
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [reload, intervalMs]);
}

/** The real "now" in ms, refreshed every `intervalMs` (countdowns of real time, never a business rule). */
export function useNowMs(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
