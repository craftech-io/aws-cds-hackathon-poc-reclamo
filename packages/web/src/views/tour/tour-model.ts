// The guided tour's state, without React: which moves the guest already took (kept per world and epoch
// in sessionStorage, so a reset or another world starts over), the current step, "Tu recorrido: ~X min"
// from the budgets of what is left, the facts of "Qué mirar" read from the world, and where an `open`
// move goes. Pure functions; View.tsx and StepCard.tsx render them.
import { CONSOLE_PREFIX } from "../../routes";
import type { TourStepsAnswer } from "./tour-api";
import { TOUR_BLOCKS, type TourFact, type TourLang, type TourStep, type TourTarget } from "./steps";

/** `${stepId}#${moveIndex}` of every move taken, and `${stepId}#done` of a step marked as done. */
export type TourProgress = ReadonlySet<string>;

export const moveKey = (step: TourStep, index: number) => `${step.id}#${index}`;
const doneKey = (step: TourStep) => `${step.id}#done`;

export function progressKey(worldId: string, epoch: number): string {
  return `reclamo.tour.${worldId}.e${epoch}`;
}

/** The stored progress; empty when storage is blocked, missing or holds something else. */
export function loadProgress(storage: Pick<Storage, "getItem"> | undefined, key: string): TourProgress {
  try {
    const raw = storage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveProgress(storage: Pick<Storage, "setItem"> | undefined, key: string, progress: TourProgress): void {
  try {
    storage?.setItem(key, JSON.stringify([...progress]));
  } catch {
    // Storage is a convenience: without it the tour still works for this page view.
  }
}

export function withMove(progress: TourProgress, step: TourStep, index: number): TourProgress {
  return new Set([...progress, moveKey(step, index)]);
}

export function withStepDone(progress: TourProgress, step: TourStep): TourProgress {
  return new Set([...progress, doneKey(step)]);
}

export function stepComplete(step: TourStep, progress: TourProgress): boolean {
  return progress.has(doneKey(step)) || step.moves.every((_move, index) => progress.has(moveKey(step, index)));
}

/** The first step not complete (the optional ones count as complete once skipped by a later one). */
export function currentStep(steps: readonly TourStep[], progress: TourProgress): TourStep | undefined {
  return steps.find((step) => !stepComplete(step, progress));
}

/** Seconds of budget left in the block of the current step; the whole tour is done at 0. */
export function remainingSeconds(steps: readonly TourStep[], progress: TourProgress): { readonly block: TourStep["block"] | undefined; readonly seconds: number } {
  const current = currentStep(steps, progress);
  if (current === undefined) return { block: undefined, seconds: 0 };
  const seconds = steps.filter((step) => step.block === current.block && !stepComplete(step, progress)).reduce((sum, step) => sum + step.budgetSeconds, 0);
  return { block: current.block, seconds };
}

/** "~X min" of what is left: whole minutes rounded up, at least one while anything is left. */
export function remainingMinutes(seconds: number): number {
  return seconds <= 0 ? 0 : Math.max(1, Math.ceil(seconds / 60));
}

export function blockTitle(block: TourStep["block"], lang: TourLang): string {
  return TOUR_BLOCKS[block][lang];
}

/** What the world says about a fact of "Qué mirar"; undefined keeps the expected value. */
export function factValue(fact: TourFact, world: TourStepsAnswer | undefined): string | undefined {
  if (world === undefined) return undefined;
  const { source } = fact;
  switch (source.kind) {
    case "WORLD_START":
      return world.startAtSim;
    case "WORLD_NOW":
      return world.simNow;
    case "MAIN_STORY_NUMBER":
      return world.mainStory?.complaintNumber;
    case "MAIN_STORY_DEADLINE":
      return world.mainStory?.deadlineSim;
    case "TIMER":
      return world.nextEvents.find((event) => event.kind === source.timer && event.ownerKey === source.ownerKey)?.dueAtSim;
    case "EXPECTED":
      return undefined;
  }
}

export function factValues(step: TourStep, world: TourStepsAnswer | undefined): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(step.facts).map(([name, fact]) => [name, factValue(fact, world)]));
}

const VIEW_PATHS: Readonly<Record<Exclude<TourTarget["view"], "customer" | "complaint">, string>> = {
  simulator: `${CONSOLE_PREFIX}/simulator`,
  emails: `${CONSOLE_PREFIX}/emails`,
  metrics: `${CONSOLE_PREFIX}/metrics`,
  approvals: `${CONSOLE_PREFIX}/approvals`,
  register: `${CONSOLE_PREFIX}/register`,
  clock: `${CONSOLE_PREFIX}/clock`,
};

/** Where an `open` move takes the guest; a complaint needs its id, resolved by the panel first. */
export function targetPath(target: TourTarget, complaintId?: string): string | undefined {
  if (target.view === "customer") return `${CONSOLE_PREFIX}/customers/cus-${target.persona.slice(1).padStart(4, "0")}`;
  if (target.view === "complaint") return complaintId === undefined ? undefined : `${CONSOLE_PREFIX}/complaints/${encodeURIComponent(complaintId)}`;
  return VIEW_PATHS[target.view];
}
