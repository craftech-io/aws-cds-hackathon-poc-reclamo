import { describe, expect, it } from "vitest";
import { coreKeys } from "../store/keys";
import { endOfBusinessDay, payoffFigures, quoteEarlyPayoff } from "./payoff";
import { WORLD, coreWorld, itemAt, ledgerContext, splitInstalment } from "./testing";

const AMOUNT = 10_000_000;

// C36-like: 12 instalments, 5 paid, instalment 6 due 05/10 already paid, 7 due 05/11.
function world(paidCount = 5) {
  return coreWorld([
    {
      customerId: "cus-0036",
      loans: [
        {
          loanId: "L-0036",
          principal: 90_000_000,
          disbursedAtSim: "2026-04-05T10:00:00-03:00",
          instalments: Array.from({ length: 12 }, (_, index) => ({
            number: index + 1,
            dueDate: index + 1 <= 8 ? `2026-${String(5 + index).padStart(2, "0")}-05` : `2027-${String(index - 7).padStart(2, "0")}-05`,
            amount: AMOUNT,
            paid: index < paidCount ? AMOUNT : 0,
          })),
        },
      ],
    },
    { customerId: "cus-0099", phoneHash: "9".repeat(64) },
  ]);
}

describe("early payoff quote computed by the core [FL-052]", () => {
  it("[FL-052] quotes principal + accrued interest + no fee past 25 % of the term, valid to the end of the business day, and stores it", async () => {
    const store = world(6);
    const ctx = ledgerContext(store, "2026-10-20T11:00:00-03:00");
    const quote = await quoteEarlyPayoff(ctx, "L-0036", { customerId: "cus-0036" });
    const split = splitInstalment(AMOUNT);
    const accrued = Math.round(((split.interest + split.vat) * 15) / 31);
    expect(quote).toMatchObject({ loanId: "L-0036", customerId: "cus-0036", principal: split.principal * 6, accruedInterest: accrued, fee: 0, asOfSim: ctx.simNow, validUntilSim: "2026-10-20T23:59:59-03:00" });
    expect(quote.feeClauseId).toBeUndefined();
    expect(quote.total).toBe(quote.principal + quote.accruedInterest + quote.fee);
    expect(itemAt(store, coreKeys.customerPk(WORLD, "cus-0036"), coreKeys.quoteSk(quote.quoteId))).toMatchObject({ entity: "PayoffQuote", total: quote.total });
    expect(await quoteEarlyPayoff(ctx, "L-0036", { customerId: "cus-0036" })).toEqual(quote);
    expect(store.commits).toBe(1);
  });

  it("[FL-052] adds FEE-EARLY (2 % of the principal, T-6.2) before 25 % of the term, and counts overdue interest", () => {
    const instalments = [1, 2, 3, 4].map((number) => ({
      entity: "Instalment" as const,
      loanId: "L-1",
      number,
      dueDate: `2026-${String(9 + number).padStart(2, "0")}-05`.replace("2026-13", "2027-01"),
      principal: 700,
      interest: 248,
      vat: 52,
      amount: 1_000,
      lateInterest: 0,
      paid: 0,
    }));
    const figures = payoffFigures(instalments, 12, "2026-10-06", "2026-09-05");
    expect(figures.feeApplies).toBe(true);
    expect(figures.principal).toBe(2_800);
    expect(figures.fee).toBe(56);
    // Instalment 1 is overdue (all its interest); instalment 2's period ran 1 of 31 days.
    expect(figures.accruedInterest).toBe(300 + Math.round((300 * 1) / 31));
  });

  it("moves the validity of a quote asked on a weekend or holiday to the next business day", () => {
    expect(endOfBusinessDay("2026-10-10")).toBe("2026-10-13T23:59:59-03:00");
    expect(endOfBusinessDay("2026-10-12")).toBe("2026-10-13T23:59:59-03:00");
    expect(endOfBusinessDay("2026-10-07")).toBe("2026-10-07T23:59:59-03:00");
  });

  it("refuses a loan of another customer and a loan already cancelled", async () => {
    const store = world();
    await expect(quoteEarlyPayoff(ledgerContext(store), "L-0036", { customerId: "cus-0099" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const cancelled = coreWorld([{ customerId: "cus-0005", loans: [{ loanId: "L-0005", principal: 1_000_000, status: "CANCELLED", instalments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-0${6 + number}-15`, amount: 400_000, paid: 400_000 })) }] }]);
    await expect(quoteEarlyPayoff(ledgerContext(cancelled), "L-0005", { customerId: "cus-0005" })).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    expect(store.commits + cancelled.commits).toBe(0);
  });
});
