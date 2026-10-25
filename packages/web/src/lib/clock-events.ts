// What a view announces after it moved the world's clock (a case's milestone, the clock page, the
// guided tour), so the shell's time bar (components/layout/ShellClock.tsx) reads the clock again. A
// browser event, not a state library: the views and the shell share nothing else.
const CLOCK_MOVED_EVENT = "reclamo:clock-moved";

export function announceClockMoved(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CLOCK_MOVED_EVENT));
}

/** Calls `listener` on every move a view announces; returns the unsubscribe. */
export function onClockMoved(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CLOCK_MOVED_EVENT, listener);
  return () => window.removeEventListener(CLOCK_MOVED_EVENT, listener);
}
