import type { TransferReversalCreditRequest } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { WalletItem } from "../store/items";
import { SK, coreKeys } from "../store/keys";
import { creditTransferReversal } from "./transfer-credit";
import { WORLD, coreWorld, itemAt, ledgerContext } from "./testing";

const CUSTOMER = { customerId: "cus-0030", balance: 410_000, transfers: [{ transferId: "trf-0030-1", amount: 3_800_000, status: "REJECTED_NOT_REVERSED" }] };

function credit(overrides: Partial<TransferReversalCreditRequest> = {}): TransferReversalCreditRequest {
  return { complaintId: "cmp-30", transferId: "trf-0030-1", idempotencyKey: "cmp-30:trv", ...overrides };
}

const balanceOf = (store: ReturnType<typeof coreWorld>, customerId = "cus-0030") => WalletItem.parse(itemAt(store, coreKeys.customerPk(WORLD, customerId), SK.WALLET)).balance;

describe("wallet credit of a reversed transfer [FL-044]", () => {
  it("[FL-044] credits the transfer's own amount once with the claim TRV#, and replays the same key", async () => {
    const store = coreWorld([CUSTOMER]);
    const ctx = ledgerContext(store);
    const first = await creditTransferReversal(ctx, "cus-0030", credit());
    expect(first).toMatchObject({ transferId: "trf-0030-1", amount: 3_800_000, creditedAtSim: ctx.simNow });
    expect(balanceOf(store)).toBe(410_000 + 3_800_000);
    expect(await creditTransferReversal(ctx, "cus-0030", credit())).toEqual(first);
    expect(balanceOf(store)).toBe(410_000 + 3_800_000);
  });

  it("[FL-044] a second complaint about the same transfer is CONFLICT with the existing action and moves nothing", async () => {
    const store = coreWorld([CUSTOMER]);
    const ctx = ledgerContext(store);
    const first = await creditTransferReversal(ctx, "cus-0030", credit());
    await expect(creditTransferReversal(ctx, "cus-0030", credit({ complaintId: "cmp-31", idempotencyKey: "cmp-31:trv" }))).rejects.toMatchObject({ code: "CONFLICT", actionId: first.actionId });
    expect(balanceOf(store)).toBe(410_000 + 3_800_000);
  });

  it("[FL-044] refuses another customer's transfer and one the core does not see rejected and not returned", async () => {
    const store = coreWorld([CUSTOMER, { customerId: "cus-0027", transfers: [{ transferId: "trf-0027-1", amount: 1_000_000, status: "COMPLETED" }] }]);
    const ctx = ledgerContext(store);
    await expect(creditTransferReversal(ctx, "cus-0027", credit())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(creditTransferReversal(ctx, "cus-0027", credit({ transferId: "trf-0027-1" }))).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    expect(store.commits).toBe(0);
  });
});
