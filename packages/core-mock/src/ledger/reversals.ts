// `POST /charges/{chargeId}/reversal`: a wrong charge back to the wallet with compensatory
// interest (BCRA 2.3.5.1, our reading, not legal advice). Only a `WRONG` charge of the session's
// customer; claim `REV#<chargeId>` once per charge, whatever the complaint; the amount is what was
// charged above the schedule and the interest is 1,5 × the synthetic reference rate × days / 365.
// Claim, charge, wallet, credit movement and credit note are one transaction.
import { type ChargeReversalRequest, type ChargeReversalResult, ChargeReversalResult as ChargeReversalResultSchema } from "@reclamo/core-contract";
import { putChanged, putNew } from "../store/codec";
import type { CreditNoteItem, MovementItem } from "../store/items";
import { coreKeys } from "../store/keys";
import { loadCharge } from "./bundle";
import { actionIdFor, answerTakenClaim, type ClaimRef, claimWrite, commitWithRetry, readClaim } from "./claims";
import { type LedgerContext, LedgerError, centsOf, daysBetween, deterministicId, localDate } from "./context";
import { chargeFacts, evaluateCharge } from "./fees";

/** BCRA 2.3.5.1 (our reading): reimbursements carry 1,5 times a reference rate. */
export const COMPENSATORY_FACTOR = 1.5;

/** Pure: compensatory interest of an amount held `days` calendar days at an annual reference rate. */
export function compensatoryInterest(amount: number, referenceRate: number, days: number): number {
  if (days <= 0) return 0;
  return centsOf((amount * COMPENSATORY_FACTOR * referenceRate * days) / 365);
}

export async function reverseCharge(ctx: LedgerContext, chargeId: string, request: ChargeReversalRequest): Promise<ChargeReversalResult> {
  const ref: ClaimRef = { kind: "REV", naturalKey: chargeId };
  return commitWithRetry(async () => {
    const { bundle, charge } = await loadCharge(ctx, chargeId, request.customerId);
    const taken = await readClaim(ctx, ref);
    if (taken !== undefined) return { writes: [], result: answerTakenClaim(taken.value, request.idempotencyKey, ChargeReversalResultSchema) };
    const detail = evaluateCharge(chargeFacts(bundle, charge.value));
    if (detail.verdict !== "WRONG") throw new LedgerError("NOT_ELIGIBLE", "only a charge the schedule does not support is reversed");
    const amount = charge.value.amount - detail.expectedAmount;
    if (amount <= 0) throw new LedgerError("NOT_ELIGIBLE", "nothing was charged above the schedule");
    if (amount > request.cap) throw new LedgerError("ABOVE_CAP", "the amount is above the caller's cap");

    const days = daysBetween(localDate(charge.value.chargedAtSim), localDate(ctx.simNow));
    const interest = compensatoryInterest(amount, request.referenceRate, days);
    const actionId = actionIdFor(ctx, ref);
    const creditNoteId = deterministicId("cn", ctx.worldId, ref.kind, chargeId);
    const result: ChargeReversalResult = {
      actionId,
      chargeId,
      creditNoteId,
      amount,
      compensatoryInterest: interest,
      days: Math.max(0, days),
      referenceRate: request.referenceRate,
      creditedAtSim: ctx.simNow,
    };
    const creditNote: CreditNoteItem = {
      entity: "CreditNote",
      creditNoteId,
      customerId: request.customerId,
      kind: "CHARGE_REVERSAL",
      sourceId: chargeId,
      amount,
      compensatoryInterest: interest,
      complaintId: request.complaintId,
      actionId,
      creditedAtSim: ctx.simNow,
    };
    const movement: MovementItem = {
      entity: "Movement",
      movementId: deterministicId("mov", ctx.worldId, creditNoteId),
      customerId: request.customerId,
      kind: "CREDIT",
      atSim: ctx.simNow,
      amount: amount + interest,
      direction: "IN",
      description: "Reintegro de un cargo con interés compensatorio",
      status: "COMPLETED",
      ref: { chargeId, creditNoteId, ...(charge.value.loanId === undefined ? {} : { loanId: charge.value.loanId }) },
    };
    const wallet = bundle.wallet.value;
    return {
      result,
      writes: [
        claimWrite(ctx, ref, bundle.stamp, { customerId: request.customerId, complaintId: request.complaintId, amount, idempotencyKey: request.idempotencyKey, result }),
        putChanged(charge, { ...charge.value, reversal: { actionId, creditNoteId, complaintId: request.complaintId, amount, compensatoryInterest: interest, creditedAtSim: ctx.simNow } }, bundle.stamp),
        putChanged(bundle.wallet, { ...wallet, balance: wallet.balance + amount + interest }, bundle.stamp),
        putNew(movement, bundle.pk, coreKeys.movementSk(ctx.simNow, movement.movementId), bundle.stamp),
        putNew(creditNote, bundle.pk, coreKeys.creditNoteSk(creditNoteId), bundle.stamp),
      ],
    };
  }, ctx);
}
