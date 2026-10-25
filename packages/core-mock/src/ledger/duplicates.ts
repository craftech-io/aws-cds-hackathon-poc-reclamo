// Duplicate automatic debits (`T-5.1`…`T-5.4`): `POST /loans/{loanId}/duplicate-check` detects
// them and `POST /refunds` gives one back to the wallet.
//
//   Duplicate = same loan, same instalment, same amount, within 72 h of the previous debit; the
//   later one is the duplicate. Two debits of the same amount for different instalments are not.
//
// A refund only for a debit the check calls duplicate, of the session's customer; claim
// `RFD#<debitId>`, so a second complaint about the same debit (allowed once the first is answered)
// gets `CONFLICT` with the existing action and never a second refund. An already refunded duplicate
// is still reported as `DUPLICATE` (with nothing left to refund) so the second complaint can be
// explained with the refund that exists.
import {
  type Debit,
  type DuplicateCheck,
  type RefundRequest,
  type RefundResult,
  RefundResult as RefundResultSchema,
} from "@reclamo/core-contract";
import { putChanged, putNew } from "../store/codec";
import type { CreditNoteItem, MovementItem } from "../store/items";
import { coreKeys } from "../store/keys";
import { type CustomerBundle, loadCustomer, loadLoan } from "./bundle";
import { actionIdFor, answerTakenClaim, type ClaimRef, claimWrite, commitWithRetry, readClaim } from "./claims";
import { type LedgerContext, LedgerError, compareText, deterministicId, instantMs } from "./context";

export const DUPLICATE_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_DEBITS = 10;

export interface DebitFact extends Debit {
  readonly loanId: string;
  readonly refunded: boolean;
}

/** The loan's automatic debits, oldest first. */
export function debitsOf(bundle: CustomerBundle, loanId: string): DebitFact[] {
  return bundle.movements
    .map((movement) => movement.value)
    .filter((movement) => movement.kind === "DEBIT" && movement.ref.loanId === loanId && movement.ref.debitId !== undefined && movement.ref.instalment !== undefined && movement.amount > 0)
    .map((movement) => ({
      debitId: movement.ref.debitId ?? "",
      instalment: movement.ref.instalment ?? 1,
      amount: movement.amount,
      atSim: movement.atSim,
      loanId,
      refunded: movement.status === "REVERSED",
    }))
    .sort((a, b) => instantMs(a.atSim) - instantMs(b.atSim) || compareText(a.debitId, b.debitId));
}

/** Pure: the duplicates among a loan's debits (each one the later debit of its pair). */
export function findDuplicates(debits: readonly DebitFact[]): DebitFact[] {
  const duplicates: DebitFact[] = [];
  const byInstalment = new Map<number, DebitFact[]>();
  for (const debit of debits) byInstalment.set(debit.instalment, [...(byInstalment.get(debit.instalment) ?? []), debit]);
  for (const group of byInstalment.values()) {
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1];
      const current = group[index];
      if (previous === undefined || current === undefined) continue;
      if (current.amount === previous.amount && instantMs(current.atSim) - instantMs(previous.atSim) <= DUPLICATE_WINDOW_MS) duplicates.push(current);
    }
  }
  return duplicates.sort((a, b) => instantMs(b.atSim) - instantMs(a.atSim));
}

export async function checkDuplicateDebit(ctx: LedgerContext, loanId: string, instalment?: number): Promise<DuplicateCheck> {
  const { bundle, state } = await loadLoan(ctx, loanId);
  const debits = debitsOf(bundle, loanId).filter((debit) => instalment === undefined || debit.instalment === instalment);
  const duplicate = findDuplicates(debits)[0];
  return {
    loanId,
    customerId: state.loan.value.customerId,
    verdict: duplicate === undefined ? "NOT_DUPLICATE" : "DUPLICATE",
    debits: debits
      .slice(-MAX_DEBITS)
      .reverse()
      .map((debit) => ({ debitId: debit.debitId, instalment: debit.instalment, amount: debit.amount, atSim: debit.atSim })),
    ...(duplicate === undefined ? {} : { duplicateDebitId: duplicate.debitId }),
    refundable: duplicate === undefined || duplicate.refunded ? 0 : duplicate.amount,
  };
}

export async function refundDuplicateDebit(ctx: LedgerContext, request: RefundRequest): Promise<RefundResult> {
  const ref: ClaimRef = { kind: "RFD", naturalKey: request.debitId };
  return commitWithRetry(async () => {
    const bundle = await loadCustomer(ctx, request.customerId);
    const movement = bundle.movements.find((candidate) => candidate.value.kind === "DEBIT" && candidate.value.ref.debitId === request.debitId);
    // A debit outside the session customer's rows is not theirs, whoever it belongs to.
    if (movement === undefined || movement.value.ref.loanId === undefined) throw new LedgerError("FORBIDDEN", "the debit is not this customer's");
    const taken = await readClaim(ctx, ref);
    if (taken !== undefined) return { writes: [], result: answerTakenClaim(taken.value, request.idempotencyKey, RefundResultSchema) };
    const duplicate = findDuplicates(debitsOf(bundle, movement.value.ref.loanId)).find((debit) => debit.debitId === request.debitId);
    if (duplicate === undefined || duplicate.refunded) throw new LedgerError("NOT_ELIGIBLE", "only a detected duplicate debit is refunded");
    if (duplicate.amount > request.cap) throw new LedgerError("ABOVE_CAP", "the amount is above the caller's cap");

    const actionId = actionIdFor(ctx, ref);
    const creditNoteId = deterministicId("cn", ctx.worldId, ref.kind, request.debitId);
    const result: RefundResult = { actionId, debitId: request.debitId, creditNoteId, amount: duplicate.amount, creditedAtSim: ctx.simNow };
    const creditNote: CreditNoteItem = {
      entity: "CreditNote",
      creditNoteId,
      customerId: request.customerId,
      kind: "DUPLICATE_REFUND",
      sourceId: request.debitId,
      amount: duplicate.amount,
      compensatoryInterest: 0,
      complaintId: request.complaintId,
      actionId,
      creditedAtSim: ctx.simNow,
    };
    const credit: MovementItem = {
      entity: "Movement",
      movementId: deterministicId("mov", ctx.worldId, creditNoteId),
      customerId: request.customerId,
      kind: "CREDIT",
      atSim: ctx.simNow,
      amount: duplicate.amount,
      direction: "IN",
      description: "Reintegro de un débito automático duplicado",
      status: "COMPLETED",
      ref: { loanId: duplicate.loanId, instalment: duplicate.instalment, debitId: request.debitId, creditNoteId },
    };
    const wallet = bundle.wallet.value;
    return {
      result,
      writes: [
        claimWrite(ctx, ref, bundle.stamp, { customerId: request.customerId, complaintId: request.complaintId, amount: duplicate.amount, idempotencyKey: request.idempotencyKey, result }),
        putChanged(movement, { ...movement.value, status: "REVERSED" }, bundle.stamp),
        putChanged(bundle.wallet, { ...wallet, balance: wallet.balance + duplicate.amount }, bundle.stamp),
        putNew(credit, bundle.pk, coreKeys.movementSk(ctx.simNow, credit.movementId), bundle.stamp),
        putNew(creditNote, bundle.pk, coreKeys.creditNoteSk(creditNoteId), bundle.stamp),
      ],
    };
  }, ctx);
}
