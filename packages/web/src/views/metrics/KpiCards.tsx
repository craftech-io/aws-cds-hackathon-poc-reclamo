// The KPIs of one tab: each one with its figure, N, source and label, and the lines of its detail
// (FL-098: `{value, n, source, label}`, never two sources in one number); plus the "historia sembrada
// (no medida)" box of the world tab, counts only, never a performance rate.
import { capitalize } from "@reclamo/bff/copy/helpers";
import { COMPLAINT_STATUS_LABEL, COMPLAINT_TYPE_LABEL, CONSOLE_ES } from "@reclamo/bff/copy/es-AR";
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";
import { Badge, type BadgeTone } from "../../components/Badge";
import { metricsCopy } from "./copy";
import { type Kpi, type KpiSummary, detailLines, sourceText, valueText } from "./metrics-model";

const LABEL_TONE: Readonly<Record<Kpi["label"], BadgeTone>> = { MEASURED: "success", SCRIPTED_AGENT: "info", ASSUMPTION: "warning", NOT_APPLICABLE_SCRIPTED: "neutral" };

function KpiCard({ kpi }: { readonly kpi: Kpi }) {
  const c = metricsCopy.card;
  const lines = detailLines(kpi);
  const tone = kpi.key === "policyViolations" && kpi.value !== null ? (kpi.value === 0 ? "text-success" : "text-danger") : "text-pine";
  return (
    <li data-kpi={kpi.key} className="flex flex-col gap-2 rounded-md border border-mist bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate">{metricsCopy.kpis[kpi.key]}</p>{" "}
      <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{valueText(kpi)}</p>{" "}
      <p className="flex flex-wrap items-center gap-2 text-xs text-slate">
        <Badge tone={LABEL_TONE[kpi.label]}>{metricsCopy.labels[kpi.label]}</Badge>
        <span>
          {c.n} = <span className="tabular-nums">{kpi.n}</span>
        </span>
        <span>
          · {c.source}: {sourceText(kpi.source)}
        </span>
      </p>
      {lines.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-slate">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function KpiCards({ summary }: { readonly summary: KpiSummary }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {summary.kpis.map((kpi) => (
        <KpiCard key={kpi.key} kpi={kpi} />
      ))}
    </ul>
  );
}

function Counts({ label, counts, names }: { readonly label: string; readonly counts: Readonly<Record<string, number>>; readonly names: Readonly<Record<string, string>> }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</p>
      <ul className="mt-1 space-y-0.5 text-sm">
        {rows.map(([key, count]) => (
          <li key={key} className="flex justify-between gap-3">
            <span className="text-ink">{capitalize(names[key] ?? key)}</span>
            <span className="tabular-nums text-ink">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SeededHistory({ box }: { readonly box: NonNullable<KpiSummary["seededHistory"]> }) {
  const w = metricsCopy.world;
  const figures: readonly (readonly [string, number])[] = [
    [w.total, box.total],
    [w.answered, box.answered],
    [w.onTime, box.answeredOnTime],
    [w.withProof, box.withDeliveryProof],
    [w.measured, box.measuredN],
  ];
  return (
    <section aria-label={CONSOLE_ES.HEADING_SEEDED_HISTORY} data-seeded-history className="space-y-3 rounded-card border border-dashed border-brass bg-brass-soft p-4">
      <div>
        <h3 className="text-base font-semibold text-pine">
          {CONSOLE_ES.HEADING_SEEDED_HISTORY} <span lang="en" className="text-sm font-normal text-slate">· {CONSOLE_EN.HEADING_SEEDED_HISTORY}</span>
        </h3>
        <p className="text-xs text-slate">{w.seededLead}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {figures.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-slate">{label}</dt>{" "}
            <dd className="text-lg font-semibold tabular-nums text-pine">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-4 md:grid-cols-2">
        <Counts label={w.byStatus} counts={box.byStatus} names={COMPLAINT_STATUS_LABEL} />
        <Counts label={w.byType} counts={box.byType} names={COMPLAINT_TYPE_LABEL} />
      </div>
    </section>
  );
}
