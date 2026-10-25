import { describe, expect, it } from "vitest";
import { getCustomer } from "./accounts";
import { requestClosure } from "./closure";
import { coreWorld, ledgerContext } from "./testing";

// C36-like: a loan with 7 instalments left, money in the wallet and a transfer still pending.
function world() {
  return coreWorld([
    {
      customerId: "cus-0036",
      balance: 1_250_000,
      loans: [
        {
          loanId: "L-0036",
          principal: 90_000_000,
          instalments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-${String(9 + number).padStart(2, "0")}-05`, amount: 10_000_000, paid: number === 1 ? 10_000_000 : 0 })),
        },
        { loanId: "L-0036b", principal: 1_000_000, status: "CANCELLED", instalments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-0${5 + number}-05`, amount: 400_000, paid: 400_000 })) },
      ],
      transfers: [
        { transferId: "trf-pending", amount: 300_000, status: "PENDING" },
        { transferId: "trf-done", amount: 500_000, status: "COMPLETED" },
      ],
    },
    { customerId: "cus-0040", phoneHash: "4".repeat(64), accountStatus: "CLOSED" },
  ]);
}

describe("account closure registered on the spot [FL-053]", () => {
  it("[FL-053] puts the account in CLOSING and lists by code what keeps it open (loan balance, wallet, pending transfer)", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    const result = await requestClosure(ctx, "cus-0036", { complaintId: "cmp-36", idempotencyKey: "cmp-36:closure" });
    expect(result).toMatchObject({ accountStatusAfter: "CLOSING", requestedAtSim: ctx.simNow });
    expect(result.conditions).toEqual([
      { code: "ACTIVE_LOAN", loanId: "L-0036", amount: 20_000_000 },
      { code: "WALLET_BALANCE", amount: 1_250_000 },
      { code: "PENDING_TRANSFER", amount: 300_000 },
    ]);
    expect((await getCustomer(ctx, "cus-0036")).account).toEqual({ status: "CLOSING", closureRequestedAtSim: ctx.simNow });
  });

  it("[FL-053] replays the same request and answers CONFLICT with the existing action to another one", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    const first = await requestClosure(ctx, "cus-0036", { complaintId: "cmp-36", idempotencyKey: "cmp-36:closure" });
    expect(await requestClosure(ctx, "cus-0036", { complaintId: "cmp-36", idempotencyKey: "cmp-36:closure" })).toEqual(first);
    await expect(requestClosure(ctx, "cus-0036", { complaintId: "cmp-37", idempotencyKey: "cmp-37:closure" })).rejects.toMatchObject({ code: "CONFLICT", actionId: first.actionId });
    expect(store.commits).toBe(1);
  });

  it("refuses a closed account and an unknown customer", async () => {
    const ctx = ledgerContext(world());
    await expect(requestClosure(ctx, "cus-0040", { complaintId: "cmp-40", idempotencyKey: "k" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(requestClosure(ctx, "cus-0404", { complaintId: "cmp-40", idempotencyKey: "k" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
