import { describe, expect, it } from "vitest";
import type { CustomerSpec } from "@reclamo/core-mock/ledger/testing";
import type { Evidence } from "../../domain/case-items";
import type { NewOf } from "../../connector/codec";
import { gatewayContext } from "../common/principal";
import { GATEWAY_TOOLS } from "../common/targets";
import { WORLD } from "../common/testing";
import { createActionsTarget } from "./handler";
import { type EffectWorld, effectWorld, withCaps } from "./testing";

const INSTALMENT = 11_864_000;
const DUPLICATE = 7_230_000;

const debit = (debitId: string, atSim: string) => ({ movementId: `mov-${debitId}`, kind: "DEBIT" as const, atSim, amount: DUPLICATE, ref: { loanId: "L-0025", instalment: 6, debitId } });

const CUSTOMER: CustomerSpec = {
  customerId: "cus-0001",
  balance: 1_000_000,
  loans: [
    {
      loanId: "L-0001",
      principal: 96_000_000,
      instalments: Array.from({ length: 12 }, (_, index) => ({ number: index + 1, dueDate: `${index + 7 > 12 ? 2027 : 2026}-${String(((index + 6) % 12) + 1).padStart(2, "0")}-05`, amount: INSTALMENT, paid: index < 3 ? INSTALMENT : 0 })),
    },
    { loanId: "L-0025", principal: 50_000_000, instalments: [5, 6, 7].map((number) => ({ number, dueDate: `2026-${String(number + 4).padStart(2, "0")}-02`, amount: DUPLICATE, paid: number < 7 ? DUPLICATE : 0 })) },
  ],
  movements: [debit("dbt-6a", "2026-10-02T06:00:00-03:00"), debit("dbt-6b", "2026-10-03T06:00:00-03:00")],
  charges: [
    { chargeId: "chg-card", feeCode: "FEE-CARD-REPL", amount: 250_000, chargedAtSim: "2026-10-01T09:00:00-03:00" },
    { chargeId: "chg-ins", feeCode: "FEE-INS", amount: 3_890_000, chargedAtSim: "2026-10-02T09:00:00-03:00" },
  ],
  transfers: [
    { transferId: "trf-0001", amount: 5_000_000, status: "REJECTED_NOT_REVERSED" },
    { transferId: "trf-0002", amount: 5_000_000, status: "REJECTED_NOT_REVERSED" },
  ],
};

function settlementMatch(amount = INSTALMENT, overrides: Record<string, unknown> = {}): NewOf<typeof Evidence>["details"] {
  return {
    result: "MATCHED",
    source: "SETTLEMENT",
    line: { network: "NORTE", businessDate: "2026-10-07", operationCode: "NTE-20261006-004817-7", paidAt: "2026-10-06T18:40:00-03:00", amount, customerRef: "cus-0001", loanRef: "L-0001", instalment: 4, terminal: "T-0412" },
    ...overrides,
  };
}

interface Case {
  readonly world: EffectWorld & { target: ReturnType<typeof createActionsTarget> };
}

async function actionsWorld(settings?: Parameters<typeof effectWorld>[1]): Promise<Case["world"]> {
  const world = await effectWorld([CUSTOMER], settings);
  const target = createActionsTarget(world.deps, { core: () => world.core.client, networks: () => world.networks.client, complaints: world.complaintsDeps });
  return Object.assign(world, { target });
}

/** A complaint of the session with its evidence, the customer identified, a turn open. */
async function openCase(world: Case["world"], complaint: Parameters<EffectWorld["addComplaint"]>[0], evidence: Parameters<EffectWorld["addEvidence"]>[0][] = []) {
  const created = await world.addComplaint(complaint);
  for (const item of evidence) await world.addEvidence({ complaintId: created.complaintId, ...item });
  const turn = await world.openTurn({ complaintIds: [created.complaintId] });
  await world.identify();
  return { complaint: created, turn };
}

function call(world: Case["world"], tool: string, token: string, input: Record<string, unknown>) {
  return world.target.handle({ sessionToken: token, ...input }, gatewayContext(`actions___${tool}`));
}

async function instalment(world: Case["world"], loanId: string, number: number) {
  const list = await world.core.client.call("listInstalments", { worldId: WORLD, simNow: "2026-10-07T10:10:00-03:00" }, { params: { loanId } });
  return list.instalments.find((item) => item.number === number);
}

describe("apply_payment [FL-016] [FL-024]", () => {
  it("[FL-016] within the cap: the core imputes the instalment once with OPC#, the amount from the matched line", async () => {
    const world = await actionsWorld();
    const { complaint, turn } = await openCase(world, {}, [{ evidenceId: "evd-rec-1", refId: "rcn-1", kind: "SETTLEMENT_MATCH", details: settlementMatch() }]);
    const answer = await call(world, "apply_payment", turn.token, { reconciliationId: "rcn-1" });
    expect(answer).toMatchObject({ ok: true, applied: { amount: 118_640, text: "$ 118.640,00" }, allocations: [{ instalment: 4, statusAfter: "PAID" }] });
    expect((await instalment(world, "L-0001", 4))?.status).toBe("PAID");
    const actions = await world.connector.caseItems.listActions(WORLD, complaint.complaintId);
    expect(actions).toEqual([expect.objectContaining({ kind: "APPLY_PAYMENT", status: "EXECUTED", amountCents: INSTALMENT, claimKey: "OPC#NORTE#NTE-20261006-004817-7", evidenceId: "evd-rec-1", actor: "AGENT" })]);
    expect((await world.auditRows()).filter((row) => row.action === "APPLY_PAYMENT")).toEqual([expect.objectContaining({ outcome: "EXECUTED", ruleIds: ["LAM-EVIDENCE", "LAM-CAP"] })]);
    // The same call again replays the core's first answer: one action, one imputation.
    const again = await call(world, "apply_payment", turn.token, { reconciliationId: "evd-rec-1" });
    expect(again).toMatchObject({ ok: true, actionId: (answer as unknown as { actionId: string }).actionId });
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toHaveLength(1);
  });

  it("[FL-024] above the agent's cap: ABOVE_CAP with action, tier and amount; nothing moves; the approval marker stays", async () => {
    const world = await actionsWorld();
    const { complaint, turn } = await openCase(world, {}, [{ evidenceId: "evd-rec-2", refId: "rcn-2", kind: "SETTLEMENT_MATCH", details: settlementMatch(31_240_000) }]);
    const answer = await call(world, "apply_payment", turn.token, { reconciliationId: "rcn-2" });
    expect(answer).toMatchObject({ ok: false, error: { code: "ABOVE_CAP", reason: "AMOUNT_ABOVE_AGENT_CAP" }, capAction: "APPLY_PAYMENT", capTier: "OPERATOR", amount: { amount: 312_400, text: "$ 312.400,00" } });
    expect((await instalment(world, "L-0001", 4))?.status).not.toBe("PAID");
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([]);
    const marker = await world.connector.claims.getIdempotency(WORLD, "ABOVE_CAP", "evd-rec-2");
    expect(marker?.result).toMatchObject({ capAction: "APPLY_PAYMENT", capTier: "OPERATOR", amountCents: 31_240_000 });
  });

  it("a third automatic reversal in 30 simulated days needs an operator whatever the amount (MONTHLY_AUTO_LIMIT)", async () => {
    const world = await actionsWorld();
    const { complaint, turn } = await openCase(world, { type: "UNRECOGNIZED_CHARGE" }, [{ evidenceId: "evd-chk-m", refId: "chk-m", kind: "CHARGE_CHECK", details: { verdict: "WRONG", chargeId: "chg-card" } }]);
    for (const id of ["act-old-1", "act-old-2"]) {
      await world.connector.caseItems.putAction({ worldId: WORLD, complaintId: complaint.complaintId, actionId: id, kind: "REVERSE_CHARGE", status: "EXECUTED", amountCents: 1_000, idempotencyKey: id, atSim: "2026-10-01T10:00:00-03:00", actor: "AGENT" });
    }
    expect(await call(world, "reverse_charge", turn.token, { chargeCheckId: "chk-m" })).toMatchObject({ ok: false, error: { code: "ABOVE_CAP", reason: "MONTHLY_AUTO_LIMIT" }, capTier: "OPERATOR" });
  });
});

describe("LAM-EVIDENCE, LAM-SCOPE and LAM-STRICT on the money tools", () => {
  it("an evidence of another kind, a reconciliation that is not MATCHED or a line of another payer moves nothing", async () => {
    const world = await actionsWorld();
    const { complaint, turn } = await openCase(world, {}, [
      { evidenceId: "evd-read", refId: "rdg-1", kind: "RECEIPT_READING", details: { result: "READ" } },
      { evidenceId: "evd-pend", refId: "rcn-pend", kind: "SETTLEMENT_MATCH", details: { result: "PENDING_BATCH", source: "SETTLEMENT" } },
      { evidenceId: "evd-other", refId: "rcn-other", kind: "SETTLEMENT_MATCH", details: settlementMatch(INSTALMENT, { line: { ...(settlementMatch().line as object), customerRef: "cus-0002" } }) },
    ]);
    expect(await call(world, "apply_payment", turn.token, { reconciliationId: "rdg-1" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED", reason: "EVIDENCE_KIND" } });
    expect(await call(world, "apply_payment", turn.token, { reconciliationId: "rcn-pend" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED", reason: "EVIDENCE_RESULT" } });
    expect(await call(world, "apply_payment", turn.token, { reconciliationId: "rcn-other" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED", reason: "PAYER_MISMATCH" } });
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([]);
  });

  it("an evidence of no complaint of the session is FORBIDDEN, and capOverride is never accepted", async () => {
    const world = await actionsWorld();
    const other = await world.addComplaint();
    await world.addEvidence({ complaintId: other.complaintId, evidenceId: "evd-foreign", refId: "rcn-foreign", kind: "SETTLEMENT_MATCH", details: settlementMatch() });
    const { turn } = await openCase(world, {}, [{ evidenceId: "evd-own", refId: "rcn-own", kind: "SETTLEMENT_MATCH", details: settlementMatch() }]);
    expect(await call(world, "apply_payment", turn.token, { reconciliationId: "rcn-foreign" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await call(world, "apply_payment", turn.token, { reconciliationId: "rcn-own", capOverride: "SUPERVISOR" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect((await instalment(world, "L-0001", 4))?.status).not.toBe("PAID");
  });
});

describe("reverse_charge [FL-033] [FL-034]", () => {
  it("[FL-033] a WRONG charge within the cap: reversal with compensatory interest, credit note, refund register entry", async () => {
    const world = await actionsWorld();
    const { complaint, turn } = await openCase(world, { type: "UNRECOGNIZED_CHARGE" }, [{ evidenceId: "evd-chk", refId: "chk-1", kind: "CHARGE_CHECK", details: { verdict: "WRONG", chargeId: "chg-card" } }]);
    const answer = await call(world, "reverse_charge", turn.token, { chargeCheckId: "chk-1" });
    expect(answer).toMatchObject({ ok: true, reversed: { amount: 2_500 }, rateLabel: "supuesto" });
    const { creditNoteId } = answer as unknown as { creditNoteId: string };
    const refunds = await world.connector.chains.listRegister("RRI", WORLD, 1);
    expect(refunds.entries).toEqual([expect.objectContaining({ cause: "REVERSE_CHARGE", complaintId: complaint.complaintId, amountCents: 250_000, creditNoteId, product: "FEE-CARD-REPL" })]);
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([expect.objectContaining({ kind: "REVERSE_CHARGE", status: "EXECUTED", coreRef: creditNoteId, claimKey: "REV#chg-card" })]);
    expect(world.anchors.some((request) => request.chain === "RRI")).toBe(true);
    // The same complaint asking again gets the core's replay of its own reversal, never ALREADY_REVERSED.
    expect(await call(world, "reverse_charge", turn.token, { chargeCheckId: "chk-1" })).toMatchObject({ ok: true, creditNoteId });
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toHaveLength(1);
  });

  it("[FL-033] LAM-EVIDENCE: a charge check that did not find the charge WRONG reverses nothing", async () => {
    const world = await actionsWorld();
    const { complaint, turn } = await openCase(world, { type: "UNRECOGNIZED_CHARGE" }, [{ evidenceId: "evd-ok", refId: "chk-ok", kind: "CHARGE_CHECK", details: { verdict: "OK", chargeId: "chg-card" } }]);
    expect(await call(world, "reverse_charge", turn.token, { chargeCheckId: "chk-ok" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED", reason: "EVIDENCE_RESULT" } });
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([]);
  });

  it("[FL-034] above the operator's threshold of the world: ABOVE_CAP, nothing reversed", async () => {
    const world = await actionsWorld(withCaps({ REVERSE_CHARGE: { agentCents: 1_500_000, operatorCents: 10_000_000 } }));
    const { complaint, turn } = await openCase(world, { type: "UNRECOGNIZED_CHARGE" }, [{ evidenceId: "evd-ins", refId: "chk-ins", kind: "CHARGE_CHECK", details: { verdict: "WRONG", chargeId: "chg-ins" } }]);
    expect(await call(world, "reverse_charge", turn.token, { chargeCheckId: "chk-ins" })).toMatchObject({ ok: false, error: { code: "ABOVE_CAP" }, capAction: "REVERSE_CHARGE", capTier: "OPERATOR" });
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([]);
    expect((await world.connector.chains.listRegister("RRI", WORLD, 1)).entries).toEqual([]);
  });

  it("[FL-032] a charge an earlier complaint already reversed: ALREADY_REVERSED before the cap, no approval marker, nothing moves", async () => {
    const world = await actionsWorld(withCaps({ REVERSE_CHARGE: { agentCents: 1_500_000, operatorCents: 10_000_000 } }));
    const earlier = { worldId: WORLD, simNow: "2026-10-03T10:00:00-03:00" };
    const done = await world.core.client.call("reverseCharge", earlier, { params: { chargeId: "chg-ins" }, body: { customerId: "cus-0001", complaintId: "cmp-earlier", idempotencyKey: "cmp-earlier:chk", cap: 10_000_000, referenceRate: 0.38 } });
    const { complaint, turn } = await openCase(world, { type: "UNRECOGNIZED_CHARGE" }, [{ evidenceId: "evd-ins", refId: "chk-ins", kind: "CHARGE_CHECK", details: { verdict: "WRONG", chargeId: "chg-ins" } }]);
    expect(await call(world, "reverse_charge", turn.token, { chargeCheckId: "chk-ins" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", reason: "ALREADY_REVERSED" },
      creditNoteId: done.creditNoteId,
      reversed: { amount: 38_900 },
      reversedAtText: expect.stringContaining("03/10"),
    });
    expect(await world.connector.claims.getIdempotency(WORLD, "ABOVE_CAP", "evd-ins")).toBeUndefined();
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([]);
    expect((await world.connector.chains.listRegister("RRI", WORLD, 1)).entries).toEqual([]);
  });
});

describe("refund_duplicate_debit [FL-037] [FL-038]", () => {
  it("[FL-037] refunds the duplicate once; a second complaint on the same debit gets CONFLICT with the existing action", async () => {
    const world = await actionsWorld();
    const first = await openCase(world, { type: "DUPLICATE_DEBIT" }, [{ evidenceId: "evd-dup-1", refId: "dup-1", kind: "DUPLICATE_CHECK", details: { verdict: "DUPLICATE", loanId: "L-0025", instalment: 6 } }]);
    const refunded = await call(world, "refund_duplicate_debit", first.turn.token, { duplicateCheckId: "dup-1" });
    expect(refunded).toMatchObject({ ok: true, refunded: { amount: 72_300 } });
    const { actionId } = refunded as unknown as { actionId: string };

    const second = await world.addComplaint({ type: "DUPLICATE_DEBIT" });
    await world.addEvidence({ complaintId: second.complaintId, evidenceId: "evd-dup-2", refId: "dup-2", kind: "DUPLICATE_CHECK", details: { verdict: "DUPLICATE", loanId: "L-0025", instalment: 6 } });
    const turn = await world.openTurn({ complaintIds: [second.complaintId] });
    const conflict = await call(world, "refund_duplicate_debit", turn.token, { duplicateCheckId: "dup-2" });
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" }, actionId });
    expect(await world.connector.caseItems.listActions(WORLD, second.complaintId)).toEqual([expect.objectContaining({ status: "CONFLICT", coreRef: actionId, claimKey: "RFD#dbt-6b" })]);
    expect((await world.connector.chains.listRegister("RRI", WORLD, 1)).entries).toHaveLength(1);
  });

  it("[FL-038] above the agent's cap: ABOVE_CAP with the duplicate's amount, nothing refunded", async () => {
    const world = await actionsWorld(withCaps({ REFUND_DUPLICATE: { agentCents: 5_000_000, operatorCents: 20_000_000 } }));
    const { turn } = await openCase(world, { type: "DUPLICATE_DEBIT" }, [{ evidenceId: "evd-dup-3", refId: "dup-3", kind: "DUPLICATE_CHECK", details: { verdict: "DUPLICATE", loanId: "L-0025" } }]);
    expect(await call(world, "refund_duplicate_debit", turn.token, { duplicateCheckId: "dup-3" })).toMatchObject({ ok: false, error: { code: "ABOVE_CAP" }, capAction: "REFUND_DUPLICATE", amount: { amount: 72_300 } });
    expect((await world.connector.chains.listRegister("RRI", WORLD, 1)).entries).toEqual([]);
    // Above the cap only a person approves: no tool of any target approves or decides.
    expect((Object.values(GATEWAY_TOOLS).flat() as string[]).filter((tool) => /approv|decid/.test(tool))).toEqual(["request_operator_approval"]);
  });
});

describe("request_transfer_reversal [FL-044]", () => {
  it("[FL-044] reverses a REJECTED_NOT_REVERSED transfer once by TRV#; a second attempt is CONFLICT", async () => {
    const world = await actionsWorld();
    world.networks.mock.seedTransfer({ worldId: WORLD, transferId: "trf-0001", customerId: "cus-0001", direction: "OUT", amount: 5_000_000, status: "REJECTED_NOT_REVERSED", rejectReason: "Cuenta destino inexistente" });
    const details = { status: "REJECTED_NOT_REVERSED", transferId: "trf-0001", amount: 5_000_000 };
    const first = await openCase(world, { type: "TRANSFER_NOT_CREDITED" }, [{ evidenceId: "evd-trs-1", refId: "trs-1", kind: "TRANSFER_STATUS", details }]);
    const reversed = await call(world, "request_transfer_reversal", first.turn.token, { transferEvidenceId: "trs-1" });
    expect(reversed).toMatchObject({ ok: true, reversed: { amount: 50_000 }, creditedAtText: "miércoles 07/10" });
    const { actionId } = reversed as unknown as { actionId: string };
    expect((await world.connector.chains.listRegister("RRI", WORLD, 1)).entries).toEqual([expect.objectContaining({ cause: "TRANSFER_REVERSAL", amountCents: 5_000_000 })]);
    // The network confirmed it and the core credited the wallet once (claim TRV# on both sides).
    const wallet = async () => (await world.core.client.call("getCustomer", { worldId: WORLD, simNow: "2026-10-07T10:10:00-03:00" }, { params: { customerId: "cus-0001" } })).wallet.balance;
    expect(await wallet()).toBe(1_000_000 + 5_000_000);

    const second = await world.addComplaint({ type: "TRANSFER_NOT_CREDITED" });
    await world.addEvidence({ complaintId: second.complaintId, evidenceId: "evd-trs-2", refId: "trs-2", kind: "TRANSFER_STATUS", details });
    const turn = await world.openTurn({ complaintIds: [second.complaintId] });
    expect(await call(world, "request_transfer_reversal", turn.token, { transferEvidenceId: "trs-2" })).toMatchObject({ ok: false, error: { code: "CONFLICT" }, actionId });
    expect(await wallet()).toBe(1_000_000 + 5_000_000);
  });

  it("[FL-044] LAM-EVIDENCE and LAM-CAP: a transfer that is not REJECTED_NOT_REVERSED, or above the agent's cap, reverses nothing", async () => {
    const world = await actionsWorld(withCaps({ TRANSFER_REVERSAL: { agentCents: 1_000_000, operatorCents: 20_000_000 } }));
    world.networks.mock.seedTransfer({ worldId: WORLD, transferId: "trf-0002", customerId: "cus-0001", direction: "OUT", amount: 5_000_000, status: "REJECTED_NOT_REVERSED", rejectReason: "Cuenta destino inexistente" });
    const { complaint, turn } = await openCase(world, { type: "TRANSFER_NOT_CREDITED" }, [
      { evidenceId: "evd-trs-done", refId: "trs-done", kind: "TRANSFER_STATUS", details: { status: "COMPLETED", transferId: "trf-0002", amount: 5_000_000 } },
      { evidenceId: "evd-trs-big", refId: "trs-big", kind: "TRANSFER_STATUS", details: { status: "REJECTED_NOT_REVERSED", transferId: "trf-0002", amount: 5_000_000 } },
    ]);
    expect(await call(world, "request_transfer_reversal", turn.token, { transferEvidenceId: "trs-done" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED", reason: "EVIDENCE_RESULT" } });
    expect(await call(world, "request_transfer_reversal", turn.token, { transferEvidenceId: "trs-big" })).toMatchObject({ ok: false, error: { code: "ABOVE_CAP" }, capAction: "TRANSFER_REVERSAL", capTier: "OPERATOR", amount: { amount: 50_000 } });
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([]);
    expect((await world.connector.chains.listRegister("RRI", WORLD, 1)).entries).toEqual([]);
  });
});

describe("freeze_outgoing [FL-049] and request_account_closure [FL-053]", () => {
  it("[FL-049] freezes the wallet at once in an UNKNOWN_OPERATION complaint, and only there", async () => {
    const world = await actionsWorld();
    const { complaint, turn } = await openCase(world, { type: "UNKNOWN_OPERATION" });
    const answer = await call(world, "freeze_outgoing", turn.token, { reason: "UNKNOWN_OPERATION" });
    expect(answer).toMatchObject({ ok: true, frozenAtText: "miércoles 07/10 10:10" });
    const customer = await world.core.client.call("getCustomer", { worldId: WORLD, simNow: "2026-10-07T10:10:00-03:00" }, { params: { customerId: "cus-0001" } });
    expect(customer.wallet.outgoingFrozen).toBe(true);
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([expect.objectContaining({ kind: "FREEZE_OUTGOING", status: "EXECUTED" })]);
    const other = await openCase(world, { type: "PAYMENT_NOT_REFLECTED" });
    expect(await call(world, "freeze_outgoing", other.turn.token, { reason: "CUSTOMER_REQUEST" })).toMatchObject({ ok: false, error: { code: "NOT_ELIGIBLE" } });
  });

  it("[FL-053] closes only after the customer tapped the closure button; the core's conditions come back", async () => {
    const world = await actionsWorld();
    const { complaint, turn } = await openCase(world, { type: "CLOSURE_OR_EARLY_PAYOFF" });
    const nonce = (used: boolean, action: "CONFIRM_CLOSURE" | "WITHDRAW" = "CONFIRM_CLOSURE") => ({ worldId: WORLD, nonce: `n-${action}-${used}`, action, phoneHash: "a".repeat(64), customerId: "cus-0001", createdAtReal: "2026-10-07T13:00:00.000Z", ...(used ? { usedAtReal: "2026-10-07T13:05:00.000Z" } : {}) });
    for (const value of [nonce(false), nonce(true), nonce(true, "WITHDRAW")]) await world.connector.write(world.connector.claims.putNonceOp(value));
    expect(await call(world, "request_account_closure", turn.token, { confirmNonce: "n-CONFIRM_CLOSURE-false" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED" } });
    expect(await call(world, "request_account_closure", turn.token, { confirmNonce: "n-WITHDRAW-true" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED" } });
    const answer = await call(world, "request_account_closure", turn.token, { confirmNonce: "n-CONFIRM_CLOSURE-true" });
    expect(answer).toMatchObject({ ok: true, accountStatusAfter: "CLOSING" });
    expect((answer as unknown as { conditionsText: string[] }).conditionsText.length).toBeGreaterThan(0);
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([expect.objectContaining({ kind: "ACCOUNT_CLOSURE", status: "EXECUTED" })]);
  });
});
