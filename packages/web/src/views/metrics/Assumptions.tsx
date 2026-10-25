// "Reclamos por mes" and "costo de un contacto manual" (docs/design-brief.md §11): parameters a
// prospect edits to size a month of operation next to the cost per complaint of the tab. Both are
// assumptions, labelled as such, start empty (nothing invented) and live only in this view's state.
import { useId, useState } from "react";
import { Badge } from "../../components/Badge";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { metricsCopy } from "./copy";
import { assumptionOf, usdText } from "./metrics-model";

export function Assumptions({ costPerComplaint }: { readonly costPerComplaint: number | undefined }) {
  const a = metricsCopy.assumptions;
  const ticketsId = useId();
  const manualId = useId();
  const [tickets, setTickets] = useState("");
  const [manual, setManual] = useState("");
  const perMonth = assumptionOf(tickets);
  const manualCost = assumptionOf(manual);
  const outcome =
    costPerComplaint === undefined ? a.needsCost : perMonth === undefined || manualCost === undefined ? a.fill : undefined;
  return (
    <section aria-label={a.title} className="space-y-3">
      <p className="text-sm text-slate">{a.lead}</p>
      <div className="flex flex-wrap gap-4">
        <label htmlFor={ticketsId} className={LABEL_CLASS}>
          {a.tickets}
          <input id={ticketsId} inputMode="numeric" className={FIELD_CLASS} value={tickets} onChange={(event) => setTickets(event.target.value)} />
        </label>
        <label htmlFor={manualId} className={LABEL_CLASS}>
          {a.manualCost}
          <input id={manualId} inputMode="decimal" className={FIELD_CLASS} value={manual} onChange={(event) => setManual(event.target.value)} />
        </label>
      </div>
      {outcome !== undefined || costPerComplaint === undefined || perMonth === undefined || manualCost === undefined ? (
        <p className="text-sm text-slate">{outcome}</p>
      ) : (
        <ul role="status" className="flex flex-wrap items-center gap-3 text-sm text-ink">
          <li>{a.agent(usdText(costPerComplaint * perMonth, 2))}</li>
          <li>{a.manual(usdText(manualCost * perMonth, 2))}</li>
          <li>
            <Badge tone="warning">{a.label}</Badge>
          </li>
        </ul>
      )}
    </section>
  );
}
