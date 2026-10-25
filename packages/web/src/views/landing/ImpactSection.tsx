// "Impacto" (#impacto, docs/landing-spec.md §2.7): the four targets, each card with the word "meta"
// visible and a link to how they are measured. Time to number and the share solved without a person
// count up when the section enters the viewport; 0 and 100 % stay fixed. The "medido · lote de 30"
// block appears only once the manifest carries a real batch run (WP-46/WP-49), never mixed with a target.
import { useRef } from "react";
import { GOAL_KEYS, countsUp, goalText, type GoalKey } from "./goals";
import { useLandingCopy } from "./lang";
import type { Measured } from "./manifest";
import { useCountUp, useInView, useReducedMotion } from "./motion/hooks";
import { SectionHeading, revealDelay } from "./SectionHeading";

function GoalCard({ goalKey, index, start }: { readonly goalKey: GoalKey; readonly index: number; readonly start: boolean }) {
  const { impact } = useLandingCopy();
  const goal = impact.goals[goalKey];
  const reduced = useReducedMotion();
  const animated = countsUp(goal);
  const value = useCountUp(goal.value, start && animated, reduced || !animated);
  return (
    <li data-reveal="" data-goal={goalKey} style={revealDelay(index)} className="flex flex-col rounded-card border border-mist bg-white p-5 shadow-card">
      <span className="self-start rounded-full bg-brass-soft px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-pine">{impact.target}</span>
      <p className="mt-3 font-display text-4xl font-semibold tabular-nums text-pine">
        <span aria-hidden="true">{goalText(goal, value)}</span>
        <span className="sr-only">{goalText(goal)}</span>
      </p>
      <h3 className="mt-2 text-sm font-semibold text-ink">{goal.label}</h3>
      <p className="mt-1 text-xs text-slate">{goal.detail}</p>
      <a href="#metodologia" className="mt-auto inline-flex min-h-11 items-center pt-2 text-xs font-semibold text-seal-deep underline-offset-4 hover:underline">
        {impact.howWeMeasure}
      </a>
    </li>
  );
}

function MeasuredBlock({ measured }: { readonly measured: Measured }) {
  const { impact } = useLandingCopy();
  return (
    <section aria-labelledby="medido-title" className="mt-8 rounded-card border border-success/40 bg-success-soft/40 p-5">
      <h3 id="medido-title" className="text-base font-semibold text-pine">
        {impact.measuredTitle}
      </h3>
      <p className="mt-1 text-xs text-slate">{impact.measuredNote(measured.n, measured.ranOn)}</p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {GOAL_KEYS.map((key) => (
          <div key={key}>
            <dt className="text-xs text-slate">
              {impact.goals[key].label} · <span className="font-semibold text-success">{impact.measured}</span>
            </dt>
            <dd className="font-display text-2xl font-semibold tabular-nums text-pine">{measured.figures[key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ImpactSection({ measured }: { readonly measured: Measured | null }) {
  const { impact } = useLandingCopy();
  const grid = useRef<HTMLOListElement>(null);
  const seen = useInView(grid, { threshold: 0.3, once: true });
  return (
    <section id="impacto" aria-labelledby="impacto-title" className="scroll-mt-20 bg-paper">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="impacto-title" eyebrow={impact.eyebrow} title={impact.title} lead={impact.lead} />
        <ol ref={grid} className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {GOAL_KEYS.map((key, index) => (
            <GoalCard key={key} goalKey={key} index={index} start={seen} />
          ))}
        </ol>
        {measured ? <MeasuredBlock measured={measured} /> : null}
        <div id="metodologia" className="mt-8 scroll-mt-24 rounded-card border border-mist bg-white p-5">
          <h3 className="text-base font-semibold text-pine">{impact.methodology.title}</h3>
          <p className="mt-2 max-w-3xl text-sm text-slate">{impact.methodology.text}</p>
        </div>
      </div>
    </section>
  );
}
