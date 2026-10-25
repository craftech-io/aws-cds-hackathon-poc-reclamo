// `Metrics/W#<w>#METRICS` (docs/architecture.md §5, §12): one KPI row per complaint and source. A KPI
// labelled "measured" only counts `origin LIVE`; simulated load only shows its mechanics.
import { z } from "zod";
import { ComplaintOrigin, ComplaintType, IsoInstant, WorldId } from "@reclamo/shared";
import { Id, Stamps } from "./common";
import { DeliveryProof } from "./complaint";

export const MetricSource = z.enum(["WORLD", "BATCH", "SIMULATED_LOAD"]);
export type MetricSource = z.infer<typeof MetricSource>;

export const ComplaintKpi = z.object({
  worldId: WorldId,
  source: MetricSource,
  runId: Id,
  complaintId: Id,
  complaintType: ComplaintType.optional(),
  agentMode: z.enum(["REAL", "SCRIPTED"]),
  origin: ComplaintOrigin,
  ackLatencyMs: z.number().nonnegative().optional(),
  coldStart: z.boolean().optional(),
  resolvedWithoutHuman: z.boolean().optional(),
  answeredOnTime: z.boolean().optional(),
  deliveryProof: DeliveryProof.optional(),
  humanActions: z.array(z.string().min(1).max(60)).max(50),
  tokens: z.object({ in: z.number().int().nonnegative(), out: z.number().int().nonnegative(), cached: z.number().int().nonnegative() }),
  messages: z.object({ wa: z.number().int().nonnegative(), email: z.number().int().nonnegative() }),
  costUsd: z.number().nonnegative().optional(),
  rateCardVersion: z.string().max(40).optional(),
  atSim: IsoInstant.optional(),
  ...Stamps,
});
export type ComplaintKpi = z.infer<typeof ComplaintKpi>;
