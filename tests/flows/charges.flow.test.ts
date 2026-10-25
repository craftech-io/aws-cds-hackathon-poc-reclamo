// Local flows of charges (docs/flows-catalog.md area E, FL-032 to FL-034 and FL-040): the agent copies
// the charge from `list_operations`, the core recomputes it against the fee schedule, and a WRONG charge
// is reversed by code with its credit note and refund register entry, within the agent's cap or after a
// person approves it. The amounts, the tier and the monthly limit are the code's, never the model's.
import { describe, expect, it, vi } from "vitest";
import { loadChain } from "@reclamo/bff/complaints/register-verify";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { createLogger } from "@reclamo/bff/lib/log";
import { type CallResult, type PlanSource, type PlannedCall, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, needsChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const quiet = createLogger({ sink: () => undefined });
const UNRECOGNIZED_CHARGE = "Me cobraron una comisión que no reconozco";
const ANSWER = "Revisamos el cargo que nos consultaste contra el cuadro de tarifas de tu préstamo.";


const outputNamed = (earlier: readonly CallResult[], tool: string) => outputOf(earlier.filter((call) => call.tool === tool).at(-1));
const errorOf = (call: CallResult | undefined) => (call?.answer.kind === "RESULT" && !call.answer.response.ok ? call.answer.response.error : undefined);
const operations: PlannedCall = { tool: "list_operations", input: { kind: "CHARGE" } };
const check = (chargeId: string): PlannedCall => ({ tool: "check_charge", input: { chargeId } });
const reverse: PlannedCall = { tool: "reverse_charge", input: (earlier) => ({ chargeCheckId: String(outputNamed(earlier, "check_charge").chargeCheckId) }) };
const resolve = (outcome: string): PlannedCall => ({ tool: "update_complaint", input: { status: "RESOLVED", outcome } });
const answer = (outcome: string, attachments?: readonly string[]): PlannedCall => ({ tool: "answer_complaint_in_writing", input: { outcome, draftBody: ANSWER, ...(attachments === undefined ? {} : { requestedAttachments: attachments }) } });
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });
const askApproval: PlannedCall = { tool: "request_operator_approval", input: (earlier) => ({ evidenceId: String(outputNamed(earlier, "check_charge").chargeCheckId), justification: "El cargo no corresponde según el cuadro de tarifas." }) };

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
async function complain(world: FlowWorld, customerId: string, text = UNRECOGNIZED_CHARGE): Promise<Complaint> {
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

describe("[FL-032] a correct charge: a grounded explanation", () => {
  it("[FL-032] check_charge CORRECT with its clauses; the reply passes G2 grounding; NOT_IN_FAVOUR in writing and no reversal", async () => {
    const world = await createFlowWorld();
    world.harness.script(
      agent([
        check("chg-0022-02"),
        { tool: "get_terms", input: (earlier) => ({ clauseIds: outputNamed(earlier, "check_charge").clauseIds as string[] }) },
        reply("Es el interés punitorio FEE-PUNIT de la cuota 2, que corresponde según la cláusula T-3.4."),
        resolve("NOT_IN_FAVOUR"),
        answer("NOT_IN_FAVOUR"),
      ]),
    );
    const complaint = await complain(world, "cus-0022", "Me cobraron un interés que no entiendo");
    const checked = outputOf(world.harness.results.find((call) => call.tool === "check_charge"));
    expect(checked).toMatchObject({ verdict: "CORRECT" });
    expect(checked).toMatchObject({ feeCode: "FEE-PUNIT", clauseIds: expect.arrayContaining(["T-3.4"]) });
    const explanation = world.guardrails.g2.inputs.find((input) => input.kind === "REPLY" && input.text.includes("T-3.4"));
    expect(explanation?.grounding?.source).toContain("T-3.4");
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "NOT_IN_FAVOUR" });
  });
});

describe("[FL-033] a wrong charge within the cap: reversal and credit note", () => {
  it("[FL-033] WRONG, reverse_charge credits the wallet with compensatory interest, the refund register gets its entry and the answer carries the credit note", async () => {
    const world = await createFlowWorld();
    const before = walletOf(world, "cus-0002");
    world.harness.script(agent([check("chg-0002-02"), reverse, resolve("IN_FAVOUR"), answer("IN_FAVOUR")]));
    const complaint = await complain(world, "cus-0002");
    expect(outputOf(world.harness.results.find((call) => call.tool === "check_charge"))).toMatchObject({ verdict: "WRONG" });
    const reversed = outputOf(world.harness.results.find((call) => call.tool === "reverse_charge"));
    expect(reversed).toMatchObject({ creditNoteId: expect.any(String) });
    expect(walletOf(world, "cus-0002")).toBeGreaterThan(before + 250_000 - 1);
    const refunds = await loadChain(world.stage.complaints(quiet), "demo", 1, "RRI");
    expect(refunds.filter((entry) => entry.complaintId === complaint.complaintId)).toEqual([expect.objectContaining({ cause: "REVERSE_CHARGE", creditNoteId: reversed.creditNoteId })]);
    expect(outputOf(world.harness.results.find((call) => call.tool === "answer_complaint_in_writing")).attachments).toContain("CREDIT_NOTE");
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "IN_FAVOUR" });
  });
});

describe("[FL-034] a wrong charge above the agent's cap: an operator approves", () => {
  it("[FL-034] ABOVE_CAP OPERATOR, the request with its evidence; the operator approves, the code reverses once and the answer goes out", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([check("chg-0023-02"), reverse, askApproval, reply("Lo tiene que aprobar una persona; te aviso.")], { APPROVAL_DECIDED: [answer("IN_FAVOUR")] }));
    const complaint = await complain(world, "cus-0023");
    expect(errorOf(world.harness.results.find((call) => call.tool === "reverse_charge"))).toMatchObject({ code: "ABOVE_CAP" });
    const { approvalId } = outputOf(world.harness.results.find((call) => call.tool === "request_operator_approval")) as { approvalId: string };
    expect((await current(world, complaint))?.status).toBe("AWAITING_APPROVAL");
    const operator = await world.console("OPERATOR");
    await operator.approvals.decide({ complaintId: complaint.complaintId, approvalId, decision: "APPROVED" });
    await world.settle();
    expect(await world.connector.caseItems.getApproval("demo", complaint.complaintId, approvalId)).toMatchObject({ decision: "APPROVED", executedAt: expect.any(String) });
    expect((await world.connector.caseItems.listActions("demo", complaint.complaintId)).filter((action) => action.kind === "REVERSE_CHARGE" && action.status === "EXECUTED")).toHaveLength(1);
    expect(outputOf(world.harness.results.filter((call) => call.tool === "answer_complaint_in_writing")[0])).toMatchObject({ status: "SENT" });
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED" });
  });
});

describe("[FL-040] the monthly limit of automatic actions per customer", () => {
  it("[FL-040] with two automatic reversals in the last 30 days, a small reversal is ABOVE_CAP MONTHLY_AUTO_LIMIT and asks an OPERATOR", async () => {
    const world = await createFlowWorld();
    world.harness.script(() => [reply("Gracias.")]);
    await world.phone("cus-0002", { type: "text", text: UNRECOGNIZED_CHARGE });
    const filed = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    const complaintId = filed?.complaintId ?? "";
    // The persona's history: two reversals the agent executed on its own in the last 30 simulated days.
    for (const day of ["2026-09-20", "2026-09-28"]) {
      await world.connector.caseItems.putAction({ worldId: "demo", complaintId, actionId: `act-hist-${day}`, kind: "REVERSE_CHARGE", status: "EXECUTED", amountCents: 120_000, idempotencyKey: `hist-${day}`, claimKey: `REV#hist-${day}`, atSim: `${day}T10:00:00-03:00`, actor: "AGENT" });
    }
    world.harness.script(agent([check("chg-0002-02"), reverse, askApproval]));
    await world.phone("cus-0002", { type: "text", text: REVIEW });
    await answerChallenge(world, "cus-0002");
    expect(errorOf(world.harness.results.find((call) => call.tool === "reverse_charge"))).toMatchObject({ code: "ABOVE_CAP", reason: "MONTHLY_AUTO_LIMIT" });
    const { approvalId } = outputOf(world.harness.results.find((call) => call.tool === "request_operator_approval")) as { approvalId: string };
    expect(await world.connector.caseItems.getApproval("demo", complaintId, approvalId)).toMatchObject({ capTier: "OPERATOR", decision: "PENDING", amountCents: 250_000 });
    expect((await world.connector.caseItems.listActions("demo", complaintId)).filter((action) => !action.actionId.startsWith("act-hist-"))).toEqual([]);
  });
});
