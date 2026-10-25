// Faults of a world's networks (docs/architecture-integrations.md §6.1, `Networks/…FAULTS`):
//
//   ERROR_503     every world route answers 503 UNAVAILABLE
//   LATE_PUBLISH  the first publication of a batch is deferred `minutes` later (DEFERRED)
//   MISSING_LINE  the published file omits one line of the batch
//
// They exist for QA worlds, plus one exception the templates use: the late-batch persona of a
// template carries a fault scoped to its one batch. So outside QA worlds a fault applies only when it
// names its network AND business date, and `ERROR_503` never does.
import { CalendarDate, CollectionNetwork, OperationCode } from "@reclamo/core-contract";
import { worldKindOf } from "@reclamo/shared";
import { z } from "zod";

export const Fault = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ERROR_503") }).strict(),
  z
    .object({
      kind: z.literal("LATE_PUBLISH"),
      network: CollectionNetwork,
      businessDate: CalendarDate.optional(),
      minutes: z.number().int().min(1).max(2_880),
    })
    .strict(),
  z
    .object({
      kind: z.literal("MISSING_LINE"),
      network: CollectionNetwork,
      businessDate: CalendarDate.optional(),
      /** The line to omit; without it, the first line of a collection (never another payer's). */
      operationCode: OperationCode.optional(),
    })
    .strict(),
]);
export type Fault = z.infer<typeof Fault>;

export type LatePublishFault = Extract<Fault, { kind: "LATE_PUBLISH" }>;
export type MissingLineFault = Extract<Fault, { kind: "MISSING_LINE" }>;

function honoured(worldId: string, fault: Fault): boolean {
  if (worldKindOf(worldId) === "QA") return true;
  return fault.kind !== "ERROR_503" && fault.businessDate !== undefined;
}

/** The faults of a world that actually apply to it. */
export function activeFaults(worldId: string, faults: readonly Fault[]): Fault[] {
  return faults.filter((fault) => honoured(worldId, fault));
}

export function failsWith503(worldId: string, faults: readonly Fault[]): boolean {
  return activeFaults(worldId, faults).some((fault) => fault.kind === "ERROR_503");
}

function forBatch<T extends LatePublishFault | MissingLineFault>(fault: T, network: CollectionNetwork, businessDate: string): boolean {
  return fault.network === network && (fault.businessDate === undefined || fault.businessDate === businessDate);
}

/** Minutes a batch's first publication is deferred, or 0. */
export function lateMinutes(worldId: string, faults: readonly Fault[], network: CollectionNetwork, businessDate: string): number {
  const late = activeFaults(worldId, faults).filter((fault): fault is LatePublishFault => fault.kind === "LATE_PUBLISH" && forBatch(fault, network, businessDate));
  return late.reduce((total, fault) => Math.max(total, fault.minutes), 0);
}

/** The `MISSING_LINE` faults of one batch. */
export function missingLineFaults(worldId: string, faults: readonly Fault[], network: CollectionNetwork, businessDate: string): MissingLineFault[] {
  return activeFaults(worldId, faults).filter((fault): fault is MissingLineFault => fault.kind === "MISSING_LINE" && forBatch(fault, network, businessDate));
}
