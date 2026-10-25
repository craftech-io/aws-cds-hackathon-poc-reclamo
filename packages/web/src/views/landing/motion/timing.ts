// Timing of the landing's motion (docs/landing-spec.md §4), as pure functions of the elapsed time so
// they are tested without a browser: the self-typing WhatsApp bubble, the counters of the impact
// section and the hero's short loop. Nothing here reads a clock; the hooks pass the elapsed time.

/** ~35 ms per character, never more than 1.4 s in total: a longer text types faster. */
export const TYPE_MS_PER_CHAR = 35;
export const TYPE_MAX_MS = 1_400;

export function typingStepMs(length: number): number {
  if (length <= 0) return 0;
  return Math.min(TYPE_MS_PER_CHAR, TYPE_MAX_MS / length);
}

/** How many characters of a `length`-character text are visible `elapsedMs` after typing starts. */
export function typedLength(length: number, elapsedMs: number): number {
  const step = typingStepMs(length);
  if (step === 0) return length;
  return Math.max(0, Math.min(length, Math.floor(elapsedMs / step)));
}

export const COUNT_UP_MS = 800;

/** Ease-out cubic: fast at first, settling on the value. */
export function easeOut(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return 1 - (1 - clamped) ** 3;
}

/** The counter's whole value `elapsedMs` after it starts; exactly `target` from `durationMs` on. */
export function countUpValue(target: number, elapsedMs: number, durationMs: number = COUNT_UP_MS): number {
  if (elapsedMs >= durationMs) return target;
  return Math.round(target * easeOut(elapsedMs / durationMs));
}

/** The hero shows the outcome in a ~4 s loop: the message, then the number, then the blocked attempt. */
export const HERO_LOOP_MS = 4_000;
export const HERO_STAGES = 3;
const HERO_STAGE_AT = [0, 900, 1_900] as const;

/** Stage 1 (message) to 3 (blocked attempt on the tape) at `elapsedMs` into the loop. */
export function heroStage(elapsedMs: number): number {
  const into = ((elapsedMs % HERO_LOOP_MS) + HERO_LOOP_MS) % HERO_LOOP_MS;
  return HERO_STAGE_AT.filter((at) => into >= at).length;
}
