// `POST /wallets/{customerId}/freeze`: the outgoing freeze of the wallet (`T-4.4`, `T-4.5`).
// Freezing is always allowed, by anyone (protection first); lifting it is only for `by = STAFF`:
// the agent has no tool to lift it and the core refuses it anyway (FL-050). Every change is kept in
// the freeze history; the same idempotency key replays its first answer.
import type { FreezeRequest, FreezeResult } from "@reclamo/core-contract";
import { putChanged } from "../store/codec";
import type { FreezeEvent } from "../store/items";
import { loadCustomer } from "./bundle";
import { commitWithRetry } from "./claims";
import { type LedgerContext, LedgerError, deterministicId } from "./context";

const MAX_HISTORY = 50;

export async function setOutgoingFreeze(ctx: LedgerContext, customerId: string, request: FreezeRequest): Promise<FreezeResult> {
  if (!request.active && request.by !== "STAFF") throw new LedgerError("FORBIDDEN", "only staff lifts an outgoing freeze");
  const actionId = deterministicId("act", ctx.worldId, "FREEZE", customerId, request.idempotencyKey);
  return commitWithRetry<FreezeResult>(async () => {
    const bundle = await loadCustomer(ctx, customerId);
    const wallet = bundle.wallet.value;
    const earlier = wallet.freeze.history.find((event) => event.actionId === actionId);
    if (earlier !== undefined) return { writes: [], result: { actionId, outgoingFrozen: earlier.active, changed: true, atSim: earlier.atSim } };
    if (wallet.freeze.active === request.active) return { writes: [], result: { actionId, outgoingFrozen: wallet.freeze.active, changed: false, atSim: ctx.simNow } };

    const event: FreezeEvent = {
      actionId,
      idempotencyKey: request.idempotencyKey,
      active: request.active,
      by: request.by,
      reason: request.reason,
      ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }),
      atSim: ctx.simNow,
    };
    const freeze = { active: request.active, atSim: ctx.simNow, by: request.by, history: [...wallet.freeze.history, event].slice(-MAX_HISTORY) };
    return {
      writes: [putChanged(bundle.wallet, { ...wallet, freeze }, bundle.stamp)],
      result: { actionId, outgoingFrozen: request.active, changed: true, atSim: ctx.simNow },
    };
  }, ctx);
}
