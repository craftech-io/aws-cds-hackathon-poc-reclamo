import { describe, expect, it } from "vitest";
import { derivedMessageId } from "../channels/whatsapp/records";
import { TEST_SIM_KEYS, simEvent } from "../channels/whatsapp/testing";
import { buildSimulatedEvent, newSimulatedWamid } from "../channels/whatsapp/sim-envelope";
import { issueNonces } from "../channels/whatsapp/nonces";
import { personaScript } from "../copy";
import { sha256Hex } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { receiptPng, SUR_FIELDS } from "../receipts/testing";
import { coreConsentRecorder, coreCustomerDirectory } from "../intake/stage";
import { type IntakeRig, CUSTOMER, TEST_NOW, TEST_PHONE, WORLD, fakeCore, intakeRig, linesNamed, scriptedModel, seedHolidays, seedReceiptHash, sentEvents } from "../intake/testing";
import { createInboundWhatsAppHandler } from "./inbound-whatsapp";

const C01 = personaScript("C01")?.messages[0].text ?? "";
let wamidSeq = 0;
const nextWamid = (): string => newSimulatedWamid(TEST_NOW.getTime() + ++wamidSeq);

function handlerOf(rig: IntakeRig) {
  return createInboundWhatsAppHandler({ deps: (_log, coldStart) => rig.depsFor(coldStart), logger: () => rig.deps.log });
}

async function send(rig: IntakeRig, text: string, wamid = nextWamid()) {
  const summary = await handlerOf(rig)(simEvent(WORLD, { type: "text", text }, wamid), { awsRequestId: "req-0000000001" });
  return { summary, message: summary.records[0]?.messages[0], wamid };
}

async function complaintsOf(rig: IntakeRig) {
  return rig.mc.connector.complaints.listByCustomer(WORLD, CUSTOMER);
}

describe("a complaint gets its number before its turn [FL-010]", () => {
  it("[FL-010] numbers C01's script by rule, acknowledges through the gate and only then enqueues the turn", async () => {
    const model = scriptedModel({ kind: "UNAVAILABLE", reason: "TIMEOUT" });
    const rig = await intakeRig({ model });
    await seedHolidays(rig);
    const { message } = await send(rig, C01);
    expect(message).toMatchObject({ outcome: "INTAKE", intake: "ACKNOWLEDGED", customerId: CUSTOMER });

    const [complaint] = await complaintsOf(rig);
    expect(complaint).toMatchObject({ complaintNumber: "R-2026-000001", status: "REGISTERED", kind: "RECLAMO", type: "PAYMENT_NOT_REFLECTED" });
    const register = await rig.mc.connector.chains.listRegisterByComplaint(WORLD, 1, "R-2026-000001");
    expect(register.map((entry) => entry.eventType)).toEqual(["FILED"]);
    expect(register[0]?.presenter).toEqual({ docType: "DNI", docNumberMasked: "••••4417" });
    expect(await rig.mc.connector.timers.listByOwner(WORLD, `CMP#${complaint?.complaintId}`)).toHaveLength(3);

    const [ack] = rig.gate.requests;
    expect(ack).toMatchObject({ sender: "SYSTEM", channel: "WHATSAPP", kind: "COMPLAINT_ACK", complaintId: complaint?.complaintId, buttons: [{ action: "ACCEPT_EMAIL", ref: complaint?.complaintId }, { action: "DECLINE_EMAIL", ref: complaint?.complaintId }] });
    expect(ack?.text).toContain("R-2026-000001");
    expect(ack?.text).toContain("22/10");
    expect(rig.timeline).toEqual(["gate:COMPLAINT_ACK", "sqs:CUSTOMER_MESSAGE"]);
    expect(sentEvents(rig)[0]).toMatchObject({ type: "CUSTOMER_MESSAGE", worldId: WORLD, customerId: CUSTOMER, epoch: 1, payload: { complaintIds: [complaint?.complaintId] } });
    expect(rig.sent[0]?.QueueUrl?.endsWith("CustomerEvents")).toBe(true);
    expect(model.calls).toHaveLength(0);

    const [classified] = await rig.mc.connector.audit.listByAction(WORLD, "INTAKE_CLASSIFIED");
    expect(classified).toMatchObject({ outcome: "RECLAMO", actor: "SYSTEM", detail: { source: "RULE", rule: "PAID_NOT_REFLECTED", type: "PAYMENT_NOT_REFLECTED" } });
    expect(JSON.stringify(classified)).not.toContain("Pagué");
  });

  it("[FL-010] measures ackLatencyMs from the envelope to the transport's acceptance, with the cold start marked", async () => {
    const rig = await intakeRig({ ackAcceptedAt: new Date(TEST_NOW.getTime() + 850) });
    const handler = handlerOf(rig);
    await handler(simEvent(WORLD, { type: "text", text: C01 }, nextWamid()), { awsRequestId: "req-0000000001" });
    await handler(simEvent(WORLD, { type: "text", text: "Me cobraron un interés que no entiendo" }, nextWamid()), { awsRequestId: "req-0000000002" });
    const samples = linesNamed(rig, "intake.ack_latency");
    expect(samples.map((line) => [line.metric, line.ackLatencyMs, line.coldStart])).toEqual([
      ["AckLatency", 850, true],
      ["AckLatency", 850, false],
    ]);
    const kpis = await rig.mc.connector.metrics.list(WORLD, { source: "WORLD", runId: "world" });
    expect(kpis.map((row) => [row.ackLatencyMs, row.coldStart]).sort()).toEqual([
      [850, false],
      [850, true],
    ]);
  });

  it("[FL-010] with the agent's kill switch on, a complaint is still numbered by rule and a free text never reaches the model", async () => {
    const model = scriptedModel({ kind: "CLASSIFIED", result: { kind: "OUT_OF_SCOPE", confidence: 0.9 } });
    const rig = await intakeRig({ model });
    await rig.mc.connector.runtime.setKill({ on: true, by: "BUDGET", atReal: TEST_NOW.toISOString() });
    expect((await send(rig, C01)).message?.intake).toBe("ACKNOWLEDGED");
    expect((await send(rig, "¿Me dan otro préstamo para irme de vacaciones?")).message?.intake).toBe("TURN");
    expect(model.calls).toHaveLength(0);
    expect(sentEvents(rig).map((event) => event.type)).toEqual(["CUSTOMER_MESSAGE", "CUSTOMER_MESSAGE"]);
  });
});

describe("the same complaint again keeps its number [FL-013]", () => {
  it("[FL-013] '¿y mi pago?' repeats the existing number and opens a turn about that complaint", async () => {
    const rig = await intakeRig();
    await send(rig, C01);
    const { message } = await send(rig, "¿y mi pago?");
    expect(message?.intake).toBe("ACKNOWLEDGED_EXISTING");
    const complaints = await complaintsOf(rig);
    expect(complaints).toHaveLength(1);
    expect(rig.gate.requests.map((request) => request.kind)).toEqual(["COMPLAINT_ACK", "COMPLAINT_ACK"]);
    expect(rig.gate.requests[1]?.text).toContain("sigue abierto");
    expect(rig.gate.requests[1]?.text).toContain("R-2026-000001");
    expect(sentEvents(rig)[1]?.payload).toMatchObject({ complaintIds: [complaints[0]?.complaintId] });
  });
});

describe("redeliveries repeat nothing [FL-106]", () => {
  it("[FL-106] the same wamid twice: one number, one acknowledgement, one turn", async () => {
    const rig = await intakeRig();
    const first = await send(rig, C01);
    const again = await send(rig, C01, first.wamid);
    expect(again.message?.outcome).toBe("DUPLICATE");
    expect(await complaintsOf(rig)).toHaveLength(1);
    expect(rig.gate.requests).toHaveLength(1);
    expect(sentEvents(rig)).toHaveLength(1);
  });
});

describe("a number that is not a customer [FL-002]", () => {
  it("[FL-002] never reaches the classifier, the model or the queue, is audited DENY UNKNOWN_SENDER and gets the fixed text", async () => {
    const model = scriptedModel({ kind: "CLASSIFIED", result: { kind: "RECLAMO", type: "PAYMENT_NOT_REFLECTED", confidence: 0.99 } });
    const rig = await intakeRig({ unlinked: true, model });
    const { message } = await send(rig, "Hola, quiero hacer un reclamo por un pago");
    expect(message?.outcome).toBe("UNKNOWN_SENDER");
    expect(model.calls).toHaveLength(0);
    expect(rig.sent).toHaveLength(0);
    expect(rig.coreCalls).toEqual(["getCustomerByPhone"]);
    expect((await rig.mc.connector.audit.listByAction(WORLD, "DENY")).map((entry) => entry.outcome)).toEqual(["UNKNOWN_SENDER"]);
    expect(await rig.mc.connector.audit.listByAction(WORLD, "INTAKE_CLASSIFIED")).toHaveLength(0);
    expect(linesNamed(rig, "intake.reply_unrouted")).toHaveLength(0);
    expect(rig.gate.requests).toHaveLength(0);
    expect(rig.unknownReplies).toEqual([expect.objectContaining({ worldId: WORLD, phoneHash: rig.phoneHash, textKey: "UNKNOWN_SENDER" })]);
  });
});

describe("origin before everything", () => {
  it("a simulated envelope whose signature does not verify is rejected before any read of the customer", async () => {
    const rig = await intakeRig();
    const event = buildSimulatedEvent("a-different-console-key-0123456789abcd", { kid: "console", worldId: WORLD, from: TEST_PHONE, wamid: nextWamid(), content: { type: "text", text: C01 }, at: TEST_NOW });
    const summary = await handlerOf(rig)(event, { awsRequestId: "req-0000000001" });
    expect(summary.records[0]).toMatchObject({ accepted: false, reason: "SIM_SIGNATURE_INVALID" });
    expect(rig.coreCalls).toHaveLength(0);
    expect(rig.gate.requests).toHaveLength(0);
    expect(rig.sent).toHaveLength(0);
    expect((await rig.mc.connector.audit.listByAction(WORLD, "INBOUND_REJECTED")).map((entry) => entry.outcome)).toEqual(["SIM_SIGNATURE_INVALID"]);
  });

  it("a message to a world that is resetting is discarded and audited WORLD_RESETTING", async () => {
    const rig = await intakeRig({ status: "RESETTING" });
    const { message } = await send(rig, C01);
    expect(message).toMatchObject({ outcome: "DISCARDED", reason: "RESETTING" });
    expect((await rig.mc.connector.audit.listByAction(WORLD, "WORLD_RESETTING")).map((entry) => entry.outcome)).toEqual(["DISCARDED"]);
    expect(rig.gate.requests).toHaveLength(0);
    expect(rig.sent).toHaveLength(0);
  });
});

describe("questions, a person and the model's turn", () => {
  it("[FL-008] an account question opens a turn without a number", async () => {
    const rig = await intakeRig();
    const { message } = await send(rig, personaScript("C08")?.messages[0].text ?? "");
    expect(message?.intake).toBe("TURN");
    expect(await complaintsOf(rig)).toHaveLength(0);
    expect(rig.gate.requests).toHaveLength(0);
    expect(sentEvents(rig)[0]).toMatchObject({ type: "CUSTOMER_MESSAGE", payload: { complaintIds: [] } });
  });

  it("[FL-060] 'quiero hablar con alguien' hands the open complaint to a person without a turn", async () => {
    const rig = await intakeRig();
    await send(rig, C01);
    const { message } = await send(rig, "quiero hablar con alguien");
    expect(message?.intake).toBe("HANDOFF");
    const [complaint] = await complaintsOf(rig);
    expect(complaint?.status).toBe("HUMAN_REVIEW");
    expect(rig.gate.requests.at(-1)).toMatchObject({ kind: "HANDOFF_NOTICE", sender: "SYSTEM", complaintId: complaint?.complaintId });
    expect(sentEvents(rig).map((event) => event.type)).toEqual(["CUSTOMER_MESSAGE"]);
  });

  it("a guest's own words go to the model once and open a turn", async () => {
    const model = scriptedModel({ kind: "CLASSIFIED", result: { kind: "OUT_OF_SCOPE", confidence: 0.92 } });
    const rig = await intakeRig({ model });
    expect((await send(rig, "Escribime un poema")).message?.intake).toBe("TURN");
    expect(model.calls).toEqual(["Escribime un poema"]);
    const [classified] = await rig.mc.connector.audit.listByAction(WORLD, "INTAKE_CLASSIFIED");
    expect(classified).toMatchObject({ outcome: "OUT_OF_SCOPE", detail: { source: "MODEL", confidence: 0.92 } });
  });
});

describe("intakeOnly worlds (EV-3)", () => {
  it("records the classification with the model's latency and never enqueues a turn", async () => {
    const worldId = "qa-4242-1-ev3";
    const model = scriptedModel({ kind: "CLASSIFIED", result: { kind: "OUT_OF_SCOPE", confidence: 0.92 } });
    const rig = await intakeRig({ worldId, model });
    const settings = await rig.mc.connector.worlds.getSettings(worldId);
    if (settings === undefined) throw new Error("the rig wrote no settings");
    await rig.mc.connector.worlds.putSettings({ ...settings, intakeOnly: true }, settings.version);
    const event = buildSimulatedEvent(TEST_SIM_KEYS.qa, { kid: "qa", worldId, from: TEST_PHONE, wamid: nextWamid(), content: { type: "text", text: "Escribime un poema" }, at: TEST_NOW });
    const summary = await handlerOf(rig)(event, { awsRequestId: "req-0000000009" });
    expect(summary.records[0]?.messages[0]?.intake).toBe("TURN");
    expect(model.calls).toEqual(["Escribime un poema"]);
    const [classified] = await rig.mc.connector.audit.listByAction(worldId, "INTAKE_CLASSIFIED");
    expect(classified).toMatchObject({ outcome: "OUT_OF_SCOPE", detail: { source: "MODEL", modelMs: expect.any(Number) } });
    expect(sentEvents(rig).filter((sent) => sent.type === "CUSTOMER_MESSAGE")).toEqual([]);
  });
});

describe("buttons and keywords decided by code", () => {
  async function tap(rig: IntakeRig, action: "ACCEPT_EMAIL" | "DECLINE_EMAIL", complaintId: string) {
    const [nonce] = await issueNonces(rig.mc.connector, { worldId: WORLD, customerId: CUSTOMER, phoneHash: rig.phoneHash, messageId: "msg-ack-1", buttons: [{ action, complaintId }], now: TEST_NOW });
    return handlerOf(rig)(simEvent(WORLD, { type: "button_reply", nonce: nonce ?? "", title: "Sí, a ese email" }, nextWamid()), { awsRequestId: "req-0000000003" });
  }

  it("[FL-011] 'Sí, a ese email' records the consent once, sends ACK_EMAIL with the PDF and confirms it", async () => {
    const rig = await intakeRig();
    await send(rig, C01);
    const [complaint] = await complaintsOf(rig);
    const summary = await tap(rig, "ACCEPT_EMAIL", complaint?.complaintId ?? "");
    expect(summary.records[0]?.messages[0]?.outcome).toBe("EMAIL_CONSENT");
    expect((await complaintsOf(rig))[0]?.emailAnswerConsent).toMatchObject({ status: "ACCEPTED", textVersion: "email-answer-v1" });
    const email = rig.gate.requests.find((request) => request.kind === "ACK_EMAIL");
    expect(email).toMatchObject({ channel: "EMAIL", sender: "SYSTEM", complaintId: complaint?.complaintId, attachments: [{ docKind: "ACK" }] });
    expect(rig.gate.requests.at(-1)).toMatchObject({ kind: "REPLY", channel: "WHATSAPP" });
    expect(rig.gate.requests.at(-1)?.text).toContain("s•••@simulator.amazonses.com");
  });

  it("[FL-006] 'STOP' confirms the opt-out by the gate and audits whether the consent store took it", async () => {
    const rig = await intakeRig();
    expect((await send(rig, "STOP")).message?.outcome).toBe("OPTED_OUT");
    expect(rig.gate.requests).toMatchObject([{ kind: "OPT_OUT_CONFIRMATION", sender: "SYSTEM" }]);
    expect((await rig.mc.connector.audit.listByAction(WORLD, "OPT_OUT")).map((entry) => entry.outcome)).toEqual(["NOT_RECORDED"]);

    const recorded: string[] = [];
    const accepting = await intakeRig({ consent: { optOut: async (input) => (recorded.push(input.customerId), true) } });
    await send(accepting, "STOP");
    expect(recorded).toEqual([CUSTOMER]);
    expect((await accepting.mc.connector.audit.listByAction(WORLD, "OPT_OUT")).map((entry) => entry.outcome)).toEqual(["RECORDED"]);
  });
});

describe("images bound to their scan registry", () => {
  it("[FL-101] a synthetic receipt with a known hash follows the message's turn, bound to the new complaint", async () => {
    const rig = await intakeRig();
    const wamid = nextWamid();
    const messageId = derivedMessageId(WORLD, wamid, "in");
    const bytes = receiptPng(SUR_FIELDS);
    rig.objects.put(`W/${WORLD}/sim/${messageId}/0.png`, bytes);
    await seedReceiptHash(rig, sha256Hex(bytes), "receipts/legible/C04-1.png");
    const simMediaId = `SIM${"ab".repeat(16)}`;
    await rig.mc.connector.claims.putSimMedia({ worldId: WORLD, simMediaId, s3Key: "receipts/legible/C04-1.png", contentType: "image/png", createdAtReal: TEST_NOW.toISOString() });
    await handlerOf(rig)(simEvent(WORLD, { type: "image", simMediaId, mimeType: "image/png", caption: personaScript("C04")?.messages[0].text ?? "" }, wamid), { awsRequestId: "req-0000000004" });

    const [complaint] = await complaintsOf(rig);
    expect(rig.timeline).toEqual(["gate:COMPLAINT_ACK", "sqs:CUSTOMER_MESSAGE", "sqs:RECEIPT_RECEIVED"]);
    const receipt = sentEvents(rig).find((event) => event.type === "RECEIPT_RECEIVED");
    expect(receipt?.payload).toMatchObject({ messageId, complaintId: complaint?.complaintId, image: { scan: "SEED_SKIPPED", source: "SEED_COPY", sha256: sha256Hex(bytes) } });
    // The worker files the RECEIPT_IMAGE evidence (worker/receipt.ts); the intake only hands the image over.
    expect(await rig.mc.connector.caseItems.listEvidence(WORLD, complaint?.complaintId ?? "")).toEqual([]);
  });

  it("[FL-101] an image without a scan result waits for it: the 120 s deadline goes to ScanDeadlines", async () => {
    const rig = await intakeRig();
    const simMediaId = `SIM${"cd".repeat(16)}`;
    const upload = `up/${WORLD}/msg-upload/0.png`;
    rig.bucket.put(upload, 120_000, "image/png");
    await rig.mc.connector.scans.announce({ worldId: WORLD, announceKey: upload, s3Key: upload, source: "SIMULATOR", createdAtReal: TEST_NOW.toISOString() });
    await rig.mc.connector.claims.putSimMedia({ worldId: WORLD, simMediaId, s3Key: upload, contentType: "image/png", createdAtReal: TEST_NOW.toISOString() });
    await handlerOf(rig)(simEvent(WORLD, { type: "image", simMediaId, mimeType: "image/png" }, nextWamid()), { awsRequestId: "req-0000000005" });
    const deadline = rig.sent.find((input) => input.QueueUrl?.endsWith("ScanDeadlines"));
    expect(deadline).toMatchObject({ DelaySeconds: 120 });
    expect(JSON.parse(deadline?.MessageBody ?? "{}")).toMatchObject({ kind: "SCAN_DEADLINE", worldId: WORLD, announceKey: upload });
    expect(await rig.mc.connector.scans.get(WORLD, upload)).toMatchObject({ customerId: CUSTOMER });
  });
});

describe("the entry", () => {
  it("logs the summary of every invocation without a phone number or a text", async () => {
    const lines: string[] = [];
    const rig = await intakeRig();
    const handler = createInboundWhatsAppHandler({ deps: (_log, coldStart) => rig.depsFor(coldStart), logger: (id) => createLogger({ correlationId: id, level: "debug", sink: (line) => lines.push(line) }) });
    await handler(simEvent(WORLD, { type: "text", text: C01 }, nextWamid()), { awsRequestId: "req-0000000006" });
    const done = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.message === "inbound_whatsapp.done");
    expect(done).toMatchObject({ recordCount: 1, messageCount: 1, outcomes: ["INTAKE"], coldStart: true });
    expect(lines.join("\n")).not.toContain(TEST_PHONE.slice(1));
    expect(lines.join("\n")).not.toContain("Pagué");
  });
});

describe("the stage ports", () => {
  it("[FL-002] resolves a phone hash through the core and reads its NOT_FOUND as a number without a customer", async () => {
    const rig = await intakeRig();
    const calls: string[] = [];
    const directory = coreCustomerDirectory(() => fakeCore({ [`${WORLD}#${rig.phoneHash}`]: CUSTOMER }, calls), rig.mc.connector, "corr-stage-0001");
    expect(await directory.findByPhoneHash(WORLD, rig.phoneHash)).toEqual({ customerId: CUSTOMER });
    expect(await directory.findByPhoneHash(WORLD, "0".repeat(64))).toBeUndefined();
    expect(calls).toEqual(["getCustomerByPhone", "getCustomerByPhone"]);
  });

  it("[FL-006] records the opt-out in the core, idempotent by the message that carried it", async () => {
    const calls: string[] = [];
    const recorder = coreConsentRecorder(() => fakeCore({}, calls), "corr-stage-0002");
    expect(await recorder.optOut({ worldId: WORLD, customerId: CUSTOMER, atSim: TEST_NOW.toISOString(), via: "KEYWORD", caller: { kind: "CHANNEL", worldId: WORLD, eventId: "wa-in-1" } })).toBe(true);
    expect(calls).toEqual(["recordWhatsAppOptOut"]);
  });
});
