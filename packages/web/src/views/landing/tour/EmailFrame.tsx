// Step 4 of the tour: the written answer as the email viewer shows it (from, to, subject and the fixed
// parts of copy/es-AR.ts), its delivery state from SES, and the first page of the attached PDF with the
// register hashes printed on it: the most concrete compliance proof of the tour.
import type { ReactNode } from "react";
import { Badge } from "../../../components/Badge";
import { useLandingCopy } from "../lang";
import { ANSWER_EMAIL, ANSWER_PDF } from "./demo-data";
import { Gloss } from "./gloss";

function Header({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-14 shrink-0 text-slate">{label}</span>
      <span className="min-w-0 text-ink">{children}</span>
    </div>
  );
}

export function EmailFrame() {
  const { visuals } = useLandingCopy();
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <article className="min-w-0 flex-1 rounded-card border border-mist bg-white">
        <header className="space-y-1 border-b border-mist px-3 py-2">
          <Header label={visuals.from}>
            {ANSWER_EMAIL.from.es}
            <Gloss text={ANSWER_EMAIL.from} />
          </Header>
          <Header label={visuals.to}>{ANSWER_EMAIL.to}</Header>
          <Header label={visuals.subject}>
            <strong className="font-semibold">{ANSWER_EMAIL.subject.es}</strong>
            <Gloss text={ANSWER_EMAIL.subject} />
          </Header>
        </header>
        <div className="space-y-2 px-3 py-3 text-sm text-ink">
          <p>{ANSWER_EMAIL.greeting.es}</p>
          <p>
            {ANSWER_EMAIL.intro.es}
            <Gloss text={ANSWER_EMAIL.intro} />
          </p>
          <p>
            {ANSWER_EMAIL.attachments.es}
            <Gloss text={ANSWER_EMAIL.attachments} />
          </p>
          <p className="text-xs text-slate">{ANSWER_EMAIL.footer.es}</p>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-mist px-3 py-2">
          <span className="truncate text-xs text-slate">
            {visuals.attachment}: <span className="font-mono">{ANSWER_EMAIL.pdfName}</span>
          </span>
          <span className="flex items-center gap-1">
            <Badge tone="success">{visuals.delivered}</Badge>
            <span className="text-xs text-slate">{visuals.deliveryProof}</span>
          </span>
        </footer>
      </article>
      <figure aria-label={ANSWER_PDF.title} className="w-40 shrink-0 self-end rounded-sm border border-mist bg-white p-2 shadow-card sm:w-36 sm:self-start">
        <p className="text-xs leading-tight text-slate">{ANSWER_PDF.letterhead}</p>
        <p className="mt-2 font-display text-sm font-semibold text-pine">{ANSWER_PDF.title}</p>
        <div aria-hidden="true" className="mt-2 space-y-1">
          <span className="block h-1 w-full rounded bg-mist" />
          <span className="block h-1 w-5/6 rounded bg-mist" />
          <span className="block h-1 w-2/3 rounded bg-mist" />
        </div>
        <p className="mt-3 text-xs font-semibold text-slate">{ANSWER_PDF.hashesLabel}</p>
        {ANSWER_PDF.hashes.map((hash) => (
          <p key={hash} className="font-mono text-xs text-seal-deep">
            {hash}
          </p>
        ))}
        <p className="mt-2 text-xs text-slate">{ANSWER_PDF.legend}</p>
      </figure>
    </div>
  );
}
