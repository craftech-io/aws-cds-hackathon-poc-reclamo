// One step of the guided tour: its number and title, its buttons in order (a `run` button goes through
// `tour.run`; an `open` button takes the guest to the view where the step happens), "Qué mirar" with the
// world's own dates and numbers, and its time budget. Only the current step's buttons are live; the
// ones that move the clock wait for a quiet world.
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { TOUR_TEXTS } from "./copy";
import { type TourLang, type TourStep, formatBudget, lookText } from "./steps";
import { type TourProgress, moveKey } from "./tour-model";

export type StepState = "current" | "done" | "upcoming";

interface StepCardProps {
  readonly step: TourStep;
  readonly lang: TourLang;
  readonly state: StepState;
  readonly progress: TourProgress;
  readonly values: Readonly<Record<string, string | undefined>>;
  /** Why the world cannot take a clock move now, in the panel's language; undefined when it is quiet. */
  readonly busyReason: string | undefined;
  /** Index of the move running now. */
  readonly running: number | undefined;
  readonly onMove: (index: number) => void;
  readonly onMarkDone: () => void;
}

const FRAME: Readonly<Record<StepState, string>> = {
  current: "border-seal bg-white shadow-card",
  done: "border-mist bg-paper",
  upcoming: "border-mist bg-white",
};

export function StepCard({ step, lang, state, progress, values, busyReason, running, onMove, onMarkDone }: StepCardProps) {
  const texts = TOUR_TEXTS[lang];
  const headingId = `tour-step-${step.id}`;
  const live = state === "current";
  return (
    <li aria-current={live ? "step" : undefined}>
      <article aria-labelledby={headingId} className={`rounded-card border p-4 ${FRAME[state]}`}>
        <header className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="text-base font-semibold text-pine">
            {texts.step(step.id)} · {step.title[lang]}
          </h3>
          {state === "current" ? <Badge tone="brand">{texts.now}</Badge> : null}
          {state === "done" ? <Badge tone="success">{texts.done}</Badge> : null}
          {step.optional ? <Badge>{texts.optional}</Badge> : null}
          <span className="ml-auto text-xs text-slate">
            {texts.budget}: {formatBudget(step.budgetSeconds, lang)}
          </span>
        </header>
        <ol className="mt-3 flex flex-wrap gap-2">
          {step.moves.map((move, index) => {
            const taken = progress.has(moveKey(step, index));
            const waits = move.kind === "run" && move.needsQuietWorld === true && busyReason !== undefined;
            return (
              <li key={move.label.es}>
                <Button variant={move.kind === "run" && !taken ? "primary" : "secondary"} disabled={!live || running !== undefined || waits} aria-describedby={waits ? `${headingId}-busy` : undefined} onClick={() => onMove(index)}>
                  {taken ? <span aria-hidden="true">✓</span> : null}
                  {move.label[lang]}
                  {taken ? <span className="sr-only"> ({texts.moveDone})</span> : null}
                </Button>
              </li>
            );
          })}
        </ol>
        {live && busyReason !== undefined && step.moves.some((move) => move.kind === "run" && move.needsQuietWorld === true) ? (
          <p id={`${headingId}-busy`} className="mt-2 text-xs text-warning">
            {texts.busy(busyReason)}
          </p>
        ) : null}
        <div className="mt-3 text-sm">
          <p className="text-xs font-semibold tracking-wide text-slate uppercase">{texts.look}</p>
          <p className="mt-1 text-ink">{lookText(step, lang, values)}</p>
        </div>
        {live ? (
          <div className="mt-3">
            <Button variant="ghost" disabled={running !== undefined} onClick={onMarkDone}>
              {texts.markDone}
            </Button>
          </div>
        ) : null}
      </article>
    </li>
  );
}
