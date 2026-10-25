// The transfer network (docs/architecture-integrations.md §6.2): the status of a transfer, its
// scheduled transitions (a `NETWORK_TRANSITION` timer or the QA driver) and the reversal of a
// transfer that was rejected and not returned. A reversal happens once per transfer, whatever the
// number of complaints, approvals or retries: the `TRV#<transferId>` claim and the status change are
// one atomic write, and a second attempt gets `CONFLICT` with the existing action.
import { createHash } from "node:crypto";
import {
  type TransferReversalRequest,
  TransferReversalResult,
  TransferStatus,
  type TransitionRequest,
} from "@reclamo/core-contract";
import { NetworkError, NetworkUnavailableError } from "./errors";
import type { KnownTransferState, ReversalClaim, StoredTransfer } from "./store/items";
import type { NetworkStore } from "./store/port";
import type { WorldContext } from "./world-context";

const ATTEMPTS = 3;
const MAX_TRANSITIONS = 20;

/** Transitions the network allows; asking for the current state again changes nothing. */
const NEXT: Readonly<Record<KnownTransferState, readonly KnownTransferState[]>> = {
  PENDING: ["COMPLETED", "REJECTED_REVERSED", "REJECTED_NOT_REVERSED"],
  REJECTED_NOT_REVERSED: ["REJECTED_REVERSED"],
  COMPLETED: [],
  REJECTED_REVERSED: [],
};

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** Trace the network gives a transfer it completes without one planned: `TRZ-` + 10 hex digits. */
export function traceIdFor(worldId: string, transferId: string): string {
  return `TRZ-${digest("trace", worldId, transferId).slice(0, 10).toUpperCase()}`;
}

/** Action id of a reversal: one per transfer and idempotency key. */
export function reversalActionId(worldId: string, transferId: string, idempotencyKey: string): string {
  return `trv-${digest("reversal", worldId, transferId, idempotencyKey).slice(0, 24)}`;
}

/** The contract's view of a stored transfer: the customer and the amount never leave the network. */
export function toContractStatus(transfer: StoredTransfer): TransferStatus {
  return TransferStatus.parse({
    transferId: transfer.transferId,
    status: transfer.status,
    ...(transfer.traceId === undefined ? {} : { traceId: transfer.traceId }),
    ...(transfer.completedAtSim === undefined ? {} : { completedAtSim: transfer.completedAtSim }),
    ...(transfer.expectedBySim === undefined ? {} : { expectedBySim: transfer.expectedBySim }),
    ...(transfer.rejectReason === undefined ? {} : { rejectReason: transfer.rejectReason }),
    ...(transfer.reversedAtSim === undefined ? {} : { reversedAtSim: transfer.reversedAtSim }),
  });
}

function reversalResult(claim: ReversalClaim): TransferReversalResult {
  return TransferReversalResult.parse({ actionId: claim.actionId, transferId: claim.transferId, status: "REJECTED_REVERSED", amount: claim.amount, reversedAtSim: claim.reversedAtSim });
}

function moved(transfer: StoredTransfer, to: KnownTransferState, atSim: string, by: "TRANSITION" | "REVERSAL"): StoredTransfer["transitions"] {
  return [...transfer.transitions, { from: transfer.status, to, atSim, by }].slice(-MAX_TRANSITIONS);
}

export function createTransfers(deps: { readonly store: NetworkStore }) {
  const { store } = deps;

  async function existing(context: WorldContext, transferId: string): Promise<StoredTransfer> {
    const transfer = await store.getTransfer(context.worldId, transferId);
    if (transfer === undefined) throw new NetworkError("NOT_FOUND", "the network does not know this transfer");
    return transfer;
  }

  /** The transfer after moving it to `to` at the request's instant. */
  function transitioned(context: WorldContext, transfer: StoredTransfer, request: TransitionRequest): StoredTransfer {
    const next: StoredTransfer = { ...transfer, status: request.to, transitions: moved(transfer, request.to, context.simNow, "TRANSITION") };
    if (request.to === "COMPLETED") return { ...next, traceId: transfer.traceId ?? traceIdFor(context.worldId, transfer.transferId), completedAtSim: context.simNow };
    const rejected = request.rejectReason === undefined ? next : { ...next, rejectReason: request.rejectReason };
    return request.to === "REJECTED_REVERSED" ? { ...rejected, reversedAtSim: context.simNow } : rejected;
  }

  return {
    /** `UNKNOWN` when the network does not know the transfer (an incoming one it never saw). */
    async getTransfer(context: WorldContext, transferId: string): Promise<TransferStatus> {
      const transfer = await store.getTransfer(context.worldId, transferId);
      return transfer === undefined ? TransferStatus.parse({ transferId, status: "UNKNOWN" }) : toContractStatus(transfer);
    },

    async transitionTransfer(context: WorldContext, transferId: string, request: TransitionRequest): Promise<TransferStatus> {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const transfer = await existing(context, transferId);
        if (transfer.status === request.to) return toContractStatus(transfer);
        if (!NEXT[transfer.status].includes(request.to)) throw new NetworkError("CONFLICT", "the network does not allow this transition");
        const next = transitioned(context, transfer, request);
        if ((await store.updateTransfer(next, transfer.version)) === "OK") return toContractStatus(next);
      }
      throw new NetworkUnavailableError("the transfer kept changing; retry");
    },

    async requestTransferReversal(context: WorldContext, transferId: string, request: TransferReversalRequest): Promise<TransferReversalResult> {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const transfer = await existing(context, transferId);
        if (transfer.customerId !== request.customerId) throw new NetworkError("FORBIDDEN", "the transfer is not the customer's");
        const claimed = await store.getReversalClaim(context.worldId, transferId);
        if (claimed !== undefined) {
          if (claimed.idempotencyKey === request.idempotencyKey && claimed.complaintId === request.complaintId) return reversalResult(claimed);
          throw new NetworkError("CONFLICT", "the transfer was already reversed", claimed.actionId);
        }
        if (transfer.status !== "REJECTED_NOT_REVERSED") throw new NetworkError("NOT_ELIGIBLE", "only a rejected transfer that was not returned can be reversed");
        if (transfer.amount > request.cap) throw new NetworkError("ABOVE_CAP", "the amount is above the cap");

        const claim: ReversalClaim = {
          worldId: context.worldId,
          transferId,
          actionId: reversalActionId(context.worldId, transferId, request.idempotencyKey),
          customerId: request.customerId,
          complaintId: request.complaintId,
          idempotencyKey: request.idempotencyKey,
          amount: transfer.amount,
          reversedAtSim: context.simNow,
        };
        const next: StoredTransfer = { ...transfer, status: "REJECTED_REVERSED", reversedAtSim: context.simNow, transitions: moved(transfer, "REJECTED_REVERSED", context.simNow, "REVERSAL") };
        if ((await store.reverseTransfer(claim, next, transfer.version)) === "OK") return reversalResult(claim);
      }
      throw new NetworkUnavailableError("the transfer kept changing; retry");
    },
  };
}

export type Transfers = ReturnType<typeof createTransfers>;
