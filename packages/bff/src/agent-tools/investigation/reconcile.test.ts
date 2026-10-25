import { describe, expect, it } from "vitest";
import type { CustomerSpec } from "@reclamo/core-mock/ledger/testing";
import type { CollectionRequest } from "@reclamo/core-contract";
import { OTHER_CUSTOMER } from "../common/testing";
import { CUSTOMER, WORLD, monthlyInstalments } from "../account/testing";
import { batchOwnerKey, recheckTimerId } from "./recheck";
import { codeOf, investigationKit, okOf, operationCode } from "./testing";

const CODE = operationCode("NTE", "20261006", "004817");
const AMOUNT = 11_864_000;
const LOAN = { loanId: "L-0001", principal: 60_000_000, instalments: monthlyInstalments() };

function customer(overrides: Partial<CustomerSpec> = {}): CustomerSpec {
  return { customerId: CUSTOMER, balance: 2_000_000, loans: [LOAN], ...overrides };
}

const otherPayer: CustomerSpec = { customerId: OTHER_CUSTOMER, phoneHash: "9".repeat(64), loans: [{ loanId: "L-0099", principal: 60_000_000, instalments: monthlyInstalments() }] };

function collection(overrides: Partial<CollectionRequest> = {}): CollectionRequest {
  return { network: "NORTE", operationCode: CODE, paidAtSim: "2026-10-06T14:00:00-03:00", amount: AMOUNT, customerRef: CUSTOMER, loanRef: "L-0001", instalment: 3, terminal: "T-0412", ...overrides };
}

/** An identified session with a payment complaint and a READ reading of the receipt (`rdg-1`). */
async function setup(customers: readonly CustomerSpec[] = [customer()], paidAtLocal = "2026-10-06T14:00") {
  const kit = await investigationKit(customers, { type: "PAYMENT_NOT_REFLECTED" });
  await kit.addEvidence({
    evidenceId: "evd-rdg-1",
    kind: "RECEIPT_READING",
    refId: "rdg-1",
    details: { result: "READ", source: "BEDROCK", suspiciousText: false, fields: { network: "NORTE", operationCode: CODE, amount: AMOUNT, paidAtLocal } },
  });
  return kit;
}

async function settlementMatch(kit: Awaited<ReturnType<typeof setup>>) {
  return (await kit.connector.caseItems.listEvidence(WORLD, kit.complaint.complaintId)).filter((item) => item.kind === "SETTLEMENT_MATCH");
}

describe("[FL-016] happy path: legible receipt and published batch", () => {
  it("[FL-016] reconcile_payment finds the customer's own line in the published settlement: MATCHED, with the line kept as evidence", async () => {
    const kit = await setup();
    await kit.collect(collection());
    await kit.publish("NORTE", "2026-10-06", "2026-10-07T08:30:00-03:00");
    const answer = okOf(await kit.call("reconcile_payment", { readingId: "rdg-1" }));
    expect(answer).toMatchObject({ result: "MATCHED", source: "SETTLEMENT", match: { network: "NORTE", operationCode: CODE, amount: { text: "$ 118.640,00" }, businessDateText: "martes 06/10", batchSha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const [evidence] = await settlementMatch(kit);
    expect(evidence).toMatchObject({ refId: answer["reconciliationId"], evidenceId: answer["evidenceId"], details: { result: "MATCHED", line: { customerRef: CUSTOMER, loanRef: "L-0001", operationCode: CODE, amount: AMOUNT } } });
    expect((await kit.auditRows()).find((row) => row.action === "RECONCILE_PAYMENT")).toMatchObject({ outcome: "MATCHED" });
  });

  it("[FL-016] a settlement reconciliation needs a READ reading of this complaint: none, one of another complaint or an extra key is refused", async () => {
    const kit = await setup();
    await kit.addComplaint({ complaintId: "cmp-x", complaintNumber: "R-2026-000099" });
    await kit.addEvidence({ complaintId: "cmp-x", evidenceId: "evd-rdg-x", kind: "RECEIPT_READING", refId: "rdg-x", details: { result: "READ" } });
    expect(codeOf(await kit.call("reconcile_payment", {}))).toBe("INVALID");
    expect(codeOf(await kit.call("reconcile_payment", { source: "SETTLEMENT" }))).toBe("INVALID");
    expect(codeOf(await kit.call("reconcile_payment", { readingId: "rdg-x" }))).toBe("FORBIDDEN");
    expect(codeOf(await kit.call("reconcile_payment", { readingId: "rdg-1", customerRef: OTHER_CUSTOMER }))).toBe("INVALID");
    expect(await settlementMatch(kit)).toEqual([]);
  });
});

describe("[FL-017] pending batch: reconciled when the network settles", () => {
  it("[FL-017] a payment after the cut-off waits for the next batch: PENDING_BATCH with when the network publishes, and one SETTLEMENT_RECHECK owned by the batch", async () => {
    const kit = await setup([customer()], "2026-10-06T18:40");
    await kit.collect(collection({ paidAtSim: "2026-10-06T18:40:00-03:00" }));
    const answer = okOf(await kit.call("reconcile_payment", { readingId: "rdg-1" }));
    expect(answer).toMatchObject({ result: "PENDING_BATCH", pendingBatch: { network: "NORTE", publishAtText: "jueves 08/10 08:30" } });
    const timerId = recheckTimerId(kit.complaint.complaintId, { network: "NORTE", businessDate: "2026-10-07" });
    expect(answer["recheckTimerId"]).toBe(timerId);
    const timers = await kit.connector.timers.listByOwner(WORLD, batchOwnerKey({ network: "NORTE", businessDate: "2026-10-07" }));
    expect(timers).toEqual([expect.objectContaining({ kind: "SETTLEMENT_RECHECK", timerId, status: "SCHEDULED", payload: { complaintId: kit.complaint.complaintId, customerId: CUSTOMER } })]);
    expect(Date.parse(timers[0]?.dueAtSim ?? "")).toBe(Date.parse("2026-10-08T10:30:00-03:00"));

    okOf(await kit.call("reconcile_payment", { readingId: "rdg-1" }));
    expect(await kit.connector.timers.listByOwner(WORLD, batchOwnerKey({ network: "NORTE", businessDate: "2026-10-07" }))).toHaveLength(1);
  });
});

describe("[FL-018] published batch without the line: never found", () => {
  it("[FL-018] a code that is not in the published settlement is NOT_FOUND, with the batches reviewed and nothing applied", async () => {
    const kit = await setup();
    await kit.collect(collection({ operationCode: operationCode("NTE", "20261006", "000001") }));
    await kit.publish("NORTE", "2026-10-06", "2026-10-07T08:30:00-03:00");
    const answer = okOf(await kit.call("reconcile_payment", { readingId: "rdg-1" }));
    expect(answer).toMatchObject({ result: "NOT_FOUND" });
    expect(answer).not.toHaveProperty("match");
    const [evidence] = await settlementMatch(kit);
    expect(evidence?.details).toMatchObject({ result: "NOT_FOUND", reviewed: [expect.objectContaining({ network: "NORTE", businessDate: "2026-10-06", status: "PUBLISHED" })] });
    expect(kit.coreCalls.filter((call) => call.includes("/payments"))).toEqual([]);
  });
});

describe("[FL-022] payment already applied", () => {
  it("[FL-022] a code already applied to this customer is ALREADY_APPLIED with the date it was applied", async () => {
    const applied = { ...LOAN, payments: [{ paymentId: "pay-4", network: "NORTE" as const, operationCode: CODE, amount: AMOUNT, paidAtSim: "2026-10-06T14:00:00-03:00", allocations: [{ instalment: 3, amount: AMOUNT }] }] };
    const kit = await setup([customer({ loans: [applied] })]);
    const answer = okOf(await kit.call("reconcile_payment", { readingId: "rdg-1" }));
    expect(answer).toMatchObject({ result: "ALREADY_APPLIED", appliedAtText: "martes 06/10 14:00" });
    expect(kit.gate.requests).toEqual([]);
  });
});

describe("[FL-026] payment by transfer or from the wallet", () => {
  it("[FL-026] a wallet payment of the customer's loan is MATCHED against the movement, with no network settlement", async () => {
    const movements = [{ movementId: "mov-wallet-pay", kind: "PAYMENT" as const, atSim: "2026-10-05T09:15:00-03:00", amount: AMOUNT, ref: { loanId: "L-0001", instalment: 3 } }];
    const kit = await setup([customer({ movements })]);
    const answer = okOf(await kit.call("reconcile_payment", { source: "WALLET", movementId: "mov-wallet-pay" }));
    expect(answer).toMatchObject({ result: "MATCHED", source: "WALLET", match: { network: "WALLET", operationCode: "mov-wallet-pay", amount: { text: "$ 118.640,00" }, paidAtText: "lunes 05/10 09:15" } });
    expect((await settlementMatch(kit))[0]?.details).toMatchObject({ result: "MATCHED", source: "WALLET", movementId: "mov-wallet-pay" });
  });

  it("[FL-026] a movement that is not the customer's is FORBIDDEN; WALLET without a movement is INVALID", async () => {
    const kit = await setup();
    expect(codeOf(await kit.call("reconcile_payment", { source: "WALLET", movementId: "mov-someone" }))).toBe("FORBIDDEN");
    expect(codeOf(await kit.call("reconcile_payment", { source: "WALLET" }))).toBe("INVALID");
  });
});

describe("[FL-111] valid receipt of another payer", () => {
  it("[FL-111] a line of another customer is PAYER_MISMATCH: nothing of the other payer comes back and the code hands the complaint to a person (RECEIPT_DOUBT)", async () => {
    const kit = await setup([customer(), otherPayer]);
    await kit.collect(collection({ customerRef: OTHER_CUSTOMER, loanRef: "L-0099" }));
    await kit.publish("NORTE", "2026-10-06", "2026-10-07T08:30:00-03:00");
    const answer = okOf(await kit.call("reconcile_payment", { readingId: "rdg-1" }));
    expect(answer).toMatchObject({ result: "PAYER_MISMATCH", handedOver: true });
    expect(answer).not.toHaveProperty("match");
    expect(answer).not.toHaveProperty("appliedAtText");
    expect(JSON.stringify(answer)).not.toMatch(/cus-0002|L-0099|T-0412/);

    const complaint = await kit.connector.complaints.get(WORLD, kit.complaint.complaintId);
    expect(complaint).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RECEIPT_DOUBT" } });
    expect(complaint?.statusHistory.at(-1)).toMatchObject({ to: "HUMAN_REVIEW", cause: "PAYER_MISMATCH", actor: "SYSTEM" });
    expect(kit.gate.requests).toEqual([expect.objectContaining({ kind: "HANDOFF_NOTICE", sender: "SYSTEM", complaintId: kit.complaint.complaintId })]);
    expect(answer["handoffNoticeMessageId"]).toBe(kit.gate.requests[0]?.messageId);
    expect(kit.gate.requests[0]?.text).not.toMatch(/cus-0002|L-0099/);
    const actions = (await kit.auditRows()).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["PAYER_MISMATCH", "RECONCILE_PAYMENT"]));
    expect(JSON.stringify((await settlementMatch(kit))[0]?.details)).not.toMatch(/cus-0002|L-0099/);
  });

  it("[FL-111] a code already applied to another customer is PAYER_MISMATCH too, never that customer's date", async () => {
    const theirs = { ...otherPayer, loans: [{ loanId: "L-0099", principal: 60_000_000, instalments: monthlyInstalments(), payments: [{ paymentId: "pay-x", network: "NORTE" as const, operationCode: CODE, amount: AMOUNT, paidAtSim: "2026-10-06T14:00:00-03:00", allocations: [{ instalment: 3, amount: AMOUNT }] }] }] };
    const kit = await setup([customer(), theirs]);
    await kit.collect(collection({ customerRef: OTHER_CUSTOMER, loanRef: "L-0099" }));
    await kit.publish("NORTE", "2026-10-06", "2026-10-07T08:30:00-03:00");
    const answer = okOf(await kit.call("reconcile_payment", { readingId: "rdg-1" }));
    expect(answer["result"]).toBe("PAYER_MISMATCH");
    expect(answer).not.toHaveProperty("appliedAtText");
  });
});
