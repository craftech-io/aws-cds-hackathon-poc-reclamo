// The landing's text sections (docs/landing-spec.md §2.3, §2.5 and §2.6): the problem with its three
// pains and the "nuestra lectura" label, what it solves for each of the three roles, and the six rules
// the code guarantees. Cards reveal with a short stagger; everything is readable without motion.
import { RuleChip } from "../../components/RuleChip";
import { useLandingCopy } from "./lang";
import { SectionHeading, revealDelay } from "./SectionHeading";

const CARD = "rounded-card border border-mist bg-white p-5 shadow-card transition-transform duration-150 ease-out hover:-translate-y-0.5";

export function ProblemSection() {
  const { problem } = useLandingCopy();
  return (
    <section id="problema" aria-labelledby="problema-title" className="scroll-mt-20 bg-paper">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading
          id="problema-title"
          eyebrow={problem.eyebrow}
          title={problem.title}
          lead={
            <>
              <p>{problem.lead}</p>
              <p className="mt-2 text-xs text-slate">{problem.legalNote}</p>
            </>
          }
        />
        <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {problem.pains.map((pain, index) => (
            <li key={pain.title} data-reveal="" style={revealDelay(index)} className={CARD}>
              <span aria-hidden="true" className="font-display text-3xl font-semibold text-seal">
                {index + 1}
              </span>
              <h3 className="mt-2 text-base font-semibold text-pine">{pain.title}</h3>
              <p className="mt-2 text-sm text-slate">{pain.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function ActorsSection() {
  const { actors } = useLandingCopy();
  return (
    <section id="que-hace" aria-labelledby="que-hace-title" className="scroll-mt-20 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="que-hace-title" eyebrow={actors.eyebrow} title={actors.title} />
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {actors.groups.map((group, index) => (
            <article key={group.title} data-reveal="" style={revealDelay(index)} className={`${CARD} bg-paper`}>
              <h3 className="font-display text-xl font-semibold text-pine">{group.title}</h3>
              <ul className="mt-4 space-y-3">
                {group.items.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-ink">
                    <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-seal" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The rule each guarantee is enforced by, where one id names it (the channel policy's collection rule). */
const RULE_ID: Readonly<Record<number, string>> = { 1: "CH-WA-NO-COLLECTION" };

export function RulesSection() {
  const { rules } = useLandingCopy();
  return (
    <section id="reglas" aria-labelledby="reglas-title" className="scroll-mt-20 bg-pine text-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="reglas-title" eyebrow={rules.eyebrow} title={rules.title} lead={rules.lead} tone="dark" />
        <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {rules.items.map((rule, index) => {
            const ruleId = RULE_ID[index];
            return (
              <li key={rule.title} data-reveal="" style={revealDelay(index)} className="rounded-card border border-pine-soft bg-pine-deep/60 p-5">
                <h3 className="text-base font-semibold text-white">{rule.title}</h3>
                <p className="mt-2 text-sm text-mist">{rule.text}</p>
                {ruleId ? (
                  <p className="mt-3">
                    <RuleChip ruleId={ruleId} />
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
