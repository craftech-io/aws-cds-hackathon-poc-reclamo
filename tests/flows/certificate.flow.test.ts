// Local flows of the debt-free certificate (docs/flows-catalog.md area D, FL-030 and FL-031): whether a
// loan's certificate can be issued is the code's decision (only CANCELLED or EARLY_CANCELLED), the PDF
// is rendered by code from the core and attached by eligibility, and a loan with a balance gets a
// neutral explanation that never asks for the payment.
import { describe, expect, it, vi } from "vitest";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { type CallResult, type PlanSource, type PlannedCall, type ScriptedTurn, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, needsChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const CERTIFICATE = "Necesito el libre deuda del préstamo que cancelé";
const ANSWER = "Revisamos el estado de tu préstamo para el pedido de libre deuda.";


const errorOf = (call: CallResult | undefined) => (call?.answer.kind === "RESULT" && !call.answer.response.ok ? call.answer.response.error : undefined);
const operations: PlannedCall = { tool: "get_account" };
const loan = (loanId: string): PlannedCall => ({ tool: "get_loan", input: { loanId } });
const resolve = (outcome: string): PlannedCall => ({ tool: "update_complaint", input: { status: "RESOLVED", outcome } });
const answer = (outcome: string, attachments?: readonly string[]): PlannedCall => ({ tool: "answer_complaint_in_writing", input: { outcome, draftBody: ANSWER, ...(attachments === undefined ? {} : { requestedAttachments: attachments }) } });
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });

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
async function complain(world: FlowWorld, customerId: string, text = CERTIFICATE): Promise<Complaint> {
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

/** The text of a PDF the world stored in `Documents` (uncompressed streams, WinAnsi). */
function documentText(world: FlowWorld, kind: string): string {
  const key = world.s3.keys("Documents").find((candidate) => candidate.includes(kind));
  return key === undefined ? "" : Buffer.from(world.s3.get("Documents", key)?.bytes ?? new Uint8Array()).toString("latin1");
}

describe("[FL-030] a cancelled loan: the debt-free certificate by email", () => {
  it("[FL-030] get_loan CANCELLED; the written answer IN_FAVOUR carries the PAYOFF_CERTIFICATE with the cancellation and no debt; delivered and ANSWERED", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([operations, loan("L-0005"), resolve("IN_FAVOUR"), answer("IN_FAVOUR", ["PAYOFF_CERTIFICATE"])]));
    const complaint = await complain(world, "cus-0005");
    expect(complaint.type).toBe("PAYOFF_CERTIFICATE");
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_loan"))).toMatchObject({ loan: { status: "CANCELLED" } });
    expect(outputOf(world.harness.results.find((call) => call.tool === "update_complaint"))).toMatchObject({ status: "RESOLVED" });
    expect(outputOf(world.harness.results.find((call) => call.tool === "answer_complaint_in_writing")).attachments).toContain("PAYOFF_CERTIFICATE");
    const certificate = documentText(world, "PAYOFF_CERTIFICATE");
    expect(certificate).toMatch(/no registra deuda/i);
    expect(certificate).toContain("15/09/2026");
    const sent = world.stage.emails.find((email) => email.input.EmailTags?.some((tag) => tag.Value === "FORMAL_ANSWER"));
    await world.sesEvent(sent ?? (undefined as never), "Delivery");
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "IN_FAVOUR", answer: { deliveryProof: "DELIVERED" } });
  });
});

describe("[FL-031] a loan with a balance: a neutral explanation", () => {
  it("[FL-031] get_loan ACTIVE; asking for the certificate is not eligible, the reply passes the collection lexicon and the answer is INFORMATIONAL without it", async () => {
    const world = await createFlowWorld();
    const neutral = reply("Tu préstamo todavía tiene cuotas pendientes; el libre deuda se emite cuando se cancela.");
    world.harness.script(agent([operations, loan("L-0021"), neutral, resolve("INFORMATIONAL"), answer("INFORMATIONAL", ["PAYOFF_CERTIFICATE"]), answer("INFORMATIONAL")]));
    const complaint = await complain(world, "cus-0021");
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_loan"))).toMatchObject({ loan: { status: "ACTIVE" } });
    expect(outputOf(world.harness.results.find((call) => call.tool === "update_complaint"))).toMatchObject({ status: "RESOLVED" });
    const sent = outputOf(world.harness.results.find((call) => call.tool === "send_whatsapp" && call.input.text === (neutral.input as { text: string }).text));
    const allowed = (await world.connector.chains.listTapeByMessage(String(sent.messageId))).find((entry) => entry.decision === "ALLOWED");
    expect(allowed?.evaluated).toEqual(expect.arrayContaining([{ ruleId: "CH-WA-NO-COLLECTION", result: "PASS" }, { ruleId: "CH-WA-NO-PAYMENT-REQUEST", result: "PASS" }]));
    const [certificate, answered] = world.harness.results.filter((call) => call.tool === "answer_complaint_in_writing");
    expect(errorOf(certificate)).toMatchObject({ code: "NOT_ELIGIBLE" });
    expect(outputOf(answered).attachments).not.toContain("PAYOFF_CERTIFICATE");
    expect(world.s3.keys("Documents").some((key) => key.includes("PAYOFF_CERTIFICATE"))).toBe(false);
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "INFORMATIONAL" });
  });
});

describe("[FL-030] the complaint's own number in what the agent writes, and a written answer rewritten in the same turn", () => {
  it("[FL-030] a reply and a written answer that quote the complaint's number go out; a draft the gate refused is rewritten and decided again in the same turn", async () => {
    const world = await createFlowWorld();
    const numberOf = (turn: ScriptedTurn) => turn.facts.find((fact) => fact.name === "complaint" && fact.attributes["current"] === "true")?.attributes["number"] ?? turn.facts.find((fact) => fact.name === "complaint")?.attributes["number"] ?? "";
    const write = (draft: (number: string) => string): PlannedCall => ({ tool: "answer_complaint_in_writing", input: (_earlier, turn) => ({ outcome: "IN_FAVOUR", draftBody: draft(numberOf(turn)), requestedAttachments: ["PAYOFF_CERTIFICATE"] }) });
    world.harness.script(
      agent([
        loan("L-0005"),
        { tool: "send_whatsapp", input: (_earlier, turn) => ({ kind: "REPLY", text: `Revisé tu reclamo ${numberOf(turn)}: tu préstamo figura cancelado.` }) },
        resolve("IN_FAVOUR"),
        write((number) => `Respuesta a tu reclamo ${number}. El saldo era de $ 99.999,00.`),
        write((number) => `Respuesta a tu reclamo ${number}: tu préstamo está cancelado y te enviamos el libre deuda.`),
      ]),
    );
    const complaint = await complain(world, "cus-0005");
    const replied = outputOf(world.harness.results.find((call) => call.tool === "send_whatsapp" && String(call.input.text).includes(complaint.complaintNumber)));
    expect(replied).toMatchObject({ decision: "ALLOWED" });
    const [refused, rewritten] = world.harness.results.filter((call) => call.tool === "answer_complaint_in_writing");
    expect(errorOf(refused)).toMatchObject({ code: "GROUNDING_FAIL" });
    expect(outputOf(rewritten)).toMatchObject({ status: "SENT", attachments: expect.arrayContaining(["PAYOFF_CERTIFICATE"]) });
    expect(String(rewritten?.input.draftBody)).toContain(complaint.complaintNumber);
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "IN_FAVOUR" });
  });
});
