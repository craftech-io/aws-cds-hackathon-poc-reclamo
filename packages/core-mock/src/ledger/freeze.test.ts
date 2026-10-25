import type { FreezeRequest } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { WalletItem } from "../store/items";
import { coreKeys, SK } from "../store/keys";
import { getCustomer } from "./accounts";
import { setOutgoingFreeze } from "./freeze";
import { WORLD, coreWorld, itemAt, ledgerContext } from "./testing";

function freeze(overrides: Partial<FreezeRequest> = {}): FreezeRequest {
  return { active: true, reason: "UNKNOWN_OPERATION", by: "AGENT", complaintId: "cmp-6", idempotencyKey: "cmp-6:freeze", ...overrides };
}

const walletOf = (store: ReturnType<typeof coreWorld>) => WalletItem.parse(itemAt(store, coreKeys.customerPk(WORLD, "cus-0006"), SK.WALLET));

describe("outgoing freeze on an unknown operation [FL-049]", () => {
  it("[FL-049] freezes the wallet's outgoing operations at once, for anyone, with its history", async () => {
    const store = coreWorld([{ customerId: "cus-0006", balance: 2_000_000 }]);
    const ctx = ledgerContext(store);
    const result = await setOutgoingFreeze(ctx, "cus-0006", freeze());
    expect(result).toMatchObject({ outgoingFrozen: true, changed: true, atSim: ctx.simNow });
    expect((await getCustomer(ctx, "cus-0006")).wallet).toMatchObject({ outgoingFrozen: true, frozenAtSim: ctx.simNow });
    expect(walletOf(store).freeze.history).toEqual([expect.objectContaining({ active: true, by: "AGENT", reason: "UNKNOWN_OPERATION", complaintId: "cmp-6", actionId: result.actionId })]);
  });

  it("[FL-049] replays the same request and leaves an already frozen wallet unchanged", async () => {
    const store = coreWorld([{ customerId: "cus-0006" }]);
    const ctx = ledgerContext(store);
    const first = await setOutgoingFreeze(ctx, "cus-0006", freeze());
    expect(await setOutgoingFreeze(ctx, "cus-0006", freeze())).toEqual(first);
    expect(await setOutgoingFreeze(ctx, "cus-0006", freeze({ idempotencyKey: "other" }))).toMatchObject({ outgoingFrozen: true, changed: false });
    expect(store.commits).toBe(1);
  });
});

describe("unfreeze only by staff [FL-050]", () => {
  it("[FL-050] refuses to lift the freeze for the agent or the system, and keeps it active", async () => {
    const store = coreWorld([{ customerId: "cus-0006", frozen: true }]);
    const ctx = ledgerContext(store);
    await expect(setOutgoingFreeze(ctx, "cus-0006", freeze({ active: false, by: "AGENT", reason: "CUSTOMER_REQUEST", idempotencyKey: "lift-1" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setOutgoingFreeze(ctx, "cus-0006", freeze({ active: false, by: "SYSTEM", idempotencyKey: "lift-2" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(walletOf(store).freeze.active).toBe(true);
    expect(store.commits).toBe(0);
  });

  it("[FL-050] lets staff lift it", async () => {
    const store = coreWorld([{ customerId: "cus-0006", frozen: true }]);
    const result = await setOutgoingFreeze(ledgerContext(store), "cus-0006", freeze({ active: false, by: "STAFF", reason: "STAFF_DECISION", idempotencyKey: "lift-staff" }));
    expect(result).toMatchObject({ outgoingFrozen: false, changed: true });
    expect(walletOf(store).freeze).toMatchObject({ active: false, by: "STAFF" });
  });
});
