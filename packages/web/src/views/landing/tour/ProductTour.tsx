// "Cómo funciona" (#recorrido, docs/landing-spec.md §3): one complaint from end to end in seven steps.
// From 1024 px it is scroll-driven: the steps' texts stack on the left and a sticky panel on the right
// shows the visual of the step whose centre crosses the viewport's centre, crossing from one visual to
// the next (index.css `.tour-visual`; a direct cut with reduced motion). Only the active visual and its
// neighbours are mounted. Below 1024 px each step carries its own visual, stacked, with a "1 de 7"
// chip; nothing is sticky. There is no "next" button: the visitor's scroll is the control.
import { useRef } from "react";
import { useLandingCopy } from "../lang";
import type { MediaState } from "../media";
import { useActiveStep, useMediaQuery } from "../motion/hooks";
import { SectionHeading } from "../SectionHeading";
import { TOUR_STEPS, mountedSteps, type TourStep } from "./tour-steps";
import { TourVisual } from "./TourVisual";

function StepNumber({ index, active }: { readonly index: number; readonly active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 font-display text-sm font-semibold transition-colors duration-150 ${active ? "border-seal bg-seal text-white" : "border-slate/40 text-slate"}`}
    >
      {index + 1}
    </span>
  );
}

function StepText({ step, index, active }: { readonly step: TourStep; readonly index: number; readonly active: boolean }) {
  const { tour } = useLandingCopy();
  const text = tour.steps[step.id];
  return (
    <div className="flex gap-4">
      <StepNumber index={index} active={active} />
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate">{tour.stepOf(index + 1, TOUR_STEPS.length)}</p>
        <h3 className={`mt-1 font-display text-xl font-semibold ${active ? "text-pine" : "text-pine/80"}`}>{text.title}</h3>
        <p className="mt-2 max-w-prose text-base text-slate">{text.text}</p>
      </div>
    </div>
  );
}

function StackedTour({ media }: { readonly media: MediaState }) {
  return (
    <ol className="mt-10 space-y-14">
      {TOUR_STEPS.map((step, index) => (
        <li key={step.id} id={`paso-${index + 1}`} data-reveal="" className="space-y-5">
          <TourVisual step={step} media={media} />
          <StepText step={step} index={index} active />
        </li>
      ))}
    </ol>
  );
}

function StickyTour({ media }: { readonly media: MediaState }) {
  const list = useRef<HTMLOListElement>(null);
  const active = useActiveStep(list, true);
  const mounted = new Set(mountedSteps(active));
  return (
    <div className="mt-12 grid grid-cols-12 gap-10">
      <ol ref={list} className="col-span-5">
        {TOUR_STEPS.map((step, index) => (
          <li key={step.id} id={`paso-${index + 1}`} data-step-index={index} aria-current={index === active ? "step" : undefined} className="flex min-h-tour-step items-start">
            <StepText step={step} index={index} active={index === active} />
          </li>
        ))}
      </ol>
      <div className="col-span-7">
        <div className="sticky top-24 grid">
          {TOUR_STEPS.map((step, index) =>
            mounted.has(index) ? (
              <div
                key={step.id}
                data-state={index === active ? "active" : index < active ? "before" : "after"}
                aria-hidden={index === active ? undefined : true}
                inert={index !== active}
                className="tour-visual col-start-1 row-start-1 self-start"
              >
                <TourVisual step={step} media={media} />
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

export function ProductTour({ media }: { readonly media: MediaState }) {
  const { tour } = useLandingCopy();
  const desktop = useMediaQuery("(min-width: 1024px)");
  return (
    <section id="recorrido" aria-labelledby="recorrido-title" className="scroll-mt-20 bg-pine-mist">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="recorrido-title" eyebrow={tour.eyebrow} title={tour.title} lead={tour.lead} />
        {desktop ? <StickyTour media={media} /> : <StackedTour media={media} />}
      </div>
    </section>
  );
}
