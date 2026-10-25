// `GET /customers/{id}/operations?from&to&kind`: the customer's operations between two Argentine
// calendar dates (at most 90 days), newest first, never one after the world's simulated now, at
// most 100 rows with `truncated` when more matched. A charge already reversed names its credit note
// (`ref.creditNoteId`).
import type { Operation, OperationKindFilter, OperationList } from "@reclamo/core-contract";
import type { ChargeItem, MovementItem } from "../store/items";
import { type CustomerBundle, loadCustomer } from "./bundle";
import { type LedgerContext, LedgerError, daysBetween, instantMs, localDate } from "./context";

export const MAX_OPERATION_DAYS = 90;
const MAX_ROWS = 100;

export function toOperation(movement: MovementItem, reversedCharge?: ChargeItem): Operation {
  const creditNoteId = reversedCharge?.reversal?.creditNoteId;
  return {
    operationId: movement.movementId,
    kind: movement.kind,
    atSim: movement.atSim,
    amount: movement.amount,
    direction: movement.direction,
    description: movement.description,
    status: movement.status,
    ref: creditNoteId === undefined ? movement.ref : { ...movement.ref, creditNoteId },
  };
}

/** The charge of a `CHARGE` operation, when it was reversed: its operation names the credit note. */
function reversedChargeOf(bundle: CustomerBundle, movement: MovementItem): ChargeItem | undefined {
  if (movement.kind !== "CHARGE" || movement.ref.chargeId === undefined) return undefined;
  const charge = bundle.charges.get(movement.ref.chargeId)?.value;
  return charge?.reversal === undefined ? undefined : charge;
}

export async function listOperations(
  ctx: LedgerContext,
  customerId: string,
  query: { readonly from: string; readonly to: string; readonly kind?: OperationKindFilter | undefined },
): Promise<OperationList> {
  const span = daysBetween(query.from, query.to);
  if (span < 0) throw new LedgerError("INVALID", "`to` is before `from`");
  if (span > MAX_OPERATION_DAYS) throw new LedgerError("INVALID", `at most ${MAX_OPERATION_DAYS} days per query`);
  const bundle = await loadCustomer(ctx, customerId);
  const nowMs = instantMs(ctx.simNow);
  const kind = query.kind ?? "ALL";
  const matching = bundle.movements
    .map((movement) => movement.value)
    .filter((movement) => {
      const day = localDate(movement.atSim);
      return day >= query.from && day <= query.to && instantMs(movement.atSim) <= nowMs && (kind === "ALL" || movement.kind === kind);
    })
    .reverse();
  return {
    customerId,
    from: query.from,
    to: query.to,
    operations: matching.slice(0, MAX_ROWS).map((movement) => toOperation(movement, reversedChargeOf(bundle, movement))),
    truncated: matching.length > MAX_ROWS,
  };
}
