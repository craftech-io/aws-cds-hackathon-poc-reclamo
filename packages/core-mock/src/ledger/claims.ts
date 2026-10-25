// Money moves once per natural key (docs/architecture.md §5): every imputation, charge reversal,
// duplicate-debit refund and transfer reversal takes the claim `OPC#<network>#<code>`, `REV#<charge>`,
// `RFD#<debit>` or `TRV#<transfer>` with an `absent` put **in the same transaction** that moves the
// money. A second attempt finds the claim and moves nothing:
//
//   - with another idempotency key (another complaint, another approval) → `CONFLICT` with the
//     `actionId` that holds the claim;
//   - with the same idempotency key (the client retrying a call whose answer was lost) → the stored
//     answer of the first attempt, so a retry is safe and still never moves money twice.
import type { z } from "zod";
import { type Stored, type WriteStamp, decodeItem, putNew } from "../store/codec";
import { ActionClaimItem } from "../store/items";
import { type ClaimKind, SK, coreKeys } from "../store/keys";
import { type PutWrite, StoreConflictError } from "../store/port";
import { type LedgerContext, LedgerError, deterministicId } from "./context";

export interface ClaimRef {
  readonly kind: ClaimKind;
  /** `<network>#<operationCode>`, `<chargeId>`, `<debitId>` or `<transferId>`. */
  readonly naturalKey: string;
}

export async function readClaim(ctx: LedgerContext, ref: ClaimRef): Promise<Stored<ActionClaimItem> | undefined> {
  const row = await ctx.store.get(coreKeys.claimPk(ctx.worldId, ref.kind, ref.naturalKey), SK.CLAIM);
  return row === undefined ? undefined : decodeItem(ActionClaimItem, row);
}

/** The answer to an attempt that found the claim taken: the replay of its own first answer, or `CONFLICT`. */
export function answerTakenClaim<S extends z.ZodType>(claim: ActionClaimItem, idempotencyKey: string, schema: S): z.infer<S> {
  if (claim.idempotencyKey === idempotencyKey && claim.result !== undefined) {
    const replay = schema.safeParse(claim.result);
    if (replay.success) return replay.data;
  }
  throw new LedgerError("CONFLICT", "this action was already executed", claim.actionId);
}

/** The id of the action that takes a claim: stable for the natural key, whatever the attempt. */
export function actionIdFor(ctx: LedgerContext, ref: ClaimRef): string {
  return deterministicId("act", ctx.worldId, ref.kind, ref.naturalKey);
}

export function claimWrite(
  ctx: LedgerContext,
  ref: ClaimRef,
  stamp: WriteStamp,
  fields: { readonly customerId: string; readonly complaintId: string; readonly amount: number; readonly idempotencyKey: string; readonly result: object },
): PutWrite {
  const value: ActionClaimItem = {
    entity: "ActionClaim",
    kind: ref.kind,
    actionId: actionIdFor(ctx, ref),
    customerId: fields.customerId,
    complaintId: fields.complaintId,
    amount: fields.amount,
    idempotencyKey: fields.idempotencyKey,
    result: fields.result as Record<string, unknown>,
  };
  return putNew(value, coreKeys.claimPk(ctx.worldId, ref.kind, ref.naturalKey), SK.CLAIM, stamp);
}

/** Attempts of an optimistic change before the mock answers 503 (another writer kept winning). */
const OPTIMISTIC_ATTEMPTS = 3;

/**
 * Runs a read-decide-write step until its transaction commits. Each attempt re-reads, so a claim
 * taken by a concurrent writer is found on the next attempt and answered as such.
 */
export async function commitWithRetry<T>(step: () => Promise<{ readonly writes: readonly PutWrite[]; readonly result: T }>, ctx: LedgerContext): Promise<T> {
  for (let attempt = 1; attempt <= OPTIMISTIC_ATTEMPTS; attempt += 1) {
    const { writes, result } = await step();
    try {
      await ctx.store.transact(writes);
      return result;
    } catch (error) {
      if (!(error instanceof StoreConflictError) || attempt === OPTIMISTIC_ATTEMPTS) {
        if (error instanceof StoreConflictError) throw new LedgerError("UNAVAILABLE", "concurrent changes, try again");
        throw error;
      }
    }
  }
  throw new LedgerError("UNAVAILABLE", "concurrent changes, try again");
}
