// Métricas (docs/design-brief.md §11; docs/architecture.md §12; FL-098): one tab per source, never
// two sources in one number. "Este mundo (medido)" counts only complaints presented live in the
// principal's world, with the seeded history in its own box; "Lote · agente real" is the batch run
// with the real agent (raw and weighted); "Carga simulada (agente guionado)" shows only the mechanics.
// Every KPI with its N, source and label; the tab exports as CSV. Read-only for every role.
import { CONSOLE_ES } from "@reclamo/bff/copy/es-AR";
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";
import { type KeyboardEvent, useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { useAction, useRemote } from "../../lib/use-remote";
import { saveText } from "../emails/download";
import { Assumptions } from "./Assumptions";
import { KpiCards, SeededHistory } from "./KpiCards";
import { metricsCopy } from "./copy";
import { type KpiSummary, type KpiTab, TABS, costPerComplaint, perTypeText } from "./metrics-model";

const TAB_KEYS = { WORLD: "HEADING_THIS_WORLD", BATCH: "HEADING_REAL_BATCH", SIMULATED_LOAD: "HEADING_SIMULATED_LOAD" } as const;

function tabTitle(tab: KpiTab): string {
  return `${CONSOLE_ES[TAB_KEYS[tab]]} · ${CONSOLE_EN[TAB_KEYS[tab]]}`;
}

function Tabs({ value, onChange }: { readonly value: KpiTab; readonly onChange: (tab: KpiTab) => void }) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    if (next !== undefined) {
      onChange(next);
      document.getElementById(`metrics-tab-${next}`)?.focus();
    }
  };
  return (
    <div role="tablist" aria-label={metricsCopy.tabs.label} className="flex flex-wrap gap-1 border-b border-mist">
      {TABS.map((tab, index) => {
        const selected = tab === value;
        return (
          <button
            key={tab}
            id={`metrics-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="metrics-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab)}
            onKeyDown={(event) => move(event, index)}
            className={`-mb-px rounded-t-md border px-4 py-2 text-sm font-medium ${selected ? "border-mist border-b-white bg-white text-pine" : "border-transparent text-slate hover:text-pine"}`}
          >
            {tabTitle(tab)}
          </button>
        );
      })}
    </div>
  );
}

function TabNote({ summary }: { readonly summary: KpiSummary }) {
  if (summary.tab === "WORLD") {
    return <p className="text-sm text-slate">{summary.n === 0 ? metricsCopy.world.empty : metricsCopy.world.note}</p>;
  }
  if (summary.kpis.length === 0) return <Callout tone="neutral">{summary.tab === "BATCH" ? metricsCopy.batch.none : metricsCopy.load.none}</Callout>;
  return <p className="text-sm text-slate">{summary.tab === "BATCH" ? metricsCopy.batch.note(summary.n, perTypeText(summary.perType)) : metricsCopy.load.note(summary.n)}</p>;
}

function ExportButton({ tab }: { readonly tab: KpiTab }) {
  const { trpc } = useSession();
  const action = useAction<void, void>(async () => {
    const file = await trpc.metrics.export.query({ tab });
    saveText(file.csv, file.contentType, file.filename);
  });
  return (
    <span className="flex flex-col items-end gap-2">
      <Button variant="secondary" onClick={() => void action.run()} disabled={action.state.status === "running"}>
        {action.state.status === "running" ? metricsCopy.export.running : metricsCopy.export.button}
      </Button>
      {action.state.status === "error" ? <ApiErrorNotice error={action.state.error} /> : null}
    </span>
  );
}

export function MetricsView() {
  const { trpc } = useSession();
  const view = consoleCopy.views.metrics;
  const [tab, setTab] = useState<KpiTab>("WORLD");
  const summary = useRemote(`metrics.summary:${tab}`, (signal) => trpc.metrics.summary.query({ tab }, { signal }));

  return (
    <div className="space-y-6">
      <PageHeader title={view.title} description={view.description} actions={<ExportButton key={tab} tab={tab} />} />
      <Tabs value={tab} onChange={setTab} />
      <div id="metrics-panel" role="tabpanel" aria-labelledby={`metrics-tab-${tab}`} className="space-y-6">
        <RemoteBlock state={summary.state} onRetry={summary.reload}>
          {(data) => (
            <div className="space-y-6">
              <TabNote summary={data} />
              {data.kpis.length > 0 ? <KpiCards summary={data} /> : null}
              {data.seededHistory !== undefined ? <SeededHistory box={data.seededHistory} /> : null}
              <Section id="metrics-assumptions" title={metricsCopy.assumptions.title}>
                <Assumptions key={data.tab} costPerComplaint={costPerComplaint(data)} />
              </Section>
            </div>
          )}
        </RemoteBlock>
      </div>
    </div>
  );
}
