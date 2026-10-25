import { ChallengeCheckResult } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { amountMatches, checkChallenge, dateMatches, parseAmountAnswer, parseDateAnswer } from "./challenge";
import { coreWorld, ledgerContext } from "./testing";

const INSTALMENT = 11_864_000;

// C01-like: instalment 4 of $ 118.640,00 fell due on Monday 05/10; the demo clock is 07/10 10:10.
function world() {
  return coreWorld([
    {
      customerId: "cus-0001",
      loans: [
        {
          loanId: "L-0001",
          principal: 96_000_000,
          instalments: [3, 4, 5].map((number) => ({ number, dueDate: `2026-${String(6 + number).padStart(2, "0")}-05`, amount: INSTALMENT })),
        },
      ],
      movements: [{ movementId: "mov-1", kind: "TRANSFER_IN", atSim: "2026-10-03T12:00:00-03:00", amount: 4_500_000 }],
    },
    { customerId: "cus-0038", phoneHash: "8".repeat(64), movements: [{ movementId: "mov-2", kind: "CREDIT", atSim: "2026-10-01T09:00:00-03:00", amount: 123_450 }] },
    { customerId: "cus-0050", phoneHash: "e".repeat(64) },
  ]);
}

describe("identity challenge checked by code [FL-003]", () => {
  it("[FL-003] accepts the last due date as customers write it, and only that date", async () => {
    const ctx = ledgerContext(world());
    for (const answer of ["5/10", "05/10", "05-10-2026", "5/10/26", "5 de octubre", "el 5 de oct.", "2026-10-05", "lunes 5/10"]) {
      expect(await checkChallenge(ctx, "cus-0001", { kind: "LAST_DUE_DATE", answer }), answer).toEqual({ ok: true });
    }
    for (const answer of ["5/11", "6/10", "05-10-2025", "octubre", "no sé"]) {
      expect(await checkChallenge(ctx, "cus-0001", { kind: "LAST_DUE_DATE", answer }), answer).toEqual({ ok: false });
    }
  });

  it("[FL-003] accepts the last instalment's amount with or without thousands, decimals and the peso sign", async () => {
    const ctx = ledgerContext(world());
    for (const answer of ["118640", "$ 118.640,00", "118.640", "$118640", "118640,00"]) {
      expect(await checkChallenge(ctx, "cus-0001", { kind: "LAST_INSTALMENT_AMOUNT", answer }), answer).toEqual({ ok: true });
    }
    for (const answer of ["118.641", "11864", "118640,50", "ciento"]) {
      expect(await checkChallenge(ctx, "cus-0001", { kind: "LAST_INSTALMENT_AMOUNT", answer }), answer).toEqual({ ok: false });
    }
  });

  it("[FL-003] answers only {ok}: the expected value never leaves the core", async () => {
    const ctx = ledgerContext(world());
    const result = await checkChallenge(ctx, "cus-0001", { kind: "LAST_DUE_DATE", answer: "1/1" });
    expect(ChallengeCheckResult.parse(result)).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toMatch(/2026|118/);
    await expect(checkChallenge(ctx, "cus-0050", { kind: "LAST_DUE_DATE", answer: "5/10" })).rejects.toMatchObject({ code: "NOT_ELIGIBLE", message: expect.not.stringMatching(/\d/) });
  });

  it("[FL-003] asks a customer without loans for the last wallet operation", async () => {
    const ctx = ledgerContext(world());
    expect(await checkChallenge(ctx, "cus-0038", { kind: "LAST_MOVEMENT_AMOUNT", answer: "1.234,50" })).toEqual({ ok: true });
    expect(await checkChallenge(ctx, "cus-0038", { kind: "LAST_MOVEMENT_AMOUNT", answer: "1234" })).toEqual({ ok: true });
    expect(await checkChallenge(ctx, "cus-0038", { kind: "LAST_MOVEMENT_AMOUNT", answer: "1235" })).toEqual({ ok: false });
    await expect(checkChallenge(ctx, "cus-0038", { kind: "LAST_INSTALMENT_AMOUNT", answer: "1" })).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("parses dates and amounts deterministically", () => {
    expect(parseDateAnswer("5 de Octubre de 2026")).toEqual({ day: 5, month: 10, year: 2026 });
    expect(parseDateAnswer("31/02")).toEqual({ day: 31, month: 2 });
    expect(parseDateAnswer("32/10")).toBeUndefined();
    expect(parseAmountAnswer("$ 1.234.567,89")).toEqual({ cents: 123_456_789, withDecimals: true });
    expect(parseAmountAnswer("1,5")).toEqual({ cents: 150, withDecimals: true });
    expect(amountMatches("118640", 11_864_050)).toBe(true);
    expect(amountMatches("118640,00", 11_864_050)).toBe(false);
    expect(dateMatches("5/10", "2026-10-05")).toBe(true);
  });
});
