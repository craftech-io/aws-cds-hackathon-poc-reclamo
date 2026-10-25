import { describe, expect, it } from "vitest";
import type { CustomerSpec } from "@reclamo/core-mock/ledger/testing";
import { lateInterestFor } from "@reclamo/core-mock/ledger/payments";
import { OTHER_CUSTOMER } from "../common/testing";
import { CUSTOMER, WORLD } from "../account/testing";
import { createAccountTarget } from "../account/target";
import { gatewayContext } from "../common/principal";
import { CHARGE_REASON_TEXT } from "./checks";
import { codeOf, investigationKit, okOf } from "./testing";

const INSTALMENT = 9_500_000;
const DEBIT = 7_230_000;

/** Instalment 2 due 05/09 paid on 10/09 (5 days late) and charged late interest on 11/09; instalment 3 debited twice. */
function customer(chargeAmount: number, overrides: Partial<CustomerSpec> = {}): CustomerSpec {
  return {
    customerId: CUSTOMER,
    loans: [
      {
        loanId: "L-0001",
        principal: 40_000_000,
        annualRate: 0.9,
        disbursedAtSim: "2026-07-05T10:00:00-03:00",
        instalments: [
          { number: 1, dueDate: "2026-08-05", amount: INSTALMENT, paid: INSTALMENT },
          { number: 2, dueDate: "2026-09-05", amount: INSTALMENT, paid: INSTALMENT },
          { number: 3, dueDate: "2026-10-05", amount: INSTALMENT },
          { number: 4, dueDate: "2026-11-05", amount: INSTALMENT },
        ],
        payments: [
          { paymentId: "pay-1", network: "SUR", operationCode: "SUR-20260805-1", amount: INSTALMENT, paidAtSim: "2026-08-05T09:00:00-03:00", allocations: [{ instalment: 1, amount: INSTALMENT }] },
          { paymentId: "pay-2", network: "SUR", operationCode: "SUR-20260910-2", amount: INSTALMENT, paidAtSim: "2026-09-10T09:00:00-03:00", allocations: [{ instalment: 2, amount: INSTALMENT }] },
        ],
      },
    ],
    charges: [{ chargeId: "chg-punit", feeCode: "FEE-PUNIT", amount: chargeAmount, chargedAtSim: "2026-09-11T00:05:00-03:00", loanId: "L-0001", instalment: 2 }],
    movements: [
      { movementId: "mov-chg", kind: "CHARGE", atSim: "2026-09-11T00:05:00-03:00", amount: chargeAmount, ref: { loanId: "L-0001", instalment: 2, chargeId: "chg-punit" } },
      { movementId: "mov-dbt-a", kind: "DEBIT", atSim: "2026-10-05T06:00:00-03:00", amount: DEBIT, ref: { loanId: "L-0001", instalment: 3, debitId: "dbt-3a" } },
      { movementId: "mov-dbt-b", kind: "DEBIT", atSim: "2026-10-06T06:00:00-03:00", amount: DEBIT, ref: { loanId: "L-0001", instalment: 3, debitId: "dbt-3b" } },
    ],
    ...overrides,
  };
}

const other: CustomerSpec = {
  customerId: OTHER_CUSTOMER,
  phoneHash: "c".repeat(64),
  charges: [{ chargeId: "chg-other", feeCode: "FEE-CARD-REPL", amount: 250_000, chargedAtSim: "2026-09-20T10:00:00-03:00" }],
  movements: [{ movementId: "mov-other", kind: "CHARGE", atSim: "2026-09-20T10:00:00-03:00", amount: 250_000, ref: { chargeId: "chg-other" } }],
};

describe("[FL-032] correct charge: grounded explanation", () => {
  it("[FL-032] check_charge answers the core's CORRECT verdict with its clauses, leaves a CHARGE_CHECK evidence and keeps it in TURN#", async () => {
    const expected = lateInterestFor(INSTALMENT, 0.9, 5);
    const kit = await investigationKit([customer(expected)], { type: "UNRECOGNIZED_CHARGE" });
    const answer = okOf(await kit.call("check_charge", { chargeId: "chg-punit" }));
    expect(answer).toMatchObject({ verdict: "CORRECT", feeCode: "FEE-PUNIT", clauseIds: ["T-3.2", "T-3.4"], reason: "MATCHES_SCHEDULE", reasonText: CHARGE_REASON_TEXT.MATCHES_SCHEDULE });
    expect(answer["charged"]).toEqual(answer["expected"]);
    const [evidence] = (await kit.connector.caseItems.listEvidence(WORLD, kit.complaint.complaintId)).filter((item) => item.kind === "CHARGE_CHECK");
    expect(evidence).toMatchObject({ evidenceId: answer["evidenceId"], refId: answer["chargeCheckId"], actor: "AGENT", turnId: kit.turnId, details: { chargeId: "chg-punit", verdict: "CORRECT", expectedAmount: expected } });
    const results = await kit.connector.sessions.listTurnResults(WORLD, kit.turnId);
    expect(results.map((row) => row.tool)).toEqual(["check_charge"]);
    expect((await kit.auditRows()).find((row) => row.action === "CHECK_CHARGE")).toMatchObject({ outcome: "CORRECT", refs: { chargeId: "chg-punit" } });
  });

  it("[FL-032] a charge the schedule does not support is WRONG with the expected amount: the evidence reverse_charge needs", async () => {
    const kit = await investigationKit([customer(500_000_00)], { type: "UNRECOGNIZED_CHARGE" });
    const answer = okOf(await kit.call("check_charge", { chargeId: "chg-punit" }));
    expect(answer).toMatchObject({ verdict: "WRONG", reason: "AMOUNT_DIFFERS" });
    const evidence = await kit.connector.caseItems.getEvidence(WORLD, kit.complaint.complaintId, String(answer["evidenceId"]));
    expect(evidence?.details).toMatchObject({ verdict: "WRONG", chargeId: "chg-punit" });
  });

  it("[FL-032] a charge of another customer is FORBIDDEN and audited; without identification or complaint nothing is read", async () => {
    const kit = await investigationKit([customer(100_000), other], { type: "UNRECOGNIZED_CHARGE" });
    expect(codeOf(await kit.call("check_charge", { chargeId: "chg-other" }))).toBe("FORBIDDEN");
    expect((await kit.auditRows()).find((row) => row.action === "DENY")).toMatchObject({ ruleIds: ["LAM-SCOPE"] });
    expect(codeOf(await kit.call("check_charge", { chargeId: "chg-punit", capOverride: "999" }))).toBe("INVALID");

    const fresh = await kit.openTurn();
    expect(codeOf(await kit.call("check_charge", { chargeId: "chg-punit" }, fresh.token))).toBe("COMPLAINT_REQUIRED");
    kit.advanceReal(31 * 60_000);
    const later = await kit.openTurn({ complaintIds: [kit.complaint.complaintId] });
    expect(codeOf(await kit.call("check_charge", { chargeId: "chg-punit" }, later.token))).toBe("NOT_IDENTIFIED");
    expect(await kit.connector.caseItems.listEvidence(WORLD, kit.complaint.complaintId)).toEqual([]);
  });
});

describe("[FL-032] a charge an earlier complaint already reversed", () => {
  it("[FL-032] check_charge keeps the verdict and says alreadyReversed with the credit note and date; list_operations marks the charge", async () => {
    const kit = await investigationKit([customer(500_000_00)], { type: "UNRECOGNIZED_CHARGE" });
    const done = await kit.coreClient.call("reverseCharge", { worldId: WORLD, simNow: "2026-09-21T11:59:00-03:00" }, { params: { chargeId: "chg-punit" }, body: { customerId: CUSTOMER, complaintId: "cmp-earlier", idempotencyKey: "cmp-earlier:chk", cap: 500_000_00, referenceRate: 0.38 } });
    const answer = okOf(await kit.call("check_charge", { chargeId: "chg-punit" }));
    expect(answer).toMatchObject({
      verdict: "WRONG",
      alreadyReversed: { creditNoteId: done.creditNoteId, reversed: { amount: done.amount / 100 }, reversedAtText: "lunes 21/09 11:59" },
    });
    const evidence = await kit.connector.caseItems.getEvidence(WORLD, kit.complaint.complaintId, String(answer["evidenceId"]));
    expect(evidence?.details).toMatchObject({ verdict: "WRONG", reversedCreditNoteId: done.creditNoteId });

    const account = createAccountTarget(kit.toolDeps, { core: kit.core });
    const listed = okOf(await account.handle({ sessionToken: kit.token, kind: "CHARGE", fromDate: "2026-09-01" }, gatewayContext("account___list_operations")));
    expect(listed["operations"]).toEqual([expect.objectContaining({ operationId: "mov-chg", alreadyReversed: true, ref: { loanId: "L-0001", instalment: 2, chargeId: "chg-punit" } })]);
  });
});

describe("[FL-032] the charge check lands on the charge complaint", () => {
  it("[FL-032] with a newer payment complaint open, check_charge files its CHARGE_CHECK on the charge complaint and nothing on the newer one", async () => {
    const kit = await investigationKit([customer(500_000_00)], { type: "UNRECOGNIZED_CHARGE" });
    const newer = await kit.addComplaint({ type: "PAYMENT_NOT_REFLECTED" });
    const turn = await kit.openTurn({ complaintIds: [kit.complaint.complaintId, newer.complaintId] });
    const answer = okOf(await kit.call("check_charge", { chargeId: "chg-punit" }, turn.token));
    expect((await kit.connector.caseItems.listEvidence(WORLD, kit.complaint.complaintId)).map((item) => item.evidenceId)).toEqual([answer["evidenceId"]]);
    expect(await kit.connector.caseItems.listEvidence(WORLD, newer.complaintId)).toEqual([]);
  });
});

describe("[FL-037] duplicate debit check", () => {
  it("[FL-037] check_duplicate_debit finds the instalment debited twice, with the debits and the refundable amount, defaulting to the customer's only loan", async () => {
    const kit = await investigationKit([customer(100_000)], { type: "DUPLICATE_DEBIT" });
    const answer = okOf(await kit.call("check_duplicate_debit", { instalment: 3 }));
    expect(answer).toMatchObject({ verdict: "DUPLICATE", refundable: { amount: 72_300, text: "$ 72.300,00" } });
    expect(answer["debits"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ debitId: "dbt-3a", instalment: 3, atText: "lunes 05/10 06:00", amount: { amount: 72_300, text: "$ 72.300,00" } }),
        expect.objectContaining({ debitId: "dbt-3b", instalment: 3, atText: "martes 06/10 06:00" }),
      ]),
    );
    const evidence = await kit.connector.caseItems.getEvidence(WORLD, kit.complaint.complaintId, String(answer["evidenceId"]));
    expect(evidence).toMatchObject({ kind: "DUPLICATE_CHECK", refId: answer["duplicateCheckId"], details: { verdict: "DUPLICATE", loanId: "L-0001", instalment: 3, duplicateDebitId: "dbt-3b" } });
  });

  it("[FL-037] a loan of someone else is FORBIDDEN", async () => {
    const kit = await investigationKit([customer(100_000), { ...other, loans: [{ loanId: "L-0099", principal: 1_000_000, instalments: [{ number: 1, dueDate: "2026-10-05", amount: 100_000 }, { number: 2, dueDate: "2026-11-05", amount: 100_000 }, { number: 3, dueDate: "2026-12-05", amount: 100_000 }] }] }]);
    expect(codeOf(await kit.call("check_duplicate_debit", { loanId: "L-0099" }))).toBe("FORBIDDEN");
  });

  it("[FL-039] two debits of the same amount of different instalments are NOT_DUPLICATE, with both debits in the evidence", async () => {
    const movements = [
      { movementId: "mov-d5", kind: "DEBIT" as const, atSim: "2026-10-02T06:00:00-03:00", amount: DEBIT, ref: { loanId: "L-0001", instalment: 2, debitId: "dbt-2" } },
      { movementId: "mov-d6", kind: "DEBIT" as const, atSim: "2026-10-02T06:05:00-03:00", amount: DEBIT, ref: { loanId: "L-0001", instalment: 3, debitId: "dbt-3" } },
    ];
    const kit = await investigationKit([customer(100_000, { movements })], { type: "DUPLICATE_DEBIT" });
    const answer = okOf(await kit.call("check_duplicate_debit", { loanId: "L-0001" }));
    expect(answer).toMatchObject({ verdict: "NOT_DUPLICATE", refundable: { amount: 0 } });
    const evidence = await kit.connector.caseItems.getEvidence(WORLD, kit.complaint.complaintId, String(answer["evidenceId"]));
    expect(evidence?.details).toMatchObject({ verdict: "NOT_DUPLICATE", debits: expect.arrayContaining([expect.objectContaining({ debitId: "dbt-2", instalment: 2 }), expect.objectContaining({ debitId: "dbt-3", instalment: 3 })]) });
  });
});
