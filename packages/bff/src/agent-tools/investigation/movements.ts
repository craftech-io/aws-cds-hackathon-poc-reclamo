// `get_transfer_status` and `get_disbursement` (docs/tool-catalog.md, FL-041…FL-048): what the transfer
// network says about a transfer of the customer, and what the core says about the disbursement of a
// loan. Amount and direction come from the customer's own operation in the core; status, trace and
// dates from the network. A transfer the network does not know is `UNKNOWN`, never "found". Each call
// leaves a `TRANSFER_STATUS` or `DISBURSEMENT` evidence; a `REJECTED_NOT_REVERSED` one is what
// `request_transfer_reversal` needs (`LAM-EVIDENCE`). A disbursement `PENDING` within its term is a wait
// the code sets (FL-047): the complaint goes to `AWAITING_NETWORK` and a `FOLLOW_UP` an hour after the
// expected time checks it again; nothing else would ever look at it.
import { ToolError, ok } from "@reclamo/shared";
import type { ComplaintsDeps } from "../../complaints/deps";
import { transition } from "../../complaints/state-machine";
import type { Complaint } from "../../domain/complaint";
import type { Operation, TransferStatus } from "@reclamo/core-contract";
import { NetworkClientError } from "../../networks/errors";
import type { NetworkClient } from "../../networks/client";
import { type ToolContext, type ToolImplementation, actorOf } from "../common/context";
import type { ToolInput } from "../common/define";
import { type CorePort, coreContextOf } from "../account/core";
import { dayTimeText, localDate, money, shiftDate } from "../account/format";
import { OWNERSHIP_WINDOW_DAYS } from "../account/ownership";
import { scheduleFollowUp } from "../complaints/follow-up";
import { complaintOf, recordEvidence } from "./evidence";
import type { INVESTIGATION_TOOLS } from "./schema";

type Tools = typeof INVESTIGATION_TOOLS;

export type NetworksPort = () => Pick<NetworkClient, "getTransfer">;

/** The customer's operation of a transfer (the same window `LAM-SCOPE` checked it in). */
async function transferOperation(core: CorePort, ctx: ToolContext<unknown>, transferId: string): Promise<Operation | undefined> {
  const today = localDate(ctx.session.eventAtSim);
  const list = await core().call("listOperations", coreContextOf(ctx), { params: { customerId: ctx.session.customerId }, query: { from: shiftDate(today, -OWNERSHIP_WINDOW_DAYS), to: today, kind: "ALL" } });
  return list.operations.find((operation) => operation.ref.transferId === transferId);
}

/** The network's answer, `UNKNOWN` when it does not know the transfer; anything else it refuses is final. */
async function networkStatus(networks: NetworksPort, ctx: ToolContext<unknown>, transferId: string): Promise<TransferStatus> {
  try {
    return await networks().getTransfer({ worldId: ctx.session.worldId, simNow: ctx.session.eventAtSim, correlationId: ctx.correlationId }, transferId);
  } catch (error) {
    if (error instanceof NetworkClientError && error.code === "NOT_FOUND") return { transferId, status: "UNKNOWN" };
    ctx.log.warn("tool.network_unavailable", { code: error instanceof NetworkClientError ? error.code : "UNEXPECTED" });
    throw new ToolError("UNAVAILABLE", "the transfer network is not answering, try again later");
  }
}

/** How long after the expected time the follow-up looks again, so a credit at that very time is already seen. */
export const DISBURSEMENT_FOLLOW_UP_AFTER_MS = 60 * 60 * 1000;

/** Statuses a pending disbursement moves to `AWAITING_NETWORK` from (through `INVESTIGATING`); a person's case stays theirs. */
const WAITABLE: ReadonlySet<Complaint["status"]> = new Set(["REGISTERED", "INVESTIGATING", "AWAITING_CUSTOMER", "AWAITING_SETTLEMENT", "AWAITING_NETWORK"]);

/** `AWAITING_NETWORK` and the follow-up of a disbursement pending within its term; what the tool answers about it. */
async function awaitDisbursement(ctx: ToolContext<unknown>, deps: ComplaintsDeps, complaint: Complaint, expectedBySim: string): Promise<Record<string, string>> {
  if (!WAITABLE.has(complaint.status)) return {};
  const base = { worldId: ctx.session.worldId, complaintId: complaint.complaintId, actor: actorOf(ctx.principal), atSim: ctx.session.eventAtSim, cause: "DISBURSEMENT_PENDING" };
  let current = complaint;
  if (current.status !== "INVESTIGATING" && current.status !== "AWAITING_NETWORK") current = (await transition(deps, { ...base, complaint: current, to: "INVESTIGATING" })).complaint;
  if (current.status === "INVESTIGATING") current = (await transition(deps, { ...base, complaint: current, to: "AWAITING_NETWORK" })).complaint;
  const followUpAtSim = await scheduleFollowUp(ctx, current, new Date(Date.parse(expectedBySim) + DISBURSEMENT_FOLLOW_UP_AFTER_MS).toISOString(), deps.milestones);
  return { complaintStatus: current.status, followUpAtText: dayTimeText(followUpAtSim) };
}

const textOf = (instant: string | undefined, name: string) => (instant === undefined ? {} : { [name]: dayTimeText(instant) });

export function movementTools(core: CorePort, networks: NetworksPort, complaints: () => ComplaintsDeps) {
  const getTransferStatus: ToolImplementation<ToolInput<Tools["get_transfer_status"]>> = async (ctx) => {
    const complaint = complaintOf(ctx);
    const { transferId } = ctx.input;
    const [operation, status] = await Promise.all([transferOperation(core, ctx, transferId), networkStatus(networks, ctx, transferId)]);
    if (operation === undefined) throw new ToolError("FORBIDDEN", "transferId is not a transfer of this customer");
    const recorded = await recordEvidence(
      ctx,
      "TRANSFER_STATUS",
      {
        transferId,
        status: status.status,
        amount: operation.amount,
        direction: operation.direction,
        operationId: operation.operationId,
        ...(status.traceId === undefined ? {} : { traceId: status.traceId }),
        ...(status.completedAtSim === undefined ? {} : { completedAtSim: status.completedAtSim }),
        ...(status.expectedBySim === undefined ? {} : { expectedBySim: status.expectedBySim }),
        ...(status.reversedAtSim === undefined ? {} : { reversedAtSim: status.reversedAtSim }),
      },
      complaint,
    );
    await ctx.audit({ outcome: status.status, refs: { transferId, evidenceId: recorded.evidenceId } });
    return ok({
      evidenceId: recorded.evidenceId,
      transferId,
      status: status.status,
      ...(status.traceId === undefined ? {} : { traceId: status.traceId }),
      ...textOf(status.completedAtSim, "completedAtText"),
      ...textOf(status.expectedBySim, "expectedByText"),
      ...(status.rejectReason === undefined ? {} : { rejectReasonText: status.rejectReason }),
      ...textOf(status.reversedAtSim, "reversedAtText"),
      direction: operation.direction,
      amount: money(operation.amount),
      atText: dayTimeText(operation.atSim),
    });
  };

  const getDisbursement: ToolImplementation<ToolInput<Tools["get_disbursement"]>> = async (ctx) => {
    const complaint = complaintOf(ctx);
    let loanId = ctx.input.loanId ?? complaint.subject?.loanId;
    if (loanId === undefined) {
      const customer = await core().call("getCustomer", coreContextOf(ctx), { params: { customerId: ctx.session.customerId } });
      loanId = customer.loans.at(-1)?.loanId;
    }
    if (loanId === undefined) throw new ToolError("NOT_FOUND", "the customer has no loan");
    const disbursement = await core().call("getDisbursement", coreContextOf(ctx), { params: { loanId } });
    if (disbursement.customerId !== ctx.session.customerId) throw new ToolError("FORBIDDEN", "loanId is not a loan of this customer");
    const overdue = disbursement.status === "PENDING" && disbursement.expectedBySim !== undefined && Date.parse(disbursement.expectedBySim) < Date.parse(ctx.session.eventAtSim);
    const recorded = await recordEvidence(
      ctx,
      "DISBURSEMENT",
      {
        loanId,
        status: disbursement.status,
        gross: disbursement.gross,
        originationFee: disbursement.originationFee,
        net: disbursement.net,
        overdue,
        ...(disbursement.creditedAtSim === undefined ? {} : { creditedAtSim: disbursement.creditedAtSim }),
        ...(disbursement.expectedBySim === undefined ? {} : { expectedBySim: disbursement.expectedBySim }),
        ...(disbursement.returnedAtSim === undefined ? {} : { returnedAtSim: disbursement.returnedAtSim }),
      },
      complaint,
    );
    const waiting = disbursement.status === "PENDING" && !overdue && disbursement.expectedBySim !== undefined ? await awaitDisbursement(ctx, complaints(), complaint, disbursement.expectedBySim) : {};
    await ctx.audit({ outcome: disbursement.status, refs: { loanId, evidenceId: recorded.evidenceId }, ...(Object.keys(waiting).length === 0 ? {} : { detail: waiting }) });
    return ok({
      evidenceId: recorded.evidenceId,
      loanId,
      status: disbursement.status,
      gross: money(disbursement.gross),
      originationFee: money(disbursement.originationFee),
      net: money(disbursement.net),
      overdue,
      ...textOf(disbursement.creditedAtSim, "creditedAtText"),
      ...textOf(disbursement.expectedBySim, "expectedByText"),
      ...textOf(disbursement.returnedAtSim, "returnedAtText"),
      ...waiting,
    });
  };

  return { get_transfer_status: getTransferStatus, get_disbursement: getDisbursement } as const;
}
