// The safety net of a `PENDING_BATCH` (docs/tool-catalog.md `reconcile_payment`, FL-017): one
// `SETTLEMENT_RECHECK` timer per complaint and batch, owned by `BATCH#<network>#<businessDate>`. The
// publication of that batch fires it at once (`firedBy PUBLICATION`, timers/routes.ts); if the network
// publishes late, the timer itself fires two simulated hours after the announced publication. Created
// with a conditional put on a derived id, so asking twice leaves one timer. While the world's clock
// runs, the milestone scheduler of complaints/ (when wired) creates its Scheduler schedule.
import type { ComplaintsDeps } from "../../complaints/deps";
import { isConflict } from "../../connector/errors";
import type { Complaint } from "../../domain/complaint";
import type { Logger } from "../../lib/log";

/** How long after the announced publication the recheck fires if the publication did not fire it. */
export const RECHECK_AFTER_PUBLISH_MS = 2 * 60 * 60 * 1000;

export interface PendingBatch {
  readonly network: "NORTE" | "SUR";
  readonly businessDate: string;
  readonly publishAtSim: string;
}

export function recheckTimerId(complaintId: string, batch: Pick<PendingBatch, "network" | "businessDate">): string {
  return `${complaintId}-RECHECK-${batch.network}-${batch.businessDate}`;
}

export function batchOwnerKey(batch: Pick<PendingBatch, "network" | "businessDate">): string {
  return `BATCH#${batch.network}#${batch.businessDate}`;
}

/** Creates the complaint's recheck of `batch` unless it exists; answers its id and whether it is new. */
export async function ensureRecheckTimer(deps: Pick<ComplaintsDeps, "connector" | "milestones">, complaint: Complaint, batch: PendingBatch, log: Logger): Promise<{ timerId: string; created: boolean }> {
  const timerId = recheckTimerId(complaint.complaintId, batch);
  const dueAtSim = new Date(Date.parse(batch.publishAtSim) + RECHECK_AFTER_PUBLISH_MS).toISOString();
  try {
    await deps.connector.timers.put({
      worldId: complaint.worldId,
      kind: "SETTLEMENT_RECHECK",
      timerId,
      dueAtSim,
      seq: 0,
      status: "SCHEDULED",
      epoch: complaint.epoch,
      ownerKey: batchOwnerKey(batch),
      payload: { complaintId: complaint.complaintId, customerId: complaint.customerId },
    });
  } catch (error) {
    if (isConflict(error)) return { timerId, created: false };
    throw error;
  }
  try {
    await deps.milestones?.schedule(complaint.worldId, [{ kind: "SETTLEMENT_RECHECK", timerId }]);
  } catch (error) {
    // The timer exists and the clock (or the publication) still fires it: a lost schedule only delays it.
    log.warn("tool.recheck_schedule_failed", { timerId, error });
  }
  return { timerId, created: true };
}
