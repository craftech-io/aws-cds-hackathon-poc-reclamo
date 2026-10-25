// The seven steps of the product tour (docs/landing-spec.md §3.1): the copy key of each one, the
// manifest entry whose real capture replaces its render (§7), and the console view the render frames,
// named as the console's navigation names it (packages/bff/src/copy, with its English gloss).
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";
import { CONSOLE_ES, type ConsoleKey } from "@reclamo/bff/copy/es-AR";
import type { Glossed } from "@reclamo/bff/copy/types";
import type { LandingCopy } from "../copy";

export type TourStepId = keyof LandingCopy["tour"]["steps"];

export interface TourStep {
  readonly id: TourStepId;
  /** The manifest entry (public/landing/manifest.json) of this step's visual. */
  readonly mediaId: string;
  /** The console view a console render is framed as; phone renders have none. */
  readonly view?: Glossed;
}

function view(key: ConsoleKey): Glossed {
  return { es: CONSOLE_ES[key], en: CONSOLE_EN[key] };
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: "whatsapp", mediaId: "tour-01-whatsapp" },
  { id: "ack", mediaId: "tour-02-ack" },
  { id: "evidence", mediaId: "tour-03-evidence", view: view("HEADING_EVIDENCE") },
  { id: "email", mediaId: "tour-04-email", view: view("NAV_EMAILS") },
  { id: "gate", mediaId: "tour-05-blocked", view: view("NAV_TAPE") },
  { id: "register", mediaId: "tour-06-register", view: view("NAV_REGISTER") },
  { id: "metrics", mediaId: "tour-07-metrics", view: view("NAV_METRICS") },
];

/** Steps whose visual is mounted on the desktop panel: the active one and its neighbours. */
export function mountedSteps(active: number, count: number = TOUR_STEPS.length): number[] {
  return [active - 1, active, active + 1].filter((index) => index >= 0 && index < count);
}
