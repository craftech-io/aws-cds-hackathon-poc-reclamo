// The wallet credit of an outgoing transfer the network reversed (docs/architecture-integrations.md §6.2,
// FL-044): the network confirms the reversal and the core credits it. The core only credits a transfer
// of this customer that it sees rejected and not returned, with its own amount (never the caller's),
// and takes the claim `TRV#<transferId>` in the same transaction: a second complaint about the same
// transfer finds the claim (`CONFLICT` with the existing action) and moves nothing; the same
// idempotency key gets the first answer again.
import { type TransferReversalCreditRequest, type TransferReversalCreditResult, TransferReversalCreditResult as ResultSchema } from "@reclamo/core-contract";
import { putChanged, putNew } from "../store/codec";
import type { MovementItem } from "../store/items";
import { coreKeys } from "../store/keys";
import { loadCustomer } from "./bundle";
import { type ClaimRef, actionIdFor, answerTakenClaim, claimWrite, commitWithRetry, readClaim } from "./claims";
import { type LedgerContext, LedgerError, deterministicId } from "./context";

export async function creditTransferReversal(ctx: LedgerContext, customerId: string, request: TransferReversalCreditRequest): Promise<TransferReversalCreditResult> {
  const ref: ClaimRef = { kind: "TRV", naturalKey: request.transferId };
  return commitWithRetry(async () => {
    const bundle = await loadCustomer(ctx, customerId);
    const transfer = bundle.transfers.find((candidate) => candidate.value.transferId === request.transferId && candidate.value.direction === "OUT");
    // A transfer outside the customer's rows is not theirs, whoever it belongs to.
    if (transfer === undefined) throw new LedgerError("FORBIDDEN", "the transfer is not this customer's");
    const taken = await readClaim(ctx, ref);
    if (taken !== undefined) return { writes: [], result: answerTakenClaim(taken.value, request.idempotencyKey, ResultSchema) };
    if (transfer.value.status !== "REJECTED_NOT_REVERSED") throw new LedgerError("NOT_ELIGIBLE", "only a rejected transfer that was not returned is credited back");

    const { amount } = transfer.value;
    const result: TransferReversalCreditResult = { actionId: actionIdFor(ctx, ref), transferId: request.transferId, amount, creditedAtSim: ctx.simNow };
    const credit: MovementItem = {
      entity: "Movement",
      movementId: deterministicId("mov", ctx.worldId, ref.kind, request.transferId),
      customerId,
      kind: "CREDIT",
      atSim: ctx.simNow,
      amount,
      direction: "IN",
      description: "Reversión de una transferencia rechazada",
      status: "COMPLETED",
      ref: { transferId: request.transferId },
    };
    const outgoing = bundle.movements.find((movement) => movement.value.kind === "TRANSFER_OUT" && movement.value.ref.transferId === request.transferId);
    const wallet = bundle.wallet.value;
    return {
      result,
      writes: [
        claimWrite(ctx, ref, bundle.stamp, { customerId, complaintId: request.complaintId, amount, idempotencyKey: request.idempotencyKey, result }),
        putChanged(transfer, { ...transfer.value, status: "REJECTED_REVERSED" }, bundle.stamp),
        ...(outgoing === undefined ? [] : [putChanged(outgoing, { ...outgoing.value, status: "REVERSED" as const }, bundle.stamp)]),
        putChanged(bundle.wallet, { ...wallet, balance: wallet.balance + amount }, bundle.stamp),
        putNew(credit, bundle.pk, coreKeys.movementSk(ctx.simNow, credit.movementId), bundle.stamp),
      ],
    };
  }, ctx);
}
