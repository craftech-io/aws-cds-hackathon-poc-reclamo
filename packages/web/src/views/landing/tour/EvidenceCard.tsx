// Step 3 of the tour: what the reader took from Valeria's synthetic receipt next to the line of the
// settlement file the collection network published, field by field, with the console's `MoneyText`
// and `Badge`. The match is what lets the system apply the payment: a reading alone never does.
import type { ReactNode } from "react";
import { Badge } from "../../../components/Badge";
import { MoneyText } from "../../../components/MoneyText";
import { useLandingCopy } from "../lang";
import { EVIDENCE } from "./demo-data";

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-mist/70 py-1 last:border-b-0">
      <dt className="text-xs text-slate">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm text-ink">{children}</dd>
    </div>
  );
}

export function EvidenceCard() {
  const { visuals } = useLandingCopy();
  const { settlement } = EVIDENCE;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <section aria-label={visuals.receipt} className="rounded-card border border-dashed border-slate/40 bg-paper p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate">{visuals.receipt}</p>
        <p className="mt-1 text-xs font-semibold text-pine">{visuals.receiptRead}</p>
        <dl className="mt-2">
          <Field label={visuals.network}>{EVIDENCE.network}</Field>
          <Field label={visuals.paidAt}>{EVIDENCE.paidAt}</Field>
          <Field label={visuals.amount}>
            <MoneyText value={EVIDENCE.amount} />
          </Field>
          <Field label={visuals.code}>
            <code className="font-mono text-xs">{EVIDENCE.code}</code>
          </Field>
        </dl>
      </section>
      <section aria-label={visuals.settlementLine} className="rounded-card border border-success/40 bg-success-soft/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">{visuals.settlementLine}</p>
          <Badge tone="success">{visuals.match}</Badge>
        </div>
        <p className="mt-1 font-mono text-xs text-pine">{settlement.batch}</p>
        <dl className="mt-2">
          <Field label={visuals.customer}>{settlement.customer}</Field>
          <Field label={visuals.loan}>
            {settlement.loan} · {visuals.instalment}
          </Field>
          <Field label={visuals.amount}>
            <MoneyText value={settlement.amount} />
          </Field>
          <Field label={visuals.code}>
            <code className="font-mono text-xs">{settlement.code}</code>
          </Field>
        </dl>
      </section>
    </div>
  );
}
