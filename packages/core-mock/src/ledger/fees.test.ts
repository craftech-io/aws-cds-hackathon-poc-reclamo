import { describe, expect, it } from "vitest";
import { CARD_REPLACEMENT_FEE, checkCharge, originationFee } from "./fees";
import { lateInterestFor } from "./payments";
import { coreWorld, ledgerContext } from "./testing";

const INSTALMENT = 9_500_000;

// C22-like: instalment 2 due 05/09, paid 10/09 (5 days late), late interest charged on 11/09.
function customer(charges: ReadonlyArray<Record<string, unknown>>) {
  return {
    customerId: "cus-0022",
    loans: [
      {
        loanId: "L-0022",
        principal: 40_000_000,
        annualRate: 0.9,
        disbursedAtSim: "2026-07-05T10:00:00-03:00",
        instalments: [
          { number: 1, dueDate: "2026-08-05", amount: INSTALMENT, paid: INSTALMENT },
          { number: 2, dueDate: "2026-09-05", amount: INSTALMENT, paid: INSTALMENT },
          { number: 3, dueDate: "2026-10-05", amount: INSTALMENT },
          { number: 4, dueDate: "2026-11-05", amount: INSTALMENT },
          { number: 5, dueDate: "2026-12-05", amount: INSTALMENT },
          { number: 6, dueDate: "2027-01-05", amount: INSTALMENT },
        ],
        payments: [
          { paymentId: "pay-1", network: "SUR" as const, operationCode: "SUR-20260805-1", amount: INSTALMENT, paidAtSim: "2026-08-05T09:00:00-03:00", allocations: [{ instalment: 1, amount: INSTALMENT }] },
          { paymentId: "pay-2", network: "SUR" as const, operationCode: "SUR-20260910-2", amount: INSTALMENT, paidAtSim: "2026-09-10T09:00:00-03:00", allocations: [{ instalment: 2, amount: INSTALMENT }] },
        ],
      },
    ],
    charges: charges as never,
  };
}

const punitive = (amount: number, instalment = 2) => ({ chargeId: "chg-punit", feeCode: "FEE-PUNIT", amount, chargedAtSim: "2026-09-11T00:05:00-03:00", loanId: "L-0022", instalment });

describe("charge check against the fee schedule [FL-032]", () => {
  it("[FL-032] calls a late-interest charge past the tolerance CORRECT, with its clauses and the expected amount", async () => {
    const expected = lateInterestFor(INSTALMENT, 0.9, 5);
    const store = coreWorld([customer([punitive(expected)])]);
    const check = await checkCharge(ledgerContext(store), "chg-punit");
    expect(check).toMatchObject({
      chargeId: "chg-punit",
      customerId: "cus-0022",
      loanId: "L-0022",
      feeCode: "FEE-PUNIT",
      verdict: "CORRECT",
      expectedAmount: expected,
      reason: "MATCHES_SCHEDULE",
      clauseIds: ["T-3.2", "T-3.4"],
      scheduleVersion: "v001",
    });
    expect(store.commits).toBe(0);
  });

  it("[FL-032] calls late interest WRONG when the instalment was paid within the 2-day tolerance", async () => {
    const store = coreWorld([
      {
        ...customer([{ ...punitive(80_000), instalment: 1, chargeId: "chg-tol" }]),
      },
    ]);
    // Instalment 1 was paid on its due date: no late interest is owed.
    const check = await checkCharge(ledgerContext(store), "chg-tol");
    expect(check).toMatchObject({ verdict: "WRONG", expectedAmount: 0, reason: "WITHIN_TOLERANCE" });
  });

  it("calls an overcharge WRONG with the schedule's amount, and is deterministic", async () => {
    const expected = lateInterestFor(INSTALMENT, 0.9, 5);
    const store = coreWorld([customer([punitive(expected + 50_000)])]);
    const ctx = ledgerContext(store);
    const first = await checkCharge(ctx, "chg-punit");
    expect(first).toMatchObject({ verdict: "WRONG", expectedAmount: expected, reason: "AMOUNT_DIFFERS" });
    expect(await checkCharge(ctx, "chg-punit")).toEqual(first);
  });

  it("checks every fee of the schedule: card replacement, insurance, origination and its duplicate", async () => {
    const store = coreWorld([
      customer([
        { chargeId: "chg-card", feeCode: "FEE-CARD-REPL", amount: CARD_REPLACEMENT_FEE, chargedAtSim: "2026-10-01T09:00:00-03:00" },
        { chargeId: "chg-card-ok", feeCode: "FEE-CARD-REPL", amount: CARD_REPLACEMENT_FEE, chargedAtSim: "2026-10-01T09:00:00-03:00", requested: true },
        { chargeId: "chg-ins", feeCode: "FEE-INS", amount: 3_890_000, chargedAtSim: "2026-10-02T09:00:00-03:00", loanId: "L-0022" },
        { chargeId: "chg-orig-1", feeCode: "FEE-ORIG", amount: originationFee(40_000_000), chargedAtSim: "2026-07-05T10:00:00-03:00", loanId: "L-0022" },
        { chargeId: "chg-orig-2", feeCode: "FEE-ORIG", amount: originationFee(40_000_000), chargedAtSim: "2026-07-06T10:00:00-03:00", loanId: "L-0022" },
        { chargeId: "chg-other", feeCode: "FEE-UNKNOWN", amount: 1_000, chargedAtSim: "2026-10-02T09:00:00-03:00" },
      ]),
    ]);
    const ctx = ledgerContext(store);
    expect(await checkCharge(ctx, "chg-card")).toMatchObject({ verdict: "WRONG", expectedAmount: 0, reason: "NOT_REQUESTED", clauseIds: ["T-4.6"] });
    expect(await checkCharge(ctx, "chg-card-ok")).toMatchObject({ verdict: "CORRECT", expectedAmount: CARD_REPLACEMENT_FEE });
    expect(await checkCharge(ctx, "chg-ins")).toMatchObject({ verdict: "WRONG", reason: "NOT_CHARGEABLE", clauseIds: ["T-1.5"] });
    expect(await checkCharge(ctx, "chg-orig-1")).toMatchObject({ verdict: "CORRECT", expectedAmount: Math.round(40_000_000 * 0.03 * 1.21), clauseIds: ["T-1.6"] });
    expect(await checkCharge(ctx, "chg-orig-2")).toMatchObject({ verdict: "WRONG", expectedAmount: 0, reason: "DUPLICATED" });
    expect(await checkCharge(ctx, "chg-other")).toMatchObject({ verdict: "UNDETERMINED", reason: "NO_RULE", clauseIds: [] });
  });

  it("answers NOT_FOUND for an unknown charge and WORLD_NOT_FOUND for an empty world", async () => {
    const store = coreWorld([customer([])]);
    await expect(checkCharge(ledgerContext(store), "chg-none")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(checkCharge(ledgerContext(store, undefined, "qa-empty"), "chg-none")).rejects.toMatchObject({ code: "WORLD_NOT_FOUND" });
  });
});
