// Step 6 of the tour: the complaint register for R-2026-000123 after an export, with the console's
// `SlaChip` and `RuleChip`s: each entry chained and anchored outside the tables, the chain verified.
// Below 768 px the entries are cards (docs/landing-spec.md §3.2); from there, a five-column table.
import { COMPLAINT_STATUS_GLOSS } from "@reclamo/bff/copy/en-gloss";
import { COMPLAINT_STATUS_LABEL } from "@reclamo/bff/copy/es-AR";
import { Badge } from "../../../components/Badge";
import { RuleChips } from "../../../components/RuleChips";
import { SlaChip } from "../../../components/SlaChip";
import { useLandingCopy } from "../lang";
import { ANSWER_RULES, BUSINESS_DAYS_LEFT, COMPLAINT_NUMBER, REGISTER_ROWS, SLA_GLOSS } from "./demo-data";
import { Gloss, useInlineGloss } from "./gloss";

export function RegisterVisual() {
  const { visuals } = useLandingCopy();
  const label = useInlineGloss();
  const answered = { es: COMPLAINT_STATUS_LABEL.ANSWERED, en: COMPLAINT_STATUS_GLOSS.ANSWERED };
  const register = visuals.register;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold text-seal-deep">{COMPLAINT_NUMBER}</span>
        <Badge tone="success">{label(answered)}</Badge>
        <SlaChip state="ON_TIME" businessDaysLeft={BUSINESS_DAYS_LEFT} />
        <Gloss className="mt-0" text={{ es: "", en: SLA_GLOSS }} />
      </div>
      <ul className="space-y-2 md:hidden">
        {REGISTER_ROWS.map((row) => (
          <li key={row.seq} className="rounded-md border border-mist bg-white p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-ink">
                #{row.seq} · {row.event}
              </span>
              <Badge tone="success">{register.anchored}</Badge>
            </div>
            <p className="mt-1 font-mono text-slate">{row.hash}</p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-md border border-mist md:block">
        <table className="w-full text-left text-xs">
          <thead className="bg-paper uppercase tracking-wide text-slate">
            <tr>
              {register.heads.map((head) => (
                <th key={head} scope="col" className="px-3 py-2 font-semibold">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-mist">
            {REGISTER_ROWS.map((row) => (
              <tr key={row.seq}>
                <td className="px-3 py-2 tabular-nums text-slate">{row.seq}</td>
                <td className="px-3 py-2 font-mono text-ink">{row.number}</td>
                <td className="px-3 py-2 font-mono text-ink">{row.event}</td>
                <td className="px-3 py-2 font-mono text-slate">{row.hash}</td>
                <td className="px-3 py-2">
                  <Badge tone="success">{register.anchored}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-md border border-success/40 bg-success-soft/40 px-3 py-2">
        <p className="text-sm font-semibold text-success">✓ {register.chain}</p>
        <p className="mt-0.5 text-xs text-slate">{register.chainDetail}</p>
        <p className="mt-0.5 text-xs text-slate">{register.export}</p>
      </div>
      <div>
        <p className="text-xs text-slate">{visuals.rules}</p>
        <div className="mt-1">
          <RuleChips ids={ANSWER_RULES} />
        </div>
      </div>
    </div>
  );
}
