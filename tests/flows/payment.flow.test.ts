// Local flows of a payment that does not show (docs/flows-catalog.md area C): the persona files the
// complaint, accepts the email, sends the seed receipt from the simulator and the scripted Harness reads
// it, reconciles it against the published settlement and applies it through the Gateway. The amount and
// the allocation always come from the core; the asserts read the core, the case file and the register.
import { describe, expect, it, vi } from "vitest";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { type CallResult, type PlanSource, type PlannedCall, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, needsChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const ANSWER = "Revisamos tu reclamo con la información de la red de cobro y de tu cuenta.";


const outputNamed = (earlier: readonly CallResult[], tool: string) => outputOf(earlier.filter((call) => call.tool === tool).at(-1));
const read: PlannedCall = { tool: "read_receipt", input: (_earlier, turn) => ({ evidenceId: turn.attachments[0]?.evidenceId ?? "" }) };
const reconcile: PlannedCall = { tool: "reconcile_payment", input: (earlier) => ({ readingId: String(outputNamed(earlier, "read_receipt").readingId) }) };
const apply: PlannedCall = { tool: "apply_payment", input: (earlier) => ({ reconciliationId: String(outputNamed(earlier, "reconcile_payment").reconciliationId) }) };
const resolve = (outcome: string): PlannedCall => ({ tool: "update_complaint", input: { status: "RESOLVED", outcome } });
const notice: PlannedCall = { tool: "send_whatsapp", input: { kind: "RESOLUTION_NOTICE", text: "Ya imputamos tu pago y te mandamos la respuesta por email." } };
const answer = (outcome: string): PlannedCall => ({ tool: "answer_complaint_in_writing", input: { outcome, draftBody: ANSWER } });
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });

type Steps = readonly PlannedCall[] | (() => Promise<readonly PlannedCall[]>);

/** The agent: asks the challenge on the first message, verifies the customer's answer, then plays `steps` on the turn they name. */
function agent(steps: Partial<Record<string, Steps>>): PlanSource {
  return async (turn) => {
    const planned = steps[turn.event.type];
    if (planned !== undefined) return typeof planned === "function" ? planned() : planned;
    if (turn.event.type !== "CUSTOMER_MESSAGE") return [];
    if (repliesToChallenge(turn)) return [verifyWritten, reply("Gracias, ya te identifiqué. Mandame el comprobante.")];
    return needsChallenge(turn) ? [askChallenge] : [reply("Gracias. Mandame el comprobante.")];
  };
}

/** The MATCHED reconciliation the code left on the case file (the agent reads it from the earlier turns). */
function applyMatched(world: FlowWorld, customerId: string, then: readonly PlannedCall[]): () => Promise<readonly PlannedCall[]> {
  return async () => {
    const complaint = (await world.connector.complaints.listByCustomer("demo", customerId)).find((candidate) => candidate.origin === "LIVE");
    const evidence = await world.connector.caseItems.listEvidence("demo", complaint?.complaintId ?? "");
    const matched = evidence.filter((item) => item.kind === "SETTLEMENT_MATCH" && item.details.result === "MATCHED").at(-1);
    return [{ tool: "apply_payment", input: { reconciliationId: matched?.refId ?? "" } }, ...then];
  };
}

/** Bedrock reads the receipt as the settlement line says (the eval set does not carry the demo receipts). */
function bedrockReads(world: FlowWorld, fields: { network: string; operationCode: string; amountCents: number; paidAtLocal: string }): void {
  world.reader.forced = {
    kind: "READ",
    raw: { isReceipt: true, legibility: "CLEAR", network: fields.network, operationCode: fields.operationCode, amount: fields.amountCents / 100, currency: "ARS", paidAtLocal: fields.paidAtLocal, suspiciousText: false, notes: "" } as never,
  };
}

/** Complaint, challenge answered, email accepted, the seed receipt sent: the complaint as it stands afterwards. */
async function complainWithReceipt(world: FlowWorld, customerId: string, receipt: string): Promise<Complaint> {
  await world.phone(customerId, { type: "text", text: PAYMENT_NOT_REFLECTED });
  await answerChallenge(world, customerId);
  await world.tap(customerId, "ACCEPT_EMAIL");
  await world.sendImage(customerId, receipt);
  const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
  if (complaint === undefined) throw new Error("the complaint was not filed");
  return complaint;
}

function instalment(world: FlowWorld, customerId: string, loanId: string, number: number): Record<string, unknown> | undefined {
  return world.mocks.coreStore.dump().find((item) => item.pk === `W#demo#CUS#${customerId}` && item.entity === "Instalment" && item.loanId === loanId && item.number === number);
}

async function evidenceKinds(world: FlowWorld, complaint: Complaint): Promise<string[]> {
  return (await world.connector.caseItems.listEvidence("demo", complaint.complaintId)).map((evidence) => evidence.kind);
}

describe("[FL-016] happy path: a legible receipt and a published batch", () => {
  it("[FL-016] reads (both readings agree), reconciles MATCHED, applies once with its claim, notifies and answers in writing; the milestones are cancelled", async () => {
    const world = await createFlowWorld();
    bedrockReads(world, { network: "SUR", operationCode: "SUR-20261002-010007-1", amountCents: 7_259_600, paidAtLocal: "2026-10-02T13:15" });
    world.harness.script(agent({ RECEIPT_RECEIVED: [read, reconcile, apply, resolve("IN_FAVOUR"), notice, answer("IN_FAVOUR")] }));
    const complaint = await complainWithReceipt(world, "cus-0004", "receipts/legible/c04-1.png");
    const results = world.harness.results.slice(-6);
    expect(outputOf(results[0])).toMatchObject({ result: "READ", source: "BOTH_AGREE" });
    expect(outputOf(results[1])).toMatchObject({ result: "MATCHED", source: "SETTLEMENT" });
    expect(outputOf(results[2])).toMatchObject({ allocations: [{ instalment: 5, statusAfter: "PAID" }] });
    const paid = instalment(world, "cus-0004", "L-0004", 5);
    expect(paid?.paid).toBe(paid?.amount);
    expect((await world.connector.caseItems.listActions("demo", complaint.complaintId)).filter((action) => action.kind === "APPLY_PAYMENT")).toHaveLength(1);
    expect(await evidenceKinds(world, complaint)).toEqual(expect.arrayContaining(["RECEIPT_IMAGE", "RECEIPT_READING", "SETTLEMENT_MATCH"]));
    const done = await world.connector.complaints.get("demo", complaint.complaintId);
    expect(done).toMatchObject({ status: "ANSWERED", outcome: "IN_FAVOUR" });
    const sent = world.stage.emails.find((email) => email.input.EmailTags?.some((tag) => tag.Value === "FORMAL_ANSWER"));
    expect(sent).toBeDefined();
    await world.sesEvent(sent ?? (undefined as never), "Delivery");
    expect((await world.connector.complaints.get("demo", complaint.complaintId))?.answer?.deliveryProof).toBe("DELIVERED");
    expect((await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).filter((timer) => timer.kind === "SLA").every((timer) => timer.status === "CANCELLED")).toBe(true);
  });
});

describe("[FL-017] a pending batch is reconciled when the network publishes", () => {
  it("[FL-017] PENDING_BATCH waits with its recheck; one advance publishes at 08:30, the recheck fires by PUBLICATION and the payment is applied once", async () => {
    const world = await createFlowWorld();
    world.harness.script(
      agent({
        RECEIPT_RECEIVED: [read, reconcile, { tool: "update_complaint", input: { status: "AWAITING_SETTLEMENT" } }, reply("La red informa los pagos del martes el jueves a las 08:30; ahí lo reviso.")],
        SETTLEMENT_PUBLISHED: applyMatched(world, "cus-0001", [resolve("IN_FAVOUR"), notice, answer("IN_FAVOUR")]),
      }),
    );
    const complaint = await complainWithReceipt(world, "cus-0001", "receipts/legible/c01-1.png");
    expect(outputOf(world.harness.results.filter((call) => call.tool === "reconcile_payment").at(-1))).toMatchObject({ result: "PENDING_BATCH", recheckTimerId: expect.any(String) });
    expect((await world.connector.complaints.get("demo", complaint.complaintId))?.status).toBe("AWAITING_SETTLEMENT");

    await world.advance({ kind: "advanceToNext" });
    expect((await world.simNow()).toISOString()).toBe(new Date("2026-10-08T08:30:00-03:00").toISOString());
    const recheck = (await world.connector.timers.listByOwner("demo", "BATCH#NORTE#2026-10-07")).find((timer) => timer.kind === "SETTLEMENT_RECHECK");
    expect(recheck).toMatchObject({ status: "FIRED", firedBy: "PUBLICATION" });
    const done = await world.connector.complaints.get("demo", complaint.complaintId);
    expect(done?.statusHistory.map((change) => change.to)).toEqual(["REGISTERED", "INVESTIGATING", "AWAITING_SETTLEMENT", "INVESTIGATING", "RESOLVED", "ANSWERED"]);
    expect((await world.connector.caseItems.listActions("demo", complaint.complaintId)).filter((action) => action.kind === "APPLY_PAYMENT")).toHaveLength(1);
    const resolution = (await world.connector.conversations.listMessages("demo", "cus-0001")).find((message) => message.kind === "RESOLUTION_NOTICE");
    expect(Date.parse(resolution?.atSim ?? "")).toBe(Date.parse("2026-10-08T08:30:00-03:00"));
    const registered = (await world.connector.chains.listRegisterByComplaint("demo", 1, complaint.complaintNumber)).map((entry) => entry.status);
    expect(registered).toEqual(expect.arrayContaining(["AWAITING_SETTLEMENT", "RESOLVED", "ANSWERED"]));
  });
});

describe("[FL-005] a customer with two loans", () => {
  it("[FL-005] the agent offers one row per loan and the tapped nonce sets the loan of the complaint; it resolves only for that phone", async () => {
    const world = await createFlowWorld();
    world.harness.script((turn) =>
      turn.index === 1
        ? [askChallenge]
        : turn.index === 2
        ? [verifyWritten, { tool: "get_account" }, { tool: "send_whatsapp", input: { kind: "REPLY", text: "¿Sobre cuál préstamo es?", buttons: [{ action: "CHOOSE_LOAN", ref: "L-0010a" }, { action: "CHOOSE_LOAN", ref: "L-0010b" }] } }]
        : [reply("Perfecto, reviso ese préstamo.")],
    );
    await world.phone("cus-0010", { type: "text", text: PAYMENT_NOT_REFLECTED });
    await answerChallenge(world, "cus-0010");
    expect(outputOf(world.harness.results.at(-1))).toMatchObject({ decision: "ALLOWED" });
    const offer = (await world.connector.conversations.listMessages("demo", "cus-0010")).find((message) => (message.interactive as { buttons?: { action: string }[] } | undefined)?.buttons?.some((button) => button.action === "CHOOSE_LOAN") === true);
    const rows = (offer?.interactive as { buttons: { action: string; nonce: string; title: string }[] }).buttons.filter((button) => button.action === "CHOOSE_LOAN");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.title.length <= 24)).toBe(true);

    await world.phone("cus-0001", { type: "button_reply", nonce: rows[0]?.nonce ?? "", title: rows[0]?.title ?? "" });
    expect((await world.connector.complaints.listByCustomer("demo", "cus-0001")).filter((complaint) => complaint.origin === "LIVE")).toEqual([]);
    expect(world.harness.turns.at(-1)?.facts.find((fact) => fact.name === "complaints")?.attributes).toMatchObject({ open: "0" });

    // Nothing is assumed: the complaint names no loan until the customer chooses one.
    expect((await world.connector.complaints.getByNumber("demo", "R-2026-000123"))?.subject).toBeUndefined();
    world.harness.script((turn) => [{ tool: "get_loan", input: { loanId: turn.inbound?.includes("L-0010b") === true ? "L-0010b" : "L-0010a" } }, reply("Perfecto, reviso ese préstamo.")]);
    await world.tap("cus-0010", "CHOOSE_LOAN");
    const chosen = world.harness.turns.at(-1);
    expect(chosen?.inbound).toBe(rows[0]?.title);
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_loan"))).toMatchObject({ loan: { loanId: "L-0010a" } });
  });
});

describe("[FL-022] a payment already applied", () => {
  it("[FL-022] ALREADY_APPLIED with its date: no action, an INFORMATIONAL written answer and ANSWERED", async () => {
    const world = await createFlowWorld();
    bedrockReads(world, { network: "SUR", operationCode: "SUR-20261002-010014-7", amountCents: 6_849_700, paidAtLocal: "2026-10-02T10:30" });
    world.harness.script(agent({ RECEIPT_RECEIVED: [read, reconcile, resolve("INFORMATIONAL"), answer("INFORMATIONAL")] }));
    const complaint = await complainWithReceipt(world, "cus-0011", "receipts/legible/c11-1.png");
    expect(outputOf(world.harness.results.find((call) => call.tool === "reconcile_payment"))).toMatchObject({ result: "ALREADY_APPLIED", appliedAtText: expect.any(String) });
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
    expect(await world.connector.complaints.get("demo", complaint.complaintId)).toMatchObject({ status: "ANSWERED", outcome: "INFORMATIONAL" });
  });
});

describe("[FL-023] a partial payment", () => {
  it("[FL-023] MATCHED for less than the instalment: the instalment keeps a balance, IN_FAVOUR, and the neutral notice passes the collection lexicon", async () => {
    const world = await createFlowWorld();
    bedrockReads(world, { network: "NORTE", operationCode: "NTE-20261005-010007-4", amountCents: 5_000_000, paidAtLocal: "2026-10-05T11:20" });
    const partial: PlannedCall = { tool: "send_whatsapp", input: { kind: "RESOLUTION_NOTICE", text: "Imputamos tu pago a la cuota 5; esa cuota tiene un saldo que podés ver en la app." } };
    world.harness.script(agent({ RECEIPT_RECEIVED: [read, reconcile, apply, resolve("IN_FAVOUR"), partial, answer("IN_FAVOUR")] }));
    const complaint = await complainWithReceipt(world, "cus-0012", "receipts/legible/c12-1.png");
    expect(outputOf(world.harness.results.find((call) => call.tool === "apply_payment"))).toMatchObject({ allocations: [{ instalment: 5, statusAfter: "PARTIALLY_PAID" }] });
    const row = instalment(world, "cus-0012", "L-0012", 5);
    expect(Number(row?.paid)).toBe(5_000_000);
    expect(Number(row?.paid)).toBeLessThan(Number(row?.amount));
    const sent = outputOf(world.harness.results.find((call) => call.tool === "send_whatsapp" && call.input.kind === "RESOLUTION_NOTICE"));
    expect(sent).toMatchObject({ decision: "ALLOWED" });
    const allowed = (await world.connector.chains.listTapeByMessage(String(sent.messageId))).find((entry) => entry.decision === "ALLOWED");
    expect(allowed?.evaluated).toEqual(expect.arrayContaining([{ ruleId: "CH-WA-NO-COLLECTION", result: "PASS" }, { ruleId: "CH-WA-NO-PAYMENT-REQUEST", result: "PASS" }]));
    expect(await world.connector.complaints.get("demo", complaint.complaintId)).toMatchObject({ status: "ANSWERED", outcome: "IN_FAVOUR" });
  });
});

describe("[FL-024] a payment above the agent's cap needs an approval", () => {
  it("[FL-024] ABOVE_CAP, the request, AWAITING_APPROVAL; the operator approves and the code applies the core's amount once, then the answer", async () => {
    const world = await createFlowWorld();
    bedrockReads(world, { network: "NORTE", operationCode: "NTE-20261005-010014-0", amountCents: 31_240_000, paidAtLocal: "2026-10-05T12:05" });
    const ask: PlannedCall = { tool: "request_operator_approval", input: (earlier) => ({ evidenceId: String(outputNamed(earlier, "reconcile_payment").reconciliationId), justification: "La rendición de la red confirma el pago de la cuota 5." }) };
    world.harness.script(agent({ RECEIPT_RECEIVED: [read, reconcile, apply, ask, reply("Tu pago necesita la aprobación de una persona; te aviso apenas esté.")], APPROVAL_DECIDED: [notice, answer("IN_FAVOUR")] }));
    const complaint = await complainWithReceipt(world, "cus-0013", "receipts/legible/c13-1.png");
    const above = world.harness.results.find((call) => call.tool === "apply_payment");
    expect(above?.answer.kind === "RESULT" && !above.answer.response.ok && above.answer.response.error.code).toBe("ABOVE_CAP");
    const { approvalId } = outputOf(world.harness.results.find((call) => call.tool === "request_operator_approval")) as { approvalId: string };
    expect((await world.connector.complaints.get("demo", complaint.complaintId))?.status).toBe("AWAITING_APPROVAL");
    expect(world.mocks.coreStore.dump().filter((item) => item.entity === "Payment" && item.customerId === "cus-0013" && item.network === "NORTE")).toHaveLength(0);

    const operator = await world.console("OPERATOR");
    await operator.approvals.decide({ complaintId: complaint.complaintId, approvalId, decision: "APPROVED" });
    await world.settle();
    const approval = await world.connector.caseItems.getApproval("demo", complaint.complaintId, approvalId);
    expect(approval).toMatchObject({ requestedBy: "AGENT", decision: "APPROVED", decidedBy: world.staff("OPERATOR").staffId, executedAt: expect.any(String) });
    expect(world.mocks.coreStore.dump().filter((item) => item.entity === "Payment" && item.customerId === "cus-0013" && item.network === "NORTE").map((item) => item.amount)).toEqual([31_240_000]);
    expect(world.harness.turns.some((turn) => turn.event.type === "APPROVAL_DECIDED")).toBe(true);
    expect(outputOf(world.harness.results.filter((call) => call.tool === "answer_complaint_in_writing")[0])).toMatchObject({ status: "SENT" });
    expect(await world.connector.complaints.get("demo", complaint.complaintId)).toMatchObject({ status: "ANSWERED" });
  });
});

describe("[FL-025] the last instalment: the debt-free certificate by code", () => {
  it("[FL-025] the loan is CANCELLED and the written answer carries PAYOFF_CERTIFICATE and STATEMENT although the agent asked for none", async () => {
    const world = await createFlowWorld();
    bedrockReads(world, { network: "NORTE", operationCode: "NTE-20261005-010021-5", amountCents: 3_736_201, paidAtLocal: "2026-10-05T09:45" });
    world.harness.script(agent({ RECEIPT_RECEIVED: [read, reconcile, apply, resolve("IN_FAVOUR"), notice, answer("IN_FAVOUR")] }));
    const complaint = await complainWithReceipt(world, "cus-0014", "receipts/legible/c14-1.png");
    expect(outputOf(world.harness.results.find((call) => call.tool === "apply_payment"))).toMatchObject({ loanStatusAfter: "CANCELLED" });
    expect(outputOf(world.harness.results.find((call) => call.tool === "answer_complaint_in_writing")).attachments).toEqual(expect.arrayContaining(["PAYOFF_CERTIFICATE", "STATEMENT"]));
    expect(await world.connector.complaints.get("demo", complaint.complaintId)).toMatchObject({ status: "ANSWERED" });
  });
});

describe("[FL-026] a payment from the wallet", () => {
  it("[FL-026] list_operations shows the wallet debit, reconcile_payment WALLET matches the movement and the instalment is PAID with no network settlement", async () => {
    const world = await createFlowWorld();
    const wallet: PlannedCall = { tool: "reconcile_payment", input: { source: "WALLET", movementId: "mvp-0015-05" } };
    world.harness.script((turn) => (turn.index === 1 ? [askChallenge] : turn.index === 2 ? [verifyWritten, { tool: "list_operations", input: { kind: "PAYMENT" } }, wallet, apply, resolve("IN_FAVOUR"), notice] : [reply("Listo.")]));
    await world.phone("cus-0015", { type: "text", text: PAYMENT_NOT_REFLECTED });
    await answerChallenge(world, "cus-0015");
    expect(outputOf(world.harness.results.find((call) => call.tool === "reconcile_payment"))).toMatchObject({ result: "MATCHED", source: "WALLET" });
    const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    const match = (await world.connector.caseItems.listEvidence("demo", complaint?.complaintId ?? "")).find((evidence) => evidence.kind === "SETTLEMENT_MATCH");
    expect(JSON.stringify(match)).toContain("WALLET");
    const paid = instalment(world, "cus-0015", "L-0015", 5);
    expect(paid?.paid).toBe(paid?.amount);
  });
});
