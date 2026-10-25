// `metrics` router (docs/tool-catalog.md "Procedimientos de la consola"; docs/design-brief.md §11;
// docs/architecture.md §12; FL-098): the KPIs of one tab, every one `{value, n, source, label}`, as
// metrics/load.ts computes them; this router only picks the world and the tab.
//
//   summary  "Este mundo" (medido: only `origin LIVE` complaints of the principal's world, plus the
//            "historia sembrada (no medida)" box), "Lote · agente real" (N = 30, raw and weighted) or
//            "Carga simulada" (agente guionado: only the mechanics, the rest n/a)
//   export   the same tab as CSV, every cell guarded against formulas (routers/csv.ts); the console
//            downloads it as a file
import { z } from "zod";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import { exportRows, metricsSummary } from "../metrics/load";
import { KpiTab } from "../metrics/types";
import { toCsv } from "./csv";
import type { ContextDeps } from "./deps";
import { accessProcedure } from "./roles";
import { router } from "./trpc";

export interface MetricsPorts {
  readonly connector: Connector;
}

declare module "./deps" {
  interface ContextDeps {
    /** `metrics.*` (routers/metrics.ts); the linked tables when absent. */
    readonly metricsPorts?: MetricsPorts;
  }
}

let stagePorts: MetricsPorts | undefined;

function metricsPortsOf(deps: ContextDeps): MetricsPorts {
  if (deps.metricsPorts) return deps.metricsPorts;
  stagePorts ??= { connector: dynamoConnector() };
  return stagePorts;
}

export const MetricsTabInput = z.object({ tab: KpiTab.optional() }).strict().optional();

export const METRICS_CSV_COLUMNS = ["tab", "key", "value", "n", "source", "label", "gap"] as const;

export const metricsRouter = router({
  summary: accessProcedure("metrics.summary")
    .input(MetricsTabInput)
    .query(({ ctx, input }) => metricsSummary(metricsPortsOf(ctx.deps).connector, { worldId: ctx.principal.worldId, epoch: ctx.world.epoch, tab: input?.tab ?? "WORLD" })),

  export: accessProcedure("metrics.export")
    .input(MetricsTabInput)
    .query(async ({ ctx, input }) => {
      const tab = input?.tab ?? "WORLD";
      const summary = await metricsSummary(metricsPortsOf(ctx.deps).connector, { worldId: ctx.principal.worldId, epoch: ctx.world.epoch, tab });
      const rows = exportRows(summary).map((row) => METRICS_CSV_COLUMNS.map((column) => row[column]));
      const stamp = ctx.deps.wallClock().toISOString().slice(0, 10);
      return { filename: `metrics-${tab.toLowerCase()}-${stamp}.csv`, contentType: "text/csv; charset=utf-8", csv: toCsv(METRICS_CSV_COLUMNS, rows) };
    }),
});
