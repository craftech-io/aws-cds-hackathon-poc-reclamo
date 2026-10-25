// SC-01 (the main story) and SC-02 (payments) on the run's model. The customer files, accepts the email,
// answers the challenge and sends the seed receipt; the model reads, reconciles and writes. The code
// reconciles against the settlement, decides the cap, applies the money once and picks the attachments:
// the oracles read the core, the case file, the approvals and the tape.
import { describe, expect, it } from "vitest";
import { SCRIPTED_RUN, errorCodesOf, okResultOf, openAgentWorld, turnsSummary } from "../support/agent-world";
import { type Customer, actionsOf, answerChallenges, complain, coreRow, current, evidenceKinds, operatorApproves, pursueStatus, say } from "../support/customer";
import type { AgentWorld } from "../support/agent-world";
import { collectionRulesPassed, conversationProblems } from "../support/oracles";

const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const FINISHED = ["ANSWERED", "CLOSED"];

/** Bedrock reads the receipt as the settlement line says (the evaluation set does not carry these receipts). */
function bedrockReads(world: AgentWorld, fields: { network: string; operationCode: string; amountCents: number; paidAtLocal: string }): void {
  world.flow.reader.forced = {
    kind: "READ",
    raw: { isReceipt: true, legibility: "CLEAR", network: fields.network, operationCode: fields.operationCode, amount: fields.amountCents / 100, currency: "ARS", paidAtLocal: fields.paidAtLocal, suspiciousText: false, notes: "" } as never,
  };
}

/** Complaint, email accepted, challenge answered, then the receipt (and the challenge again if the agent asks it there). */
async function complainWithReceipt(world: AgentWorld, customerId: string, receipt: string): Promise<Customer> {
  const complaint = await complain(world, customerId, PAYMENT_NOT_REFLECTED);
  if (complaint === undefined) throw new Error("the complaint was not filed");
  await world.flow.sendImage(customerId, receipt);
  await answerChallenges(world, customerId);
  return { customerId, complaint };
}

const instalment = (world: AgentWorld, customerId: string, loanId: string, number: number) => coreRow(world, customerId, "Instalment", (item) => item.loanId === loanId && item.number === number);
const executed = async (world: AgentWorld, who: Customer, kind: string) => (await actionsOf(world, who.complaint)).filter((action) => action.kind === kind && action.status === "EXECUTED");

describe.skipIf(SCRIPTED_RUN)("payments (agent)", () => {
  it("[SC-01/2-7] [FL-017] the main story: PENDING_BATCH waits, one advance publishes the batch, the payment is applied once and answered in writing", async () => {
    const world = await openAgentWorld();
    const who = await complainWithReceipt(world, "cus-0001", "receipts/legible/c01-1.png");

    expect(okResultOf(world.agent.turns, "reconcile_payment"), turnsSummary(world.agent.turns)).toMatchObject({ result: "PENDING_BATCH" });
    expect(await executed(world, who, "APPLY_PAYMENT"), "nothing is applied before the network publishes").toEqual([]);
    await world.flow.advance({ kind: "advanceToNext" });
    expect((await world.flow.simNow()).toISOString()).toBe(new Date("2026-10-08T08:30:00-03:00").toISOString());
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    const applied = await executed(world, who, "APPLY_PAYMENT");
    expect(applied.map((action) => action.amountCents), turnsSummary(world.agent.turns)).toEqual([11_864_000]);
    expect(applied[0]?.claimKey?.startsWith("OPC#")).toBe(true);
    expect(await current(world, who.complaint)).toMatchObject({ outcome: "IN_FAVOUR" });
    expect(FINISHED).toContain((await current(world, who.complaint))?.status);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-02/2] [FL-016] C04: MATCHED against the published batch, applied once, IN_FAVOUR in writing", async () => {
    const world = await openAgentWorld();
    bedrockReads(world, { network: "SUR", operationCode: "SUR-20261002-010007-1", amountCents: 7_259_600, paidAtLocal: "2026-10-02T13:15" });
    const who = await complainWithReceipt(world, "cus-0004", "receipts/legible/c04-1.png");
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(okResultOf(world.agent.turns, "reconcile_payment"), turnsSummary(world.agent.turns)).toMatchObject({ result: "MATCHED" });
    expect(await executed(world, who, "APPLY_PAYMENT")).toHaveLength(1);
    const paid = instalment(world, who.customerId, "L-0004", 5);
    expect(paid?.paid).toBe(paid?.amount);
    expect(await evidenceKinds(world, who.complaint)).toEqual(expect.arrayContaining(["RECEIPT_READING", "SETTLEMENT_MATCH"]));
    expect(await current(world, who.complaint)).toMatchObject({ outcome: "IN_FAVOUR" });
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-02/3] [FL-022] C11: ALREADY_APPLIED, no payment, not in favour of a second payment", async () => {
    const world = await openAgentWorld();
    bedrockReads(world, { network: "SUR", operationCode: "SUR-20261002-010014-7", amountCents: 6_849_700, paidAtLocal: "2026-10-02T10:30" });
    const who = await complainWithReceipt(world, "cus-0011", "receipts/legible/c11-1.png");
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(okResultOf(world.agent.turns, "reconcile_payment"), turnsSummary(world.agent.turns)).toMatchObject({ result: "ALREADY_APPLIED" });
    expect(await actionsOf(world, who.complaint)).toEqual([]);
    expect((await current(world, who.complaint))?.outcome).not.toBe("IN_FAVOUR");
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-02/4] [FL-023] C12: a partial payment applied as paid, the instalment keeps its balance, no collection language", async () => {
    const world = await openAgentWorld();
    bedrockReads(world, { network: "NORTE", operationCode: "NTE-20261005-010007-4", amountCents: 5_000_000, paidAtLocal: "2026-10-05T11:20" });
    const who = await complainWithReceipt(world, "cus-0012", "receipts/legible/c12-1.png");
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(okResultOf(world.agent.turns, "apply_payment"), turnsSummary(world.agent.turns)).toMatchObject({ allocations: [{ instalment: 5, statusAfter: "PARTIALLY_PAID" }] });
    const row = instalment(world, who.customerId, "L-0012", 5);
    expect(Number(row?.paid)).toBe(5_000_000);
    expect(await collectionRulesPassed(world, who.customerId, ["CH-WA-NO-COLLECTION", "CH-WA-NO-PAYMENT-REQUEST"])).toBe(true);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-02/5-6] [SC-16/6] [FL-024] C13: above the cap the agent asks a person; only the operator's approval applies the core's amount, once", async () => {
    const world = await openAgentWorld();
    bedrockReads(world, { network: "NORTE", operationCode: "NTE-20261005-010014-0", amountCents: 31_240_000, paidAtLocal: "2026-10-05T12:05" });
    const who = await complainWithReceipt(world, "cus-0013", "receipts/legible/c13-1.png");
    await pursueStatus(world, who.customerId, who.complaint, ["AWAITING_APPROVAL"], 1);

    expect((await current(world, who.complaint))?.status, turnsSummary(world.agent.turns)).toBe("AWAITING_APPROVAL");
    expect(errorCodesOf(world.agent.turns, "apply_payment").every((code) => code === "ABOVE_CAP")).toBe(true);
    expect(world.flow.mocks.coreStore.dump().filter((item) => item.entity === "Payment" && item.customerId === who.customerId && item.network === "NORTE")).toHaveLength(0);
    expect(await operatorApproves(world, who.complaint)).toBeDefined();
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(world.flow.mocks.coreStore.dump().filter((item) => item.entity === "Payment" && item.customerId === who.customerId && item.network === "NORTE").map((item) => item.amount)).toEqual([31_240_000]);
    expect(FINISHED).toContain((await current(world, who.complaint))?.status);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-02/7] [FL-025] C14: the last instalment cancels the loan and the written answer carries the certificate and the statement by code", async () => {
    const world = await openAgentWorld();
    bedrockReads(world, { network: "NORTE", operationCode: "NTE-20261005-010021-5", amountCents: 3_736_201, paidAtLocal: "2026-10-05T09:45" });
    const who = await complainWithReceipt(world, "cus-0014", "receipts/legible/c14-1.png");
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(okResultOf(world.agent.turns, "apply_payment"), turnsSummary(world.agent.turns)).toMatchObject({ loanStatusAfter: "CANCELLED" });
    expect(okResultOf(world.agent.turns, "answer_complaint_in_writing")?.attachments).toEqual(expect.arrayContaining(["PAYOFF_CERTIFICATE", "STATEMENT"]));
    expect(FINISHED).toContain((await current(world, who.complaint))?.status);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-02/8] [FL-026] C15: paid from the wallet, the agent finds the movement and reconciles it as WALLET; the instalment PAID", async () => {
    const world = await openAgentWorld();
    const complaint = await complain(world, "cus-0015", PAYMENT_NOT_REFLECTED, { acceptEmail: false });
    if (complaint === undefined) throw new Error("the complaint was not filed");
    await say(world, "cus-0015", "La pagué desde la billetera, no en una red de cobro.");
    await answerChallenges(world, "cus-0015");
    await pursueStatus(world, "cus-0015", complaint, ["RESOLVED", ...FINISHED], 1);

    expect(okResultOf(world.agent.turns, "reconcile_payment"), turnsSummary(world.agent.turns)).toMatchObject({ result: "MATCHED", source: "WALLET" });
    const paid = instalment(world, "cus-0015", "L-0015", 5);
    expect(paid?.paid).toBe(paid?.amount);
    expect(await conversationProblems(world, "cus-0015")).toEqual([]);
  });
});
