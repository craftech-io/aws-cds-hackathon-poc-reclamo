// The hero (#inicio, docs/landing-spec.md §2.2): the value proposition in one line, for whom, the
// three calls to action ("Ver el recorrido" only when the video exists) and, as the visual, the outcome
// in a short loop while the hero is on screen: Valeria's message, the number on the spot and a
// collection attempt blocked on the tape. The self-typing story is told once, in the tour, not here.
import { type ReactNode, useRef } from "react";
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";
import { CONSOLE_ES } from "@reclamo/bff/copy/es-AR";
import { CTA_CLASS, SignInLink, TalkLink, TryLink } from "./cta";
import { useLandingCopy } from "./lang";
import { useHeroLoop, useInView, useReducedMotion } from "./motion/hooks";
import { ComplaintNumberCard } from "./tour/ConsoleFrame";
import { CUSTOMER_MESSAGE, TAPE_ENTRIES } from "./tour/demo-data";
import { useInlineGloss } from "./tour/gloss";
import { ChatBubble, PhoneFrame } from "./tour/PhoneFrame";
import { TapeCard } from "./tour/TapeVisual";

const BLOCKED = TAPE_ENTRIES.find((entry) => entry.decision === "BLOCKED");

function Stage({ shown, children }: { readonly shown: boolean; readonly children: ReactNode }) {
  return (
    <div data-on={shown ? "true" : "false"} className="hero-stage">
      {children}
    </div>
  );
}

function HeroVisual() {
  const { hero } = useLandingCopy();
  const label = useInlineGloss();
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const visible = useInView(ref, { threshold: 0.3 });
  const stage = useHeroLoop(visible, reduced);
  return (
    <figure ref={ref} aria-label={hero.visualLabel} className="relative mx-auto w-full max-w-sm space-y-3">
      <PhoneFrame title="Jarilla">
        <ChatBubble side="customer" text={CUSTOMER_MESSAGE} />
      </PhoneFrame>
      <Stage shown={stage >= 2}>
        <ComplaintNumberCard />
      </Stage>
      {BLOCKED ? (
        <Stage shown={stage >= 3}>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-seal-soft">{label({ es: CONSOLE_ES.NAV_TAPE, en: CONSOLE_EN.NAV_TAPE })}</p>
          <ul>
            <TapeCard entry={BLOCKED} />
          </ul>
        </Stage>
      ) : null}
    </figure>
  );
}

export function Hero({ hasVideo }: { readonly hasVideo: boolean }) {
  const { hero, cta } = useLandingCopy();
  return (
    <section id="inicio" aria-labelledby="inicio-title" className="relative scroll-mt-20 overflow-hidden bg-pine text-white">
      <span aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-pine-soft/60 blur-3xl" />
      <span aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-seal/10 blur-3xl" />
      <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-14 sm:px-8 md:grid-cols-12 md:items-center lg:py-24">
        <div className="md:col-span-7">
          <p className="text-sm font-semibold uppercase tracking-widest text-seal-soft">{hero.eyebrow}</p>
          <h1 id="inicio-title" className="mt-4 text-hero font-semibold leading-tight">
            {hero.title}
          </h1>
          <p className="mt-6 max-w-2xl text-base text-mist sm:text-lg">{hero.lead}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <TryLink arrow />
            <SignInLink className={CTA_CLASS.secondaryDark} />
            {hasVideo ? (
              <a href="#video" data-cta="watch" className={`${CTA_CLASS.link} text-white`}>
                {cta.watch}
              </a>
            ) : null}
            <TalkLink placement="hero" className={`${CTA_CLASS.link} text-white`} />
          </div>
          <p className="mt-6 inline-flex max-w-2xl items-start gap-2 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm text-white">
            <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-seal" />
            {hero.proof}
          </p>
          <p className="mt-4 max-w-2xl text-xs text-seal-soft">{hero.note}</p>
        </div>
        <div className="md:col-span-5">
          <HeroVisual />
        </div>
      </div>
      <span id="landing-top" aria-hidden="true" className="absolute left-0 top-0 h-6 w-px" />
    </section>
  );
}
