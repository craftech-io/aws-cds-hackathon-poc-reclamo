// The visual of one tour step: its real console capture from the pipeline (scripts/landing/), labelled
// as a capture of the real console with synthetic data (the section "Qué es simulado" says the captures'
// agent replies were scripted), and, for a step whose capture does not exist yet (or, like the metrics,
// waits for a measured batch), a render with the console's real components and copy over synthetic data
// labelled "Vista con componentes reales · datos sintéticos" (docs/landing-spec.md §7).
import { useRef } from "react";
import { MediaFigure } from "../MediaFigure";
import { useLandingCopy, useLandingLang } from "../lang";
import { captureOf, galleryItemOf, type MediaState } from "../media";
import { useInView, useReducedMotion, useTypewriter } from "../motion/hooks";
import { ConsoleFrame, ComplaintNumberCard } from "./ConsoleFrame";
import { ACK_BUTTONS, ACK_MESSAGE, CUSTOMER_MESSAGE, DISCLOSURE } from "./demo-data";
import { EmailFrame } from "./EmailFrame";
import { EvidenceCard } from "./EvidenceCard";
import { MetricsVisual } from "./MetricsVisual";
import { ChatBubble, ChatButtons, PhoneFrame } from "./PhoneFrame";
import { RegisterVisual } from "./RegisterVisual";
import { TapeVisual } from "./TapeVisual";
import type { TourStep } from "./tour-steps";

const LENDER = "Jarilla";
/** The panel's width from 1024 px (7 of 12 columns of the content); a phone's width below. */
const TOUR_SIZES = "(min-width: 1024px) 620px, 320px";

/** Step 1: Valeria's message types itself once, the first time it enters the viewport. */
function TypingConversation() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const seen = useInView(ref, { threshold: 0.4, once: true });
  const shown = useTypewriter(CUSTOMER_MESSAGE.es, seen, reduced);
  return (
    <div ref={ref}>
      <PhoneFrame title={LENDER}>
        <ChatBubble side="customer" text={CUSTOMER_MESSAGE} shown={shown} />
      </PhoneFrame>
    </div>
  );
}

const SYSTEM_REPLY = { es: `${DISCLOSURE.es}\n\n${ACK_MESSAGE.es}`, en: `${DISCLOSURE.en}\n\n${ACK_MESSAGE.en}` };

/** Step 2: the acknowledgement the gate sends before the agent steps in, and the number on record. */
function Acknowledgement() {
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-end">
      <PhoneFrame title={LENDER} className="sm:mx-0">
        <ChatBubble side="customer" text={CUSTOMER_MESSAGE} />
        <ChatBubble side="system" text={SYSTEM_REPLY}>
          <ChatButtons buttons={ACK_BUTTONS} />
        </ChatBubble>
      </PhoneFrame>
      <ComplaintNumberCard className="w-full max-w-xs" />
    </div>
  );
}

function StepRender({ step }: { readonly step: TourStep }) {
  switch (step.id) {
    case "whatsapp":
      return <TypingConversation />;
    case "ack":
      return <Acknowledgement />;
    case "evidence":
      return <EvidenceCard />;
    case "email":
      return <EmailFrame />;
    case "gate":
      return <TapeVisual />;
    case "register":
      return <RegisterVisual />;
    case "metrics":
      return <MetricsVisual />;
  }
}

export function TourVisual({ step, media }: { readonly step: TourStep; readonly media: MediaState }) {
  const { tour } = useLandingCopy();
  const lang = useLandingLang()?.lang ?? "es";
  const capture = captureOf(media, step.mediaId);
  if (capture) return <MediaFigure item={galleryItemOf(step.mediaId, capture, lang)} sizes={TOUR_SIZES} caption={tour.captureNote} className="min-w-0" />;
  return (
    <figure data-render={step.mediaId} className="min-w-0">
      {step.view ? (
        <ConsoleFrame title={step.view}>
          <StepRender step={step} />
        </ConsoleFrame>
      ) : (
        <StepRender step={step} />
      )}
      <figcaption className="mt-2 text-center text-xs text-slate">{tour.renderNote}</figcaption>
    </figure>
  );
}
