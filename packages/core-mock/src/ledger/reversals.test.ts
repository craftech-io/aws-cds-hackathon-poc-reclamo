import type { ChargeReversalRequest } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { SK, coreKeys } from "../store/keys";
import { getCustomer } from "./accounts";
import { checkCharge } from "./fees";
import { listOperations } from "./operations";
import { compensatoryInterest, reverseCharge } from "./reversals";
import { WORLD, coreWorld, itemAt, ledgerContext } from "./testing";

// C02-like: a card replacement of $ 2.500 charged on 01/10 that the customer never asked for.
function world() {
  return coreWorld([
    {
      customerId: "cus-0002",
      balance: 1_000_000,
      charges: [
        { chargeId: "chg-card", feeCode: "FEE-CARD-REPL", amount: 250_000, chargedAtSim: "2026-10-01T09:00:00-03:00" },
        { chargeId: "chg-card-asked", feeCode: "FEE-CARD-REPL", amount: 250_000, chargedAtSim: "2026-09-01T09:00:00-03:00", requested: true },
      ],
    },
    { customerId: "cus-0023", phoneHash: "c".repeat(64), charges: [{ chargeId: "chg-ins", feeCode: "FEE-INS", amount: 3_890_000, chargedAtSim: "2026-10-02T09:00:00-03:00" }] },
  ]);
}

function request(overrides: Partial<ChargeReversalRequest> = {}): ChargeReversalRequest {
  return { customerId: "cus-0002", complaintId: "cmp-2", idempotencyKey: "cmp-2:chk-1", cap: 1_500_000, referenceRate: 0.38, ...overrides };
}

describe("wrong charge reversed with compensatory interest [FL-033]", () => {
  it("[FL-033] credits the wallet with the amount plus 1,5 × rate × days / 365, writes the credit note and takes REV#", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    const result = await reverseCharge(ctx, "chg-card", request());

    const interest = compensatoryInterest(250_000, 0.38, 6);
    expect(interest).toBe(Math.round((250_000 * 1.5 * 0.38 * 6) / 365));
    expect(result).toMatchObject({ chargeId: "chg-card", amount: 250_000, compensatoryInterest: interest, days: 6, referenceRate: 0.38 });
    expect((await getCustomer(ctx, "cus-0002")).wallet.balance).toBe(1_000_000 + 250_000 + interest);

    const pk = coreKeys.customerPk(WORLD, "cus-0002");
    expect(itemAt(store, pk, coreKeys.creditNoteSk(result.creditNoteId))).toMatchObject({ entity: "CreditNote", kind: "CHARGE_REVERSAL", sourceId: "chg-card", amount: 250_000 });
    expect(itemAt(store, coreKeys.claimPk(WORLD, "REV", "chg-card"), SK.CLAIM)).toMatchObject({ actionId: result.actionId, complaintId: "cmp-2" });
    expect(itemAt(store, pk, coreKeys.chargeSk("chg-card"))).toMatchObject({ reversal: { actionId: result.actionId, creditNoteId: result.creditNoteId } });
    const credits = await listOperations(ctx, "cus-0002", { from: "2026-10-01", to: "2026-10-07", kind: "CREDIT" });
    expect(credits.operations).toEqual([expect.objectContaining({ kind: "CREDIT", direction: "IN", amount: 250_000 + interest })]);
    expect(store.commits).toBe(1);
  });

  it("[FL-033] reverses a charge once, whatever the complaint: a second one gets CONFLICT with the existing action", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    const first = await reverseCharge(ctx, "chg-card", request());
    await expect(reverseCharge(ctx, "chg-card", request({ complaintId: "cmp-9", idempotencyKey: "cmp-9:chk-2" }))).rejects.toMatchObject({ code: "CONFLICT", actionId: first.actionId });
    expect(await reverseCharge(ctx, "chg-card", request())).toEqual(first);
    expect(store.commits).toBe(1);
    // The check still tells what was wrong; the reversal is recorded on the charge.
    expect((await checkCharge(ctx, "chg-card")).verdict).toBe("WRONG");
  });

  it("refuses a correct charge, a charge of another customer and an amount above the cap", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    await expect(reverseCharge(ctx, "chg-card-asked", request())).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    await expect(reverseCharge(ctx, "chg-ins", request())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reverseCharge(ctx, "chg-ins", request({ customerId: "cus-0023", cap: 1_500_000 }))).rejects.toMatchObject({ code: "ABOVE_CAP" });
    expect(store.commits).toBe(0);
  });

  it("[FL-032] a charge already reversed says so: the check carries its reversal and its operation names the credit note", async () => {
    const store = coreWorld([
      {
        customerId: "cus-0002",
        movements: [{ movementId: "chg-card", kind: "CHARGE", atSim: "2026-10-01T09:00:00-03:00", amount: 250_000, direction: "OUT", ref: { chargeId: "chg-card" } }],
        charges: [{ chargeId: "chg-card", feeCode: "FEE-CARD-REPL", amount: 250_000, chargedAtSim: "2026-10-01T09:00:00-03:00" }],
      },
    ]);
    const ctx = ledgerContext(store);
    const charges = { from: "2026-09-01", to: "2026-10-07", kind: "CHARGE" } as const;
    expect((await checkCharge(ctx, "chg-card")).reversal).toBeUndefined();
    expect((await listOperations(ctx, "cus-0002", charges)).operations[0]?.ref).toEqual({ chargeId: "chg-card" });

    const done = await reverseCharge(ctx, "chg-card", request());
    expect(await checkCharge(ctx, "chg-card")).toMatchObject({
      verdict: "WRONG",
      reversal: { actionId: done.actionId, complaintId: "cmp-2", creditNoteId: done.creditNoteId, amount: 250_000, compensatoryInterest: done.compensatoryInterest, creditedAtSim: done.creditedAtSim },
    });
    expect((await listOperations(ctx, "cus-0002", charges)).operations[0]?.ref).toEqual({ chargeId: "chg-card", creditNoteId: done.creditNoteId });
  });
});
