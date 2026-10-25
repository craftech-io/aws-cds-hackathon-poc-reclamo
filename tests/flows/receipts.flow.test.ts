// Local flows of the receipts (docs/flows-catalog.md area C, FL-018 to FL-029 and FL-111): the seed
// receipt or an upload reaches `MediaIntake` and the worker, the reader answers from Bedrock's port (the
// eval set, or a verdict the test forces) and from the deterministic fallback, and reconciliation looks
// for the line in the published settlement. A reading never applies a payment: only a line of the same
// customer does, and a receipt that does not exist is never "found".
import { describe, expect, it, vi } from "vitest";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { WHATSAPP_TEXT } from "@reclamo/bff/copy/index";
import { type CallResult, type PlanSource, type PlannedCall, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, needsChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";


const outputNamed = (earlier: readonly CallResult[], tool: string) => outputOf(earlier.filter((call) => call.tool === tool).at(-1));
const read: PlannedCall = { tool: "read_receipt", input: (_earlier, turn) => ({ evidenceId: turn.attachments.at(-1)?.evidenceId ?? "" }) };
const reconcile: PlannedCall = { tool: "reconcile_payment", input: (earlier) => ({ readingId: String(outputNamed(earlier, "read_receipt").readingId) }) };
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });
const askAgain: PlannedCall = { tool: "send_whatsapp", input: { kind: "RECEIPT_REQUEST", text: "No llego a leerlo. Mandame otra foto, con buena luz." } };
const escalate = (reason: string): PlannedCall => ({ tool: "escalate_to_human", input: { reason, summary: "Revisar el comprobante del cliente." } });

/** Asks the challenge until the customer answers it, then verifies; `onReceipt` plays the receipt turns (by their order). */
function agent(onReceipt: (receipt: number) => readonly PlannedCall[]): PlanSource {
  let receipts = 0;
  return (turn) => {
    if (turn.event.type === "RECEIPT_RECEIVED") return onReceipt(++receipts);
    if (turn.event.type !== "CUSTOMER_MESSAGE") return [];
    if (repliesToChallenge(turn)) return [verifyWritten, reply("Gracias. Mandame el comprobante.")];
    return needsChallenge(turn) ? [askChallenge] : [reply("Gracias. Mandame el comprobante.")];
  };
}

/** Bedrock's verdict for the next readings (the eval set does not carry the demo receipts). */
function bedrock(world: FlowWorld, raw: Record<string, unknown>): void {
  world.reader.forced = { kind: "READ", raw: { isReceipt: true, legibility: "CLEAR", currency: "ARS", suspiciousText: false, notes: "", ...raw } as never };
}

/** The complaint filed with its number and the customer's answer to the challenge the agent asked. */
async function complain(world: FlowWorld, customerId: string, text = PAYMENT_NOT_REFLECTED): Promise<Complaint> {
  await world.phone(customerId, { type: "text", text });
  await answerChallenge(world, customerId);
  const complaint = (await world.connector.complaints.listByCustomer("demo", customerId)).find((candidate) => candidate.origin === "LIVE");
  if (complaint === undefined) throw new Error("the complaint was not filed");
  return complaint;
}

async function current(world: FlowWorld, complaint: Complaint): Promise<Complaint | undefined> {
  return world.connector.complaints.get("demo", complaint.complaintId);
}

async function readings(world: FlowWorld, complaint: Complaint) {
  return (await world.connector.caseItems.listEvidence("demo", complaint.complaintId)).filter((evidence) => evidence.kind === "RECEIPT_READING");
}


describe("[FL-018] a published batch without the line: never found", () => {
  it("[FL-018] reconcile_payment NOT_FOUND, a person reviews it with the batches checked, nothing is applied and the clock keeps running", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent(() => [read, reconcile, escalate("RECEIPT_NOT_FOUND"), reply("No lo vemos todavía en lo que informó la red; lo revisa una persona.")]));
    const complaint = await complain(world, "cus-0018");
    await world.sendImage("cus-0018", "receipts/fake-unknown/c18-1.png");
    expect(outputOf(world.harness.results.find((call) => call.tool === "reconcile_payment"))).toMatchObject({ result: "NOT_FOUND" });
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RECEIPT_NOT_FOUND" } });
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
    const match = (await world.connector.caseItems.listEvidence("demo", complaint.complaintId)).find((evidence) => evidence.kind === "SETTLEMENT_MATCH");
    expect(match?.details).toMatchObject({ result: "NOT_FOUND" });
    expect((await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).filter((timer) => timer.kind === "SLA" && timer.status === "SCHEDULED")).toHaveLength(3);
  });
});

describe("[FL-019] a blurry receipt", () => {
  it("[FL-019] two ILLEGIBLE readings from Bedrock (never the fallback): a new photo is asked, then a person reviews it; nothing is applied", async () => {
    const world = await createFlowWorld();
    bedrock(world, { legibility: "ILLEGIBLE" });
    world.harness.script(agent((receipt) => (receipt === 1 ? [read, { tool: "update_complaint", input: { status: "AWAITING_CUSTOMER" } }, askAgain] : [read, escalate("RECEIPT_DOUBT")])));
    const complaint = await complain(world, "cus-0016");
    await world.sendImage("cus-0016", "receipts/blurry/c16-1.png");
    expect(outputOf(world.harness.results.find((call) => call.tool === "read_receipt"))).toMatchObject({ result: "UNREADABLE", source: "BEDROCK" });
    expect((await current(world, complaint))?.status).toBe("AWAITING_CUSTOMER");
    await world.sendImage("cus-0016", "receipts/blurry/c16-2.png");
    const both = await readings(world, complaint);
    expect(both).toHaveLength(2);
    expect(both.every((evidence) => evidence.details.source === "BEDROCK" && evidence.details.result === "UNREADABLE")).toBe(true);
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RECEIPT_DOUBT" } });
    expect((await current(world, complaint))?.statusHistory.map((change) => change.to)).toEqual(expect.arrayContaining(["AWAITING_CUSTOMER", "HUMAN_REVIEW"]));
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
  });
});

describe("[FL-020] a fake receipt", () => {
  it("[FL-020] an invalid check digit is INVALID_RECEIPT with its problem; the code hands it to a person (no other photo is offered) and no text calls it fake", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent(() => [read]));
    const complaint = await complain(world, "cus-0007");
    await world.sendImage("cus-0007", "receipts/fake-check/c07-1.png");
    const reading = outputOf(world.harness.results.find((call) => call.tool === "read_receipt"));
    expect(reading).toMatchObject({ result: "INVALID_RECEIPT", handedOver: true });
    expect(reading.attemptsLeft).toBeUndefined();
    expect((await world.connector.conversations.listMessages("demo", "cus-0007")).some((message) => message.direction === "OUT" && message.kind === "HANDOFF_NOTICE")).toBe(true);
    expect(JSON.stringify((await readings(world, complaint))[0]?.details)).toContain("INVALID_CHECK_DIGIT");
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RECEIPT_DOUBT" } });
    const out = (await world.connector.conversations.listMessages("demo", "cus-0007")).filter((message) => message.direction === "OUT" && (message.createdAt ?? "") > "2026-10-07T13:10:00.000Z");
    expect(out.some((message) => /falso/i.test(message.body))).toBe(false);
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
  });
});

describe("[FL-021] the same receipt in two complaints", () => {
  it("[FL-021] DUPLICATE_OF names the other open complaint on the reading and nothing is applied", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent(() => [read, reply("Ese comprobante ya está en tu reclamo anterior; lo seguimos ahí.")]));
    // The seeded R-2026-000120 is an open PAYMENT_NOT_REFLECTED of the persona: the new complaint is another one.
    const complaint = await complain(world, "cus-0017", "Me cobraron una comisión que no reconozco");
    expect(complaint.complaintNumber).toBe("R-2026-000123");
    await world.sendImage("cus-0017", "receipts/legible/c17-1.png");
    expect(outputOf(world.harness.results.find((call) => call.tool === "read_receipt"))).toMatchObject({ result: "DUPLICATE_OF", duplicateOf: "R-2026-000120" });
    const reading = (await readings(world, complaint))[0];
    expect(reading?.details).toMatchObject({ result: "DUPLICATE_OF", duplicateOf: "R-2026-000120" });
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
  });
});

describe("[FL-027] the deterministic fallback and a disagreement", () => {
  it("[FL-027] Bedrock unavailable: READ from the FALLBACK with its metric; Bedrock CLEAR with another amount: DISAGREE with both readings and a person", async () => {
    const world = await createFlowWorld();
    world.reader.forced = { kind: "UNAVAILABLE", reason: "SERVICE_ERROR", attempts: 1 };
    world.harness.script(agent(() => [read, escalate("RECEIPT_DOUBT")]));
    const complaint = await complain(world, "cus-0004");
    await world.sendImage("cus-0004", "receipts/legible/c04-1.png");
    expect(outputOf(world.harness.results.find((call) => call.tool === "read_receipt"))).toMatchObject({ result: "READ", source: "FALLBACK" });
    expect(world.logs.some((line) => line.includes("ReceiptReadFallbacks"))).toBe(true);

    bedrock(world, { network: "SUR", operationCode: "SUR-20261002-010007-1", amount: 99_999, paidAtLocal: "2026-10-02T13:15" });
    world.harness.script(agent(() => [read, escalate("RECEIPT_DOUBT")]));
    await world.sendImage("cus-0004", "receipts/legible/c04-1.png");
    const disagree = outputOf(world.harness.results.filter((call) => call.tool === "read_receipt").at(-1));
    expect(disagree).toMatchObject({ result: "DISAGREE" });
    expect(disagree.fields).toBeUndefined();
    const last = (await readings(world, complaint)).find((evidence) => evidence.details.result === "DISAGREE");
    expect(JSON.stringify(last?.details)).toContain("disagreement");
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RECEIPT_DOUBT" } });
  });
});

describe("[FL-028] instructions printed in the receipt image", () => {
  it("[FL-028] suspiciousText is audited, the fields only reconcile, and no text of the image reaches the envelope or an outbound message", async () => {
    const world = await createFlowWorld();
    bedrock(world, { network: "SUR", operationCode: "SUR-20261001-010014-9", amount: 52_935, paidAtLocal: "2026-10-01T14:00", suspiciousText: true });
    world.harness.script(agent(() => [read, reconcile, escalate("RECEIPT_DOUBT")]));
    const complaint = await complain(world, "cus-0019");
    await world.sendImage("cus-0019", "receipts/injection/c19-1.png");
    expect((await world.connector.audit.listByAction("demo", "SUSPICIOUS_RECEIPT_TEXT")).map((entry) => entry.refs?.complaintId)).toContain(complaint.complaintId);
    expect(outputOf(world.harness.results.find((call) => call.tool === "reconcile_payment"))).toMatchObject({ result: "MATCHED", match: { amount: { amount: 52_935 } } });
    const receiptTurn = world.harness.turns.find((turn) => turn.event.type === "RECEIPT_RECEIVED");
    expect(receiptTurn?.request.envelope).not.toMatch(/IGNOR[AÁ] LAS INSTRUCCIONES|999\.999/i);
    expect(world.mocks.coreStore.dump().filter((item) => item.entity === "Payment" && item.customerId === "cus-0019" && item.appliedAtSim !== undefined && String(item.appliedAtSim) >= "2026-10-07")).toEqual([]);
    const out = (await world.connector.conversations.listMessages("demo", "cus-0019")).filter((message) => message.direction === "OUT");
    expect(out.some((message) => message.body.includes("999.999"))).toBe(false);
  });
});

describe("[FL-029] an image that is not a receipt, a wrong format or size, a scan that does not complete", () => {
  it("[FL-029] a selfie is NOT_A_RECEIPT and a new photo is asked", async () => {
    const world = await createFlowWorld();
    bedrock(world, { isReceipt: false });
    world.harness.script(agent(() => [read, askAgain]));
    await complain(world, "cus-0020");
    await world.sendImage("cus-0020", "receipts/not-receipt/c20-1.png");
    expect(outputOf(world.harness.results.find((call) => call.tool === "read_receipt"))).toMatchObject({ result: "NOT_A_RECEIPT" });
    expect((await world.connector.conversations.listMessages("demo", "cus-0020")).some((message) => message.kind === "RECEIPT_REQUEST")).toBe(true);
  });

  it("[FL-029] an upload over 3.75 MB or with a wrong magic number is deleted with its fixed reply and never read; a failed scan or no result in 120 s is IMAGE_NOT_PROCESSED", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent(() => [read]));
    await complain(world, "cus-0020");
    const png = world.s3.get("Seed", "receipts/not-receipt/c20-1.png")?.bytes ?? new Uint8Array();
    const heavy = new Uint8Array(4_500_000);
    heavy.set(png.subarray(0, 64));
    const cases: { key: string; bytes: Uint8Array; verdict?: "FAILED" }[] = [
      { key: "up/demo/heavy.png", bytes: heavy },
      { key: "up/demo/not-an-image.png", bytes: new TextEncoder().encode("%PDF-1.7 not an image") },
      { key: "up/demo/failed-scan.png", bytes: png, verdict: "FAILED" },
    ];
    for (const item of cases) {
      await world.upload(item.key, item.bytes);
      await world.mediaScanned(item.key, item.verdict ?? "NO_THREATS_FOUND");
      await world.sendImage("cus-0020", item.key);
    }
    expect(world.s3.get("Media", "up/demo/heavy.png")).toBeUndefined();
    expect(world.s3.get("Media", "up/demo/not-an-image.png")).toBeUndefined();
    expect(world.reader.reads).toEqual([]);
    const fixed = (await world.connector.conversations.listMessages("demo", "cus-0020")).filter((message) => message.direction === "OUT").map((message) => message.body);
    expect(fixed.some((body) => body.includes(WHATSAPP_TEXT.MEDIA_TOO_LARGE))).toBe(true);
    expect(fixed.some((body) => body.includes(WHATSAPP_TEXT.IMAGE_NOT_PROCESSED))).toBe(true);
    expect((await world.connector.audit.listByAction("demo", "SCAN_NOT_COMPLETED")).map((entry) => entry.outcome)).toContain("FAILED");

    await world.upload("up/demo/no-result.png", png);
    await world.sendImage("cus-0020", "up/demo/no-result.png");
    world.advanceReal(121_000);
    await world.settle();
    expect((await world.connector.audit.listByAction("demo", "SCAN_NOT_COMPLETED")).map((entry) => entry.outcome)).toContain("TIMEOUT");
    expect((await world.connector.runtime.listPending("demo")).filter((pending) => pending.kind === "SCAN")).toEqual([]);
    expect(world.reader.reads).toEqual([]);
  });
});

describe("[FL-111] a valid receipt of another payer", () => {
  it("[FL-111] the line exists but is another customer's: PAYER_MISMATCH goes to a person with RECEIPT_DOUBT, with no claim and no data of the other payer", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent(() => [read, reconcile]));
    const complaint = await complain(world, "cus-0041");
    const claims = world.mocks.coreStore.dump().filter((item) => item.entity === "Payment").length;
    await world.sendImage("cus-0041", "receipts/other-payer/c41-1.png");
    const reconciled = outputOf(world.harness.results.find((call) => call.tool === "reconcile_payment"));
    expect(reconciled).toMatchObject({ result: "PAYER_MISMATCH", handedOver: true });
    expect(JSON.stringify(reconciled)).not.toContain("cus-1017");
    expect(reconciled.match).toBeUndefined();
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RECEIPT_DOUBT" } });
    expect(world.mocks.coreStore.dump().filter((item) => item.entity === "Payment")).toHaveLength(claims);
    const out = (await world.connector.conversations.listMessages("demo", "cus-0041")).filter((message) => message.direction === "OUT");
    expect(out.some((message) => message.body.includes("cus-1017"))).toBe(false);
    expect((await world.connector.audit.listByRef("demo", complaint.complaintId)).some((entry) => entry.outcome === "PAYER_MISMATCH") || (await world.connector.audit.listByAction("demo", "PAYER_MISMATCH")).length > 0 || world.logs.some((line) => line.includes("PAYER_MISMATCH"))).toBe(true);
  });
});
