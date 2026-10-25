// `Metrics/W#<w>#METRICS`: one KPI row per source, run and complaint (docs/architecture.md §12), and
// `Reference`: the read-only documents of the stage (holidays, product terms, fee schedule, templates,
// lexicons, rate card), each parsed with the schema its consumer owns.
import type { z } from "zod";
import { ComplaintKpi, type MetricSource } from "../../domain/metrics";
import { type NewOf, type RepoContext, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { keys } from "../keys";

export function metricsRepo(ctx: RepoContext) {
  return {
    /** Upserts the KPI row of a complaint (a later measurement of the same run replaces it). */
    async put(kpi: NewOf<typeof ComplaintKpi>): Promise<void> {
      const value = validInput(ComplaintKpi, kpi, "Metrics");
      const item = encode(value, { entity: "ComplaintKpi", key: keys.metric(value.worldId, value.source, value.runId, value.complaintId), worldId: value.worldId, retention: "metrics", now: ctx.now() });
      await ctx.store.write({ kind: "put", table: "Metrics", item });
    },
    /** A world's KPI rows, of one source (and run) when given. */
    async list(worldId: string, filter: { source?: MetricSource; runId?: string } = {}): Promise<ComplaintKpi[]> {
      const prefix = filter.source ? `${filter.source}#${filter.runId ? `${filter.runId}#` : ""}` : undefined;
      const items = await queryAll(ctx.store, { table: "Metrics", partition: keys.metricsPartition(worldId), ...(prefix ? { sort: { op: "beginsWith" as const, value: prefix } } : {}) }, 5_000);
      return items.map((item) => decode(ComplaintKpi, item, "Metrics"));
    },
  };
}

export function referenceRepo(ctx: RepoContext) {
  return {
    /** One reference record (`REF#<type>#<scope>` / key), parsed with the caller's schema. */
    async get<T>(schema: z.ZodType<T>, type: string, scope: string, key: string): Promise<T | undefined> {
      return decodeOptional(schema, await ctx.store.get("Reference", keys.reference(type, scope, key)), "Reference");
    },
    /** Every record of a type and scope, in key order. */
    async list<T>(schema: z.ZodType<T>, type: string, scope: string): Promise<T[]> {
      const items = await queryAll(ctx.store, { table: "Reference", partition: keys.referencePartition(type, scope) }, 5_000);
      return items.map((item) => decode(schema, item, "Reference"));
    },
  };
}

export type MetricsRepo = ReturnType<typeof metricsRepo>;
export type ReferenceRepo = ReturnType<typeof referenceRepo>;
