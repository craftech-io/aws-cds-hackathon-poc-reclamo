import type { PaymentRequest } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { SK, coreKeys } from "../store/keys";
import { getLoan, listInstalments } from "./loans";
import { LATE_TOLERANCE_DAYS, applyPayment, lateInterestFor, planAllocation } from "./payments";
import { WORLD, coreWorld, itemAt, ledgerContext } from "./testing";

const INSTALMENT = 11_864_000;

// C01-like: 12 instalments of $ 118.640,00, instalment 4 due Monday 05/10, three already paid.
function customerWithLoan(customerId = "cus-0001", loanId = "L-0001") {
  return {
    customerId,
    loans: [
      {
        loanId,
        principal: 96_000_000,
        instalments: Array.from({ length: 12 }, (_, index) => ({
          number: index + 1,
          dueDate: dueDateOf(index + 1),
          amount: INSTALMENT,
          paid: index < 3 ? INSTALMENT : 0,
        })),
      },
    ],
  };
}

function dueDateOf(number: number): string {
  const month = 6 + number; // instalment 4 → October
  const year = month > 12 ? 2027 : 2026;
  return `${year}-${String(((month - 1) % 12) + 1).padStart(2, "0")}-05`;
}

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    customerId: "cus-0001",
    complaintId: "cmp-1",
    reconciliationId: "rec-1",
    network: "NORTE",
    operationCode: "NTE-20261006-004817-7",
    amount: INSTALMENT,
    paidAtSim: "2026-10-06T18:40:00-03:00",
    source: "SETTLEMENT",
    idempotencyKey: "cmp-1:rec-1",
    cap: 25_000_000,
    ...overrides,
  };
}

describe("payment imputation [FL-016]", () => {
  it("[FL-016] applies a reconciled payment to the oldest unpaid instalment and takes the OPC# claim in the same transaction", async () => {
    const store = coreWorld([customerWithLoan()]);
    const ctx = ledgerContext(store, "2026-10-08T08:31:00-03:00");
    const result = await applyPayment(ctx, "L-0001", request());

    expect(result.applied).toBe(INSTALMENT);
    expect(result.lateInterest).toBe(0);
    expect(result.allocations).toEqual([{ instalment: 4, amount: INSTALMENT, statusAfter: "PAID" }]);
    expect(result.loanStatusAfter).toBe("ACTIVE");
    expect(store.commits).toBe(1);

    const claim = itemAt(store, coreKeys.claimPk(WORLD, "OPC", "NORTE#NTE-20261006-004817-7"), SK.CLAIM);
    expect(claim).toMatchObject({ entity: "ActionClaim", actionId: result.actionId, customerId: "cus-0001", complaintId: "cmp-1", amount: INSTALMENT });
    const payment = itemAt(store, coreKeys.customerPk(WORLD, "cus-0001"), coreKeys.paymentSk("L-0001", result.paymentId));
    expect(payment).toMatchObject({ opCodeKey: coreKeys.opCodeKey(WORLD, "NORTE", "NTE-20261006-004817-7"), customerId: "cus-0001", worldIndexKey: `W#${WORLD}#` });
    expect(await store.queryByOperationCode(coreKeys.opCodeKey(WORLD, "NORTE", "NTE-20261006-004817-7"))).toHaveLength(1);

    const instalments = await listInstalments(ctx, "L-0001");
    expect(instalments.instalments[3]).toMatchObject({ number: 4, status: "PAID", outstanding: 0 });
    expect(instalments.instalments[3]?.payments[0]).toMatchObject({ paymentId: result.paymentId, network: "NORTE", amount: INSTALMENT });
  });

  it("[FL-016] counts the 2-day tolerance of T-3.4 to the day the customer paid, not the day the network settled", async () => {
    const store = coreWorld([customerWithLoan()]);
    const settledLate = ledgerContext(store, "2026-10-12T09:00:00-03:00");
    const result = await applyPayment(settledLate, "L-0001", request({ paidAtSim: "2026-10-06T18:40:00-03:00" }));
    expect(result.lateInterest).toBe(0);
    expect(result.allocations[0]?.statusAfter).toBe("PAID");
  });

  it("charges late interest past the tolerance (50 % of the compensatory rate, daily)", async () => {
    expect(LATE_TOLERANCE_DAYS).toBe(2);
    expect(lateInterestFor(INSTALMENT, 0.95, 2)).toBe(0);
    expect(lateInterestFor(INSTALMENT, 0.95, 5)).toBe(Math.round((INSTALMENT * 0.95 * 0.5 * 5) / 365));

    const store = coreWorld([customerWithLoan()]);
    const result = await applyPayment(ledgerContext(store, "2026-10-12T09:00:00-03:00"), "L-0001", request({ paidAtSim: "2026-10-10T11:00:00-03:00", amount: INSTALMENT }));
    const late = lateInterestFor(INSTALMENT, 0.95, 5);
    expect(result.lateInterest).toBe(late);
    expect(result.allocations).toEqual([{ instalment: 4, amount: INSTALMENT, statusAfter: "PARTIALLY_PAID" }]);
  });
});

describe("one imputation per operation code [FL-021]", () => {
  it("[FL-021] refuses the same operation code from another complaint with CONFLICT and the existing actionId, moving nothing", async () => {
    const store = coreWorld([customerWithLoan()]);
    const ctx = ledgerContext(store);
    const first = await applyPayment(ctx, "L-0001", request());
    const before = store.dump();

    await expect(applyPayment(ctx, "L-0001", request({ complaintId: "cmp-2", idempotencyKey: "cmp-2:rec-9" }))).rejects.toMatchObject({ code: "CONFLICT", actionId: first.actionId });
    expect(store.dump()).toEqual(before);
    expect(store.commits).toBe(1);
  });

  it("[FL-021] replays the first answer to a retry with the same idempotency key, without a second movement", async () => {
    const store = coreWorld([customerWithLoan()]);
    const ctx = ledgerContext(store);
    const first = await applyPayment(ctx, "L-0001", request());
    expect(await applyPayment(ctx, "L-0001", request())).toEqual(first);
    expect(store.commits).toBe(1);
  });

  it("[FL-021] lets only one of two concurrent attempts on the same code move money", async () => {
    const store = coreWorld([customerWithLoan()]);
    const ctx = ledgerContext(store);
    const outcomes = await Promise.allSettled([
      applyPayment(ctx, "L-0001", request({ complaintId: "cmp-a", idempotencyKey: "a" })),
      applyPayment(ctx, "L-0001", request({ complaintId: "cmp-b", idempotencyKey: "b" })),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => (outcome as PromiseRejectedResult).reason.code)).toEqual(["CONFLICT"]);
    expect((await getLoan(ctx, "L-0001")).paidCount).toBe(4);
  });
});

describe("partial payment [FL-023]", () => {
  it("[FL-023] applies less than the instalment and leaves it PARTIALLY_PAID with its balance", async () => {
    const store = coreWorld([customerWithLoan()]);
    const ctx = ledgerContext(store);
    const result = await applyPayment(ctx, "L-0001", request({ amount: 5_000_000 }));
    expect(result.allocations).toEqual([{ instalment: 4, amount: 5_000_000, statusAfter: "PARTIALLY_PAID" }]);
    const loan = await getLoan(ctx, "L-0001");
    expect(loan.nextDue).toEqual({ number: 4, dueDate: "2026-10-05", amount: INSTALMENT - 5_000_000 });
    expect(loan.status).toBe("IN_ARREARS");
  });

  it("spreads a payment of two instalments oldest first (pure plan)", () => {
    const plan = planAllocation(
      [
        { entity: "Instalment", loanId: "L-1", number: 2, dueDate: "2026-11-05", principal: 1, interest: 1, vat: 1, amount: 1_000, lateInterest: 0, paid: 0 },
        { entity: "Instalment", loanId: "L-1", number: 1, dueDate: "2026-10-05", principal: 1, interest: 1, vat: 1, amount: 1_000, lateInterest: 0, paid: 400 },
      ],
      1_500,
      "2026-10-06",
      0.9,
    );
    expect(plan.allocations).toEqual([
      { instalment: 1, amount: 600 },
      { instalment: 2, amount: 900 },
    ]);
    expect(plan.owedBefore).toBe(1_600);
  });
});

describe("payments the core refuses [FL-111]", () => {
  it("[FL-111] refuses a loan of another customer with FORBIDDEN and takes no claim", async () => {
    const store = coreWorld([customerWithLoan("cus-0041", "L-0041"), { ...customerWithLoan("cus-1017", "L-1017"), phoneHash: "b".repeat(64) }]);
    const ctx = ledgerContext(store);
    await expect(applyPayment(ctx, "L-1017", request({ customerId: "cus-0041" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(itemAt(store, coreKeys.claimPk(WORLD, "OPC", "NORTE#NTE-20261006-004817-7"), SK.CLAIM)).toBeUndefined();
    expect(store.commits).toBe(0);
  });

  it("refuses an amount above the caller's cap and above what the loan owes", async () => {
    const store = coreWorld([customerWithLoan()]);
    const ctx = ledgerContext(store);
    await expect(applyPayment(ctx, "L-0001", request({ amount: 31_240_000, cap: 25_000_000 }))).rejects.toMatchObject({ code: "ABOVE_CAP" });
    await expect(applyPayment(ctx, "L-0001", request({ amount: INSTALMENT * 10, cap: INSTALMENT * 20 }))).rejects.toMatchObject({ code: "EXCEEDS_OUTSTANDING" });
    expect(store.commits).toBe(0);
  });

  it("cancels the loan when the last instalment is paid, and refuses any payment after that", async () => {
    const store = coreWorld([
      {
        customerId: "cus-0014",
        loans: [
          {
            loanId: "L-0014",
            principal: 30_000_000,
            instalments: [1, 2, 3, 4, 5, 6].map((number) => ({ number, dueDate: `2026-${String(4 + number).padStart(2, "0")}-05`, amount: 6_000_000, paid: number < 6 ? 6_000_000 : 0 })),
          },
        ],
      },
    ]);
    const ctx = ledgerContext(store, "2026-10-07T10:10:00-03:00");
    const result = await applyPayment(ctx, "L-0014", request({ customerId: "cus-0014", amount: 6_000_000, paidAtSim: "2026-10-05T12:00:00-03:00" }));
    expect(result.loanStatusAfter).toBe("CANCELLED");
    expect(result.outstandingAfter).toBe(0);
    expect(await getLoan(ctx, "L-0014")).toMatchObject({ status: "CANCELLED", cancelledAtSim: "2026-10-07T10:10:00-03:00", outstanding: 0 });
    await expect(applyPayment(ctx, "L-0014", request({ customerId: "cus-0014", operationCode: "SUR-1", amount: 100 }))).rejects.toMatchObject({ code: "EXCEEDS_OUTSTANDING" });
  });
});
