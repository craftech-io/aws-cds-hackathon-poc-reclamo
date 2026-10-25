// The worker's deterministic reconciliation in the stage (docs/architecture.md §7 "Obligaciones",
// `SETTLEMENT_PUBLISHED`): the same service `reconcile_payment` runs below its fences (reconcile/service.ts),
// on the complaint's `READ` receipt reading, as `SYSTEM`. It leaves its own `SETTLEMENT_MATCH` evidence;
// what follows a `PENDING_BATCH` is the code's too: the complaint waits (`INVESTIGATING → AWAITING_SETTLEMENT`)
// and the batch's `SETTLEMENT_RECHECK` timer exists once (agent-tools/investigation/recheck.ts). The
// handoffs of a mismatch are the obligations' (worker/obligations.ts).
import { ToolError } from "@reclamo/shared";
import { ensureRecheckTimer } from "../../agent-tools/investigation/recheck";
import type { ComplaintsDeps } from "../../complaints/deps";
import { transition } from "../../complaints/state-machine";
import type { Connector } from "../../connector/port";
import type { CoreClient } from "../../core/client";
import type { NetworkClient } from "../../networks/client";
import type { SettlementFileReader } from "../../networks/settlement-files";
import { reconcilePayment } from "../../reconcile/service";
import type { ReconcileOutcome, ReconcileRequest, WorkerContext } from "../ports";

export interface StageReconcileDeps {
  readonly data: Connector;
  readonly core: () => CoreClient;
  readonly networks: () => NetworkClient;
  readonly settlementFiles: () => SettlementFileReader;
  readonly complaints: () => ComplaintsDeps;
}

/** The reading id a `RECEIPT_READING` evidence carries as its `refId` (reconcile/service.ts looks it up by it). */
async function readingIdOf(data: Connector, request: ReconcileRequest): Promise<string> {
  const reading = await data.caseItems.getEvidence(request.worldId, request.complaint.complaintId, request.readingEvidenceId);
  if (reading === undefined || reading.kind !== "RECEIPT_READING" || reading.refId === undefined) throw new ToolError("EVIDENCE_REQUIRED", "the complaint's reading is gone or has no reading id");
  return reading.refId;
}

export function stageReconcile(deps: StageReconcileDeps) {
  return async (request: ReconcileRequest, ctx: WorkerContext): Promise<ReconcileOutcome> => {
    const { complaint } = request;
    const response = await reconcilePayment(
      { connector: deps.data, core: deps.core(), network: deps.networks(), readFile: deps.settlementFiles(), now: ctx.now, log: ctx.log },
      {
        worldId: request.worldId,
        epoch: complaint.epoch,
        complaintId: complaint.complaintId,
        customerId: request.customerId,
        source: "SETTLEMENT",
        readingId: await readingIdOf(deps.data, request),
        simNow: new Date(request.atSim),
        actor: "SYSTEM",
        correlationId: ctx.log.correlationId,
      },
    );
    if (response.decision.result === "PENDING_BATCH") {
      await ensureRecheckTimer(deps.complaints(), complaint, response.decision.pending, ctx.log);
      if (complaint.status === "INVESTIGATING") {
        await transition(deps.complaints(), { worldId: request.worldId, complaintId: complaint.complaintId, to: "AWAITING_SETTLEMENT", cause: "RECONCILED_BY_CODE", actor: "SYSTEM", atSim: request.atSim });
      }
    }
    return { result: response.result, evidenceId: response.evidenceId };
  };
}
