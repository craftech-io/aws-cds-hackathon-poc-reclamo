// Local flows of duplicate debits (docs/flows-catalog.md area E, FL-037 to FL-039): the core decides
// whether an instalment was debited twice (same instalment, 72 hours), the refund is executed by code
// with the natural-key claim `RFD#<debitId>`, once per debit whatever the complaint, within the agent's
// cap or after a person approves it.
import { describe, expect, it, vi } from "vitest";
import { loadChain } from "@reclamo/bff/complaints/register-verify";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { createLogger } from "@reclamo/bff/lib/log";
import { type CallResult, type PlanSource, type PlannedCall, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, needsChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const quiet = createLogger({ sink: () => undefined });
const DUPLICATE_DEBIT = "Me debitaron dos veces la misma cuota";
const ANSWER = "Revisamos los débitos de la cuota que nos consultaste.";


const outputNamed = (earlier: readonly CallResult[], tool: string) => outputOf(earlier.filter((call) => call.tool === tool).at(-1));
const errorOf = (call: CallResult | undefined) => (call?.answer.kind === "RESULT" && !call.answer.response.ok ? call.answer.response.error : undefined);
const operations: PlannedCall = { tool: "get_account" };
const check = (loanId: string, instalment: number): PlannedCall => ({ tool: "check_duplicate_debit", input: { loanId, instalment } });
const refund: PlannedCall = { tool: "refund_duplicate_debit", input: (earlier) => ({ duplicateCheckId: String(outputNamed(earlier, "check_duplicate_debit").duplicateCheckId) }) };
const resolve = (outcome: string): PlannedCall => ({ tool: "update_complaint", input: { status: "RESOLVED", outcome } });
const answer = (outcome: string, attachments?: readonly string[]): PlannedCall => ({ tool: "answer_complaint_in_writing", input: { outcome, draftBody: ANSWER, ...(attachments === undefined ? {} : { requestedAttachments: attachments }) } });
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });
const askApproval: PlannedCall = { tool: "request_operator_approval", input: (earlier) => ({ evidenceId: String(outputNamed(earlier, "check_duplicate_debit").duplicateCheckId), justification: "La cuota se debitó dos veces." }) };

/** What the customer writes once the email is accepted: the turn where the agent identifies and investigates. */
const REVIEW = "¿Lo pueden revisar?";

/** On `REVIEW` the agent asks the challenge (or, already identified, plays `investigate`); on the customer's answer it verifies it and plays `investigate`; on the event types of `then`, those calls. */
function agent(investigate: readonly PlannedCall[], then: Partial<Record<string, readonly PlannedCall[]>> = {}): PlanSource {
  return (turn) => {
    if (turn.event.type !== "CUSTOMER_MESSAGE") return then[turn.event.type] ?? [];
    if (turn.inbound === REVIEW) return needsChallenge(turn) ? [askChallenge] : [operations, ...investigate];
    if (!repliesToChallenge(turn)) return [reply("Gracias, lo reviso.")];
    return [verifyWritten, operations, ...investigate];
  };
}

/** The complaint filed with its number, the email accepted and the customer asking to review it. */
async function complain(world: FlowWorld, customerId: string, text = DUPLICATE_DEBIT): Promise<Complaint> {
  await world.phone(customerId, { type: "text", text });
  await world.tap(customerId, "ACCEPT_EMAIL");
  const complaint = (await world.connector.complaints.listByCustomer("demo", customerId)).find((candidate) => candidate.origin === "LIVE");
  if (complaint === undefined) throw new Error("the complaint was not filed");
  await world.phone(customerId, { type: "text", text: REVIEW });
  await answerChallenge(world, customerId);
  return complaint;
}

async function current(world: FlowWorld, complaint: Complaint): Promise<Complaint | undefined> {
  return world.connector.complaints.get("demo", complaint.complaintId);
}

function walletOf(world: FlowWorld, customerId: string): number {
  return Number(world.mocks.coreStore.dump().find((item) => item.pk === `W#demo#CUS#${customerId}` && item.entity === "Wallet")?.balance);
}

describe("[FL-037] a duplicate debit within the cap", () => {
  it("[FL-037] DUPLICATE, the refund once with its claim, credit note and refund register; a second complaint on the same debit gets CONFLICT with the existing action", async () => {
    const world = await createFlowWorld();
    const before = walletOf(world, "cus-0025");
    world.harness.script(agent([check("L-0025", 6), refund, resolve("IN_FAVOUR"), answer("IN_FAVOUR")]));
    const complaint = await complain(world, "cus-0025");
    expect(outputOf(world.harness.results.find((call) => call.tool === "check_duplicate_debit"))).toMatchObject({ verdict: "DUPLICATE" });
    const refunded = outputOf(world.harness.results.find((call) => call.tool === "refund_duplicate_debit"));
    expect(refunded).toMatchObject({ actionId: expect.any(String), creditNoteId: expect.any(String) });
    expect(walletOf(world, "cus-0025")).toBe(before + 7_230_000);
    const actions = await world.connector.caseItems.listActions("demo", complaint.complaintId);
    expect(actions.filter((action) => action.kind === "REFUND_DUPLICATE")).toEqual([expect.objectContaining({ status: "EXECUTED", claimKey: expect.stringMatching(/^RFD#/) })]);
    const refunds = await loadChain(world.stage.complaints(quiet), "demo", 1, "RRI");
    expect(refunds.filter((entry) => entry.complaintId === complaint.complaintId)).toHaveLength(1);
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "IN_FAVOUR" });

    world.harness.script(agent([check("L-0025", 6), refund, reply("Ese débito ya te lo reintegramos.")]));
    await world.phone("cus-0025", { type: "text", text: "Veo dos débitos iguales de la cuota 6" });
    const second = (await world.connector.complaints.listByCustomer("demo", "cus-0025")).find((candidate) => candidate.origin === "LIVE" && candidate.complaintId !== complaint.complaintId);
    expect(second).toBeDefined();
    // Still identified (30 real minutes): the agent investigates at once.
    await world.phone("cus-0025", { type: "text", text: REVIEW });
    const conflict = world.harness.results.filter((call) => call.tool === "refund_duplicate_debit").at(-1);
    expect(conflict?.answer.kind === "RESULT" && conflict.answer.response.ok ? conflict.answer.response : errorOf(conflict)).toMatchObject({ code: "CONFLICT" });
    expect(JSON.stringify(conflict?.answer)).toContain(String(refunded.actionId));
    expect(walletOf(world, "cus-0025")).toBe(before + 7_230_000);
  });
});

describe("[FL-038] a duplicate debit above the cap", () => {
  it("[FL-038] ABOVE_CAP, an operator approves, the code refunds once and the written answer goes out", async () => {
    const world = await createFlowWorld();
    const before = walletOf(world, "cus-0003");
    world.harness.script(agent([check("L-0003", 6), refund, askApproval, reply("Lo aprueba una persona; te aviso.")], { APPROVAL_DECIDED: [answer("IN_FAVOUR")] }));
    const complaint = await complain(world, "cus-0003");
    expect(errorOf(world.harness.results.find((call) => call.tool === "refund_duplicate_debit"))).toMatchObject({ code: "ABOVE_CAP" });
    const { approvalId } = outputOf(world.harness.results.find((call) => call.tool === "request_operator_approval")) as { approvalId: string };
    expect(walletOf(world, "cus-0003")).toBe(before);
    const operator = await world.console("OPERATOR");
    await operator.approvals.decide({ complaintId: complaint.complaintId, approvalId, decision: "APPROVED" });
    await world.settle();
    expect(await world.connector.caseItems.getApproval("demo", complaint.complaintId, approvalId)).toMatchObject({ decision: "APPROVED", executedAt: expect.any(String) });
    expect(walletOf(world, "cus-0003")).toBe(before + 14_630_000);
    expect((await world.connector.caseItems.listActions("demo", complaint.complaintId)).filter((action) => action.kind === "REFUND_DUPLICATE" && action.status === "EXECUTED")).toHaveLength(1);
    expect(outputOf(world.harness.results.filter((call) => call.tool === "answer_complaint_in_writing")[0])).toMatchObject({ status: "SENT" });
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED" });
  });
});

describe("[FL-039] a false duplicate", () => {
  it("[FL-039] two debits of the same amount of instalments 5 and 6 are NOT_DUPLICATE with both debits in the evidence; no refund", async () => {
    const world = await createFlowWorld();
    const before = walletOf(world, "cus-0026");
    world.harness.script(agent([check("L-0026", 6), check("L-0026", 5), resolve("NOT_IN_FAVOUR"), answer("NOT_IN_FAVOUR")]));
    const complaint = await complain(world, "cus-0026");
    const checks = world.harness.results.filter((call) => call.tool === "check_duplicate_debit").map(outputOf);
    expect(checks.map((checked) => checked.verdict)).toEqual(["NOT_DUPLICATE", "NOT_DUPLICATE"]);
    const evidence = JSON.stringify((await world.connector.caseItems.listEvidence("demo", complaint.complaintId)).filter((item) => item.kind === "DUPLICATE_CHECK").map((item) => item.details));
    expect(evidence).toContain('"debitId":"dbt-0026-05","instalment":5');
    expect(evidence).toContain('"debitId":"dbt-0026-06","instalment":6');
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
    expect(walletOf(world, "cus-0026")).toBe(before);
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "NOT_IN_FAVOUR" });
  });
});
