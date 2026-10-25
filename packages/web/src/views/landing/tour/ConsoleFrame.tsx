// Frames of the console renders (docs/landing-spec.md §6): a plain window with a mist title bar and
// three decorative dots, no browser chrome; and the card of a complaint number as the console and the
// acknowledgement show it, with its regulatory clock.
import type { Glossed } from "@reclamo/bff/copy/types";
import type { ReactNode } from "react";
import { SlaChip } from "../../../components/SlaChip";
import { BUSINESS_DAYS_LEFT, COMPLAINT_NUMBER, COMPLAINT_TYPE_TEXT, DEADLINE_TEXT, SLA_GLOSS } from "./demo-data";
import { Gloss, useInlineGloss } from "./gloss";

export function ConsoleFrame({ title, children, className = "" }: { readonly title: Glossed; readonly children: ReactNode; readonly className?: string }) {
  const label = useInlineGloss();
  return (
    <div className={`w-full overflow-hidden rounded-card border border-mist bg-white shadow-card ${className}`}>
      <div className="flex items-center gap-2 border-b border-mist bg-mist/60 px-3 py-2">
        <span aria-hidden="true" className="flex gap-1">
          <span className="h-2 w-2 rounded-full bg-seal/50" />
          <span className="h-2 w-2 rounded-full bg-brass/60" />
          <span className="h-2 w-2 rounded-full bg-success/50" />
        </span>
        <span className="truncate text-xs font-semibold text-pine">{label(title)}</span>
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </div>
  );
}

/** The complaint number on record, with its type, its deadline and the SLA chip of the console. */
export function ComplaintNumberCard({ className = "" }: { readonly className?: string }) {
  return (
    <div className={`rounded-card border border-seal/30 bg-white p-3 shadow-card ${className}`}>
      <p className="font-mono text-lg font-semibold tracking-tight text-seal-deep">{COMPLAINT_NUMBER}</p>
      <p className="text-xs text-slate">
        {COMPLAINT_TYPE_TEXT.es} · {DEADLINE_TEXT.es}
        <Gloss text={{ es: "", en: `${COMPLAINT_TYPE_TEXT.en} · ${DEADLINE_TEXT.en}` }} />
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <SlaChip state="ON_TIME" businessDaysLeft={BUSINESS_DAYS_LEFT} />
        <Gloss className="mt-0" text={{ es: "", en: SLA_GLOSS }} />
      </div>
    </div>
  );
}
