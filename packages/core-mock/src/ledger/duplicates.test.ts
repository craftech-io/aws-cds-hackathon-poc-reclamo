import type { RefundRequest } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { SK, coreKeys } from "../store/keys";
import { getCustomer } from "./accounts";
import { checkDuplicateDebit, refundDuplicateDebit } from "./duplicates";
import { WORLD, coreWorld, itemAt, ledgerContext } from "./testing";

const AMOUNT = 7_230_000;

const debit = (debitId: string, instalment: number, atSim: string, amount = AMOUNT) => ({
  movementId: `mov-${debitId}`,
  kind: "DEBIT" as const,
  atSim,
  amount,
  ref: { loanId: "L-0025", instalment, debitId },
});

const loan = {
  loanId: "L-0025",
  principal: 50_000_000,
  instalments: [5, 6, 7].map((number) => ({ number, dueDate: `2026-${String(number + 4).padStart(2, "0")}-02`, amount: AMOUNT, paid: number < 7 ? AMOUNT : 0 })),
};

// C25-like: instalment 6 debited twice (02/10 and 03/10). C26-like: instalments 5 and 6, same amount, same day.
function world() {
  return coreWorld([
    { customerId: "cus-0025", balance: 0, loans: [loan], movements: [debit("dbt-6a", 6, "2026-10-02T06:00:00-03:00"), debit("dbt-6b", 6, "2026-10-03T06:00:00-03:00")] },
    {
      customerId: "cus-0026",
      phoneHash: "d".repeat(64),
      loans: [{ ...loan, loanId: "L-0026" }],
      movements: [
        { ...debit("dbt-5", 5, "2026-10-02T06:00:00-03:00"), ref: { loanId: "L-0026", instalment: 5, debitId: "dbt-5" } },
        { ...debit("dbt-6", 6, "2026-10-02T06:05:00-03:00"), ref: { loanId: "L-0026", instalment: 6, debitId: "dbt-6" } },
      ],
    },
  ]);
}

function refund(overrides: Partial<RefundRequest> = {}): RefundRequest {
  return { customerId: "cus-0025", complaintId: "cmp-25", debitId: "dbt-6b", idempotencyKey: "cmp-25:dup-1", cap: 12_000_000, ...overrides };
}

describe("duplicate automatic debit within the cap [FL-037]", () => {
  it("[FL-037] detects the later debit of the same instalment and amount within 72 h as the duplicate", async () => {
    const check = await checkDuplicateDebit(ledgerContext(world()), "L-0025", 6);
    expect(check).toMatchObject({ loanId: "L-0025", customerId: "cus-0025", verdict: "DUPLICATE", duplicateDebitId: "dbt-6b", refundable: AMOUNT });
    expect(check.debits.map((entry) => entry.debitId)).toEqual(["dbt-6b", "dbt-6a"]);
  });

  it("[FL-037] refunds it to the wallet with a credit note and the RFD# claim, in one transaction", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    const result = await refundDuplicateDebit(ctx, refund());
    expect(result).toMatchObject({ debitId: "dbt-6b", amount: AMOUNT, creditedAtSim: ctx.simNow });
    expect((await getCustomer(ctx, "cus-0025")).wallet.balance).toBe(AMOUNT);
    expect(itemAt(store, coreKeys.claimPk(WORLD, "RFD", "dbt-6b"), SK.CLAIM)).toMatchObject({ actionId: result.actionId, complaintId: "cmp-25", amount: AMOUNT });
    expect(itemAt(store, coreKeys.customerPk(WORLD, "cus-0025"), coreKeys.creditNoteSk(result.creditNoteId))).toMatchObject({ kind: "DUPLICATE_REFUND", sourceId: "dbt-6b" });
    expect(store.commits).toBe(1);
  });

  it("[FL-037] a second complaint about the same debit gets CONFLICT with the existing action and never a second refund", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    const first = await refundDuplicateDebit(ctx, refund());
    const check = await checkDuplicateDebit(ctx, "L-0025", 6);
    expect(check).toMatchObject({ verdict: "DUPLICATE", duplicateDebitId: "dbt-6b", refundable: 0 });
    await expect(refundDuplicateDebit(ctx, refund({ complaintId: "cmp-26", idempotencyKey: "cmp-26:dup-2" }))).rejects.toMatchObject({ code: "CONFLICT", actionId: first.actionId });
    expect((await getCustomer(ctx, "cus-0025")).wallet.balance).toBe(AMOUNT);
    expect(store.commits).toBe(1);
  });

  it("refuses a debit of another customer, a debit that is not the duplicate and an amount above the cap", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    await expect(refundDuplicateDebit(ctx, refund({ debitId: "dbt-6" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(refundDuplicateDebit(ctx, refund({ debitId: "dbt-6a" }))).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    await expect(refundDuplicateDebit(ctx, refund({ cap: AMOUNT - 1 }))).rejects.toMatchObject({ code: "ABOVE_CAP" });
    expect(store.commits).toBe(0);
  });
});

describe("false duplicate [FL-039]", () => {
  it("[FL-039] two debits of the same amount for different instalments are NOT_DUPLICATE, with both debits as evidence", async () => {
    const store = world();
    const check = await checkDuplicateDebit(ledgerContext(store), "L-0026");
    expect(check).toMatchObject({ verdict: "NOT_DUPLICATE", refundable: 0 });
    expect(check.duplicateDebitId).toBeUndefined();
    expect(check.debits).toEqual([
      { debitId: "dbt-6", instalment: 6, amount: AMOUNT, atSim: "2026-10-02T06:05:00-03:00" },
      { debitId: "dbt-5", instalment: 5, amount: AMOUNT, atSim: "2026-10-02T06:00:00-03:00" },
    ]);
    await expect(refundDuplicateDebit(ledgerContext(store), refund({ customerId: "cus-0026", debitId: "dbt-6" }))).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("[FL-039] the same instalment debited again after 72 h is not a duplicate", async () => {
    const store = coreWorld([{ customerId: "cus-0025", loans: [loan], movements: [debit("dbt-a", 6, "2026-10-01T06:00:00-03:00"), debit("dbt-b", 6, "2026-10-04T06:00:01-03:00")] }]);
    expect((await checkDuplicateDebit(ledgerContext(store), "L-0025", 6)).verdict).toBe("NOT_DUPLICATE");
  });
});
