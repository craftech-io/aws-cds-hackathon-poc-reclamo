// SC-05 (charges) and SC-06 (duplicate debits) on the run's model. The verdict comes from the core's fee
// table and debits, caps and tiers are code, money moves once by its claim: the oracles read the checks
// the model ran, the actions, the approvals and the wallet, never the wording.
import { describe, expect, it } from "vitest";
import { SCRIPTED_RUN, callsOf, errorCodesOf, okCallsOf, okResultOf, okResultsOf, openAgentWorld, toolsOf, turnsSummary } from "../support/agent-world";
import type { AgentWorld } from "../support/agent-world";
import { type Customer, actionsOf, complain, current, operatorApproves, pursueStatus, walletOf } from "../support/customer";
import { conversationProblems } from "../support/oracles";

const UNRECOGNIZED_CHARGE = "Me cobraron una comisión que no reconozco";
const DUPLICATE_DEBIT = "Me debitaron dos veces la misma cuota";
const FINISHED = ["ANSWERED", "CLOSED"];

async function filed(world: AgentWorld, customerId: string, text: string): Promise<Customer> {
  const complaint = await complain(world, customerId, text);
  if (complaint === undefined) throw new Error("the complaint was not filed");
  return { customerId, complaint };
}

const executed = async (world: AgentWorld, who: Customer, kind: string) => (await actionsOf(world, who.complaint)).filter((action) => action.kind === kind && action.status === "EXECUTED");
const pendingApprovals = async (world: AgentWorld, who: Customer) => (await world.flow.connector.caseItems.listPendingApprovals("demo")).filter((approval) => approval.complaintId === who.complaint.complaintId);

describe.skipIf(SCRIPTED_RUN)("charges and duplicate debits (agent)", () => {
  it("[SC-05/2] [FL-032] C22: a correct charge is explained from the terms, nothing reversed, not in favour", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0022", "Me cobraron un interés que no entiendo");
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    // The persona has more charges than the one it asks about: the model may check them all, in any order.
    expect(okResultsOf(world.agent.turns, "check_charge"), turnsSummary(world.agent.turns)).toContainEqual(expect.objectContaining({ verdict: "CORRECT", feeCode: "FEE-PUNIT" }));
    expect(toolsOf(world.agent.turns)).not.toContain("reverse_charge");
    expect(await actionsOf(world, who.complaint)).toEqual([]);
    expect((await current(world, who.complaint))?.outcome).toBe("NOT_IN_FAVOUR");
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-05/3] [FL-033] C02: a wrong charge within the cap is reversed once with its credit note", async () => {
    const world = await openAgentWorld();
    const before = walletOf(world, "cus-0002");
    const who = await filed(world, "cus-0002", UNRECOGNIZED_CHARGE);
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    // The customer does not say which charge: the model may check the correct one too, before or after.
    // What matters is that the check the reversal used is the WRONG one.
    const wrongChecks = okResultsOf(world.agent.turns, "check_charge").filter((check) => check.verdict === "WRONG").map((check) => check.chargeCheckId);
    const reversedWith = okCallsOf(world.agent.turns, "reverse_charge").map((call) => (call.input as { chargeCheckId?: unknown } | null)?.chargeCheckId);
    expect(wrongChecks, turnsSummary(world.agent.turns)).not.toEqual([]);
    expect(reversedWith).not.toEqual([]);
    expect(reversedWith.filter((chargeCheckId) => !wrongChecks.includes(chargeCheckId))).toEqual([]);
    expect(await executed(world, who, "REVERSE_CHARGE")).toHaveLength(1);
    expect(walletOf(world, "cus-0002")).toBeGreaterThan(before);
    expect(okResultOf(world.agent.turns, "answer_complaint_in_writing")?.attachments).toContain("CREDIT_NOTE");
    expect(await current(world, who.complaint)).toMatchObject({ outcome: "IN_FAVOUR" });
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-05/4-5] [FL-034] C23: above the agent's cap it asks an operator, never approves; the approval reverses once by code", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0023", UNRECOGNIZED_CHARGE);
    await pursueStatus(world, who.customerId, who.complaint, ["AWAITING_APPROVAL"], 1);

    expect(await pendingApprovals(world, who), turnsSummary(world.agent.turns)).toHaveLength(1);
    expect(await executed(world, who, "REVERSE_CHARGE")).toEqual([]);
    expect(callsOf(world.agent.turns, "request_operator_approval").filter((call) => call.status === "error")).toEqual([]);
    expect(await operatorApproves(world, who.complaint)).toBeDefined();
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(await executed(world, who, "REVERSE_CHARGE")).toHaveLength(1);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-05/7] [FL-036] C24: above the operator's tier the approval asked is the supervisor's", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0024", "Me cobraron dos veces la comisión de otorgamiento");
    await pursueStatus(world, who.customerId, who.complaint, ["AWAITING_APPROVAL"], 1);

    const [approval] = await pendingApprovals(world, who);
    expect(approval, turnsSummary(world.agent.turns)).toMatchObject({ capTier: "SUPERVISOR", decision: "PENDING" });
    expect(await executed(world, who, "REVERSE_CHARGE")).toEqual([]);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-06/2] [FL-037] C25: a duplicate debit within the cap is refunded once by its claim", async () => {
    const world = await openAgentWorld();
    const before = walletOf(world, "cus-0025");
    const who = await filed(world, "cus-0025", DUPLICATE_DEBIT);
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(okResultsOf(world.agent.turns, "check_duplicate_debit"), turnsSummary(world.agent.turns)).toContainEqual(expect.objectContaining({ verdict: "DUPLICATE" }));
    const refunds = await executed(world, who, "REFUND_DUPLICATE");
    expect(refunds).toEqual([expect.objectContaining({ claimKey: expect.stringMatching(/^RFD#/) })]);
    expect(walletOf(world, "cus-0025")).toBe(before + 7_230_000);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-06/3] [FL-038] C03: a duplicate above the cap waits for a person; approved, refunded once", async () => {
    const world = await openAgentWorld();
    const before = walletOf(world, "cus-0003");
    const who = await filed(world, "cus-0003", DUPLICATE_DEBIT);
    await pursueStatus(world, who.customerId, who.complaint, ["AWAITING_APPROVAL"], 1);

    expect(errorCodesOf(world.agent.turns, "refund_duplicate_debit").every((code) => code === "ABOVE_CAP"), turnsSummary(world.agent.turns)).toBe(true);
    expect(walletOf(world, "cus-0003")).toBe(before);
    expect(await operatorApproves(world, who.complaint)).toBeDefined();
    expect(walletOf(world, "cus-0003")).toBe(before + 14_630_000);
    expect(await executed(world, who, "REFUND_DUPLICATE")).toHaveLength(1);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-06/4] [FL-039] C26: two instalments of the same amount the same day are not a duplicate: no refund", async () => {
    const world = await openAgentWorld();
    const before = walletOf(world, "cus-0026");
    const who = await filed(world, "cus-0026", DUPLICATE_DEBIT);
    await pursueStatus(world, who.customerId, who.complaint, [...FINISHED, "HUMAN_REVIEW"]);

    const verdicts = callsOf(world.agent.turns, "check_duplicate_debit").map((call) => (call.output as { verdict?: string } | null)?.verdict);
    expect(verdicts.length, turnsSummary(world.agent.turns)).toBeGreaterThan(0);
    expect(verdicts).not.toContain("DUPLICATE");
    expect(await actionsOf(world, who.complaint)).toEqual([]);
    expect(walletOf(world, "cus-0026")).toBe(before);
    expect((await current(world, who.complaint))?.outcome).not.toBe("IN_FAVOUR");
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });
});
