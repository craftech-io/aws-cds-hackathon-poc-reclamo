// The phone of the WhatsApp renders (hero, tour steps 1 and 2): a generic chat skin in the theme's
// colours, never a third party's logo or brand green, with the fixed "WhatsApp (simulado)" label on the
// frame itself so no visitor mistakes the simulator for a live channel (docs/landing-spec.md §6).
import type { Glossed } from "@reclamo/bff/copy/types";
import type { ReactNode } from "react";
import { SIMULATOR_LABEL } from "./demo-data";
import { Gloss, useInlineGloss } from "./gloss";

export function PhoneFrame({ title, children, className = "" }: { readonly title: string; readonly children: ReactNode; readonly className?: string }) {
  const label = useInlineGloss()(SIMULATOR_LABEL);
  return (
    <div className={`mx-auto w-full max-w-xs rounded-4xl border-8 border-pine-deep bg-pine-deep shadow-card ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-1 rounded-t-3xl bg-pine px-4 py-2 text-white">
        <span className="text-sm font-semibold">{title}</span>
        <span className="max-w-full rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">{label}</span>
      </div>
      <div className="flex min-h-64 flex-col gap-2 rounded-b-3xl bg-paper px-3 py-4">{children}</div>
    </div>
  );
}

type BubbleSide = "customer" | "system";

const SIDE: Readonly<Record<BubbleSide, string>> = {
  customer: "self-end rounded-br-sm bg-success-soft",
  system: "self-start rounded-bl-sm bg-white",
};

/** One chat bubble. `shown` cuts the text while it types itself; the full text stays for assistive technology. */
export function ChatBubble({ side, text, shown, children }: { readonly side: BubbleSide; readonly text: Glossed; readonly shown?: number; readonly children?: ReactNode }) {
  const typing = shown !== undefined && shown < text.es.length;
  return (
    <div className={`max-w-5/6 rounded-2xl border border-mist px-3 py-2 text-sm text-ink shadow-card ${SIDE[side]}`}>
      {/* The whole text holds the bubble's size while the typed part is drawn over it: nothing moves. */}
      <p className="relative whitespace-pre-line">
        <span className={typing ? "invisible" : undefined}>{text.es}</span>
        {typing ? (
          <>
            <span aria-hidden="true" className="absolute inset-0">
              {text.es.slice(0, shown)}
              <span className="ml-0.5 inline-block h-4 w-px translate-y-0.5 bg-ink" />
            </span>
            <span className="sr-only">{text.es}</span>
          </>
        ) : null}
      </p>
      <Gloss text={text} />
      {children}
    </div>
  );
}

/** The reply buttons under a system bubble ("Sí, a ese email" · "Hablar con alguien"). */
export function ChatButtons({ buttons }: { readonly buttons: readonly Glossed[] }) {
  const label = useInlineGloss();
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-mist pt-2">
      {buttons.map((button) => (
        <span key={button.es} className="rounded-md bg-paper px-2 py-1 text-center text-xs font-semibold text-pine">
          {label(button)}
        </span>
      ))}
    </div>
  );
}
