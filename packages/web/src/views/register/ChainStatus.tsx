// The status of one hash chain (register, refunds or tape) as `register.verify` and every export
// return it: the headline ("Verificada" · "Parcial: N entradas sin ancla" · "Rota en seq N") with
// its English gloss, and the figures behind it. It never says more than the verification proves: an
// entry without an anchor is shown unverified (ADR-0014).
import type { ReactNode } from "react";
import { registerCopy } from "./copy";
import { type Verification, seqList, shortHash, verificationHeadline } from "./register-model";

const TONES = {
  success: "border-success bg-success-soft text-success",
  warning: "border-warning bg-warning-soft text-warning",
  danger: "border-danger bg-danger-soft text-danger",
} as const;

type ChainSummary = Pick<Verification, "result" | "brokenAt" | "unanchored" | "anchorConflicts" | "entries" | "headHash" | "foreignAnchors" | "epoch">;

function Figure({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

export function ChainStatus({ verification, title = registerCopy.status.heading }: { readonly verification: ChainSummary; readonly title?: string }) {
  const headline = verificationHeadline(verification);
  const copy = registerCopy.status;
  return (
    <section aria-label={title} className="space-y-3">
      <div role="status" data-chain-result={verification.result} className={`rounded-card border px-4 py-3 ${TONES[headline.tone]}`}>
        <p className="text-xs font-semibold uppercase tracking-wide">{title}</p>
        <p className="mt-1 text-lg font-semibold">{headline.text}</p>
        <p lang="en" className="text-xs text-ink">
          {headline.gloss}
        </p>
        {verification.result === "partial" ? <p className="mt-1 text-sm text-ink">{copy.unverifiedNote}</p> : null}
      </div>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Figure label={copy.epoch}>{verification.epoch}</Figure>
        <Figure label={copy.entries}>{verification.entries}</Figure>
        <Figure label={copy.headHash}>
          <code className="font-mono text-xs" title={verification.headHash ?? undefined}>
            {shortHash(verification.headHash)}
          </code>
        </Figure>
        <Figure label={copy.unanchored}>{seqList(verification.unanchored)}</Figure>
        <Figure label={copy.conflicts}>{seqList(verification.anchorConflicts)}</Figure>
        <Figure label={copy.foreign}>{verification.foreignAnchors}</Figure>
      </dl>
      <p className="text-xs text-slate">{copy.what}</p>
    </section>
  );
}
