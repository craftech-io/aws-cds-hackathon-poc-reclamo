// `POST /customers/{customerId}/closure`: the account closure, registered on the spot (BCRA 2.7.2,
// our reading: as simple as opening it; `T-7.1`…`T-7.4`). The account goes to `CLOSING` and the
// core lists, by code, what keeps it from closing: a loan with a balance, money in the wallet, a
// transfer still pending. Nothing retains or offers anything. The same idempotency key replays the
// first answer; another request on an account already closing is `CONFLICT` with its action.
import type { ClosureCondition, ClosureRequest, ClosureResult } from "@reclamo/core-contract";
import { putChanged } from "../store/codec";
import type { ClosureRecord } from "../store/items";
import { type CustomerBundle, loadCustomer } from "./bundle";
import { commitWithRetry } from "./claims";
import { type LedgerContext, LedgerError, deterministicId } from "./context";
import { loanOutstanding, openLoans } from "./loans";

/** Pure: what still keeps the account from closing. */
export function closureConditions(bundle: CustomerBundle): ClosureCondition[] {
  const conditions: ClosureCondition[] = openLoans(bundle).map((state) => ({ code: "ACTIVE_LOAN", loanId: state.loan.value.loanId, amount: loanOutstanding(state) }));
  if (bundle.wallet.value.balance > 0) conditions.push({ code: "WALLET_BALANCE", amount: bundle.wallet.value.balance });
  for (const transfer of bundle.transfers) if (transfer.value.status === "PENDING") conditions.push({ code: "PENDING_TRANSFER", amount: transfer.value.amount });
  return conditions.slice(0, 10);
}

function toResult(closure: ClosureRecord): ClosureResult {
  return { actionId: closure.actionId, accountStatusAfter: "CLOSING", conditions: closure.conditions, requestedAtSim: closure.requestedAtSim };
}

export async function requestClosure(ctx: LedgerContext, customerId: string, request: ClosureRequest): Promise<ClosureResult> {
  return commitWithRetry(async () => {
    const bundle = await loadCustomer(ctx, customerId);
    const account = bundle.account.value;
    if (account.closure !== undefined) {
      if (account.closure.idempotencyKey === request.idempotencyKey) return { writes: [], result: toResult(account.closure) };
      throw new LedgerError("CONFLICT", "the account closure was already requested", account.closure.actionId);
    }
    if (account.status === "CLOSED") throw new LedgerError("CONFLICT", "the account is already closed");
    const closure: ClosureRecord = {
      actionId: deterministicId("act", ctx.worldId, "CLOSURE", customerId),
      complaintId: request.complaintId,
      idempotencyKey: request.idempotencyKey,
      requestedAtSim: ctx.simNow,
      conditions: closureConditions(bundle),
    };
    return { writes: [putChanged(bundle.account, { ...account, status: "CLOSING", closure }, bundle.stamp)], result: toResult(closure) };
  }, ctx);
}
