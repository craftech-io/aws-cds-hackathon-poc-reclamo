import { GetWhatsAppMessageMediaCommand, type GetWhatsAppMessageMediaCommandInput, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { SIM_NOW, TEST_NOW } from "../../connector/testing";
import { processWhatsAppEvent } from "./inbound";
import { issueNonces } from "./nonces";
import { TEST_PHONE, eumMessage, fixture, inboundRig, liveEvent, liveRecord, seedWorld, simEvent, testPhoneHash } from "./testing";

const eum = mockClient(SocialMessagingClient);
afterEach(() => eum.reset());

const SIM_ISO = new Date(SIM_NOW).toISOString();
const WA_ID = TEST_PHONE.slice(1);

async function simulatedRig(worldId = "g07", options: { rateLimitPerHour?: number; status?: "READY" | "RESETTING" } = {}) {
  const phoneHash = await testPhoneHash();
  const rig = inboundRig({ customers: { [`${worldId}#${phoneHash}`]: "cus-0008" } });
  await seedWorld(rig.mc, worldId, options);
  return { ...rig, phoneHash };
}

async function liveRig(options: { demoMode?: "live" | "simulated"; livePhone?: boolean } = {}) {
  const phoneHash = await testPhoneHash();
  const rig = inboundRig({
    customers: { [`demo#${phoneHash}`]: "cus-0004" },
    liveWorlds: ["demo"],
    liveMedia: { phoneNumberId: "phone-number-id-0123456789abcdef0123456789abcdef", mediaBucketName: "reclamo-poc-media", client: new SocialMessagingClient({ region: "us-east-1" }), retry: { sleep: async () => undefined } },
  });
  await seedWorld(rig.mc, "demo", { mode: options.demoMode ?? "live" });
  await seedWorld(rig.mc, "g07");
  if (options.livePhone ?? true) await rig.mc.connector.claims.putLivePhone({ phoneHash, worldId: "demo" });
  return { ...rig, phoneHash };
}

const text = (body: string, wamid = "wamid.LIVE.0001") => fixture("entry-text.json", { FROM: WA_ID, WAMID: wamid, TEXT: body });

describe("first message of a customer [FL-001]", () => {
  it("[FL-001] verifies the origin, resolves the phone, opens the conversation and its window and hands the masked text to the intake", async () => {
    const rig = await simulatedRig();
    const summary = await processWhatsAppEvent(simEvent("g07", { type: "text", text: "hola" }), rig.deps);
    expect(summary.records[0]).toMatchObject({ accepted: true, origin: "SIMULATED" });
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "INTAKE", worldId: "g07", customerId: "cus-0008", mode: "simulated", intake: "ACCEPTED" });
    const meta = await rig.mc.connector.conversations.getMeta("g07", "cus-0008");
    expect(meta).toMatchObject({ control: "AGENT", sessionEpoch: 0, disclosedEpochs: [], lastInboundAtSim: SIM_ISO, windowOpenUntilSim: new Date(Date.parse(SIM_NOW) + 24 * 3_600_000).toISOString() });
    const [message] = await rig.mc.connector.conversations.listMessages("g07", "cus-0008");
    expect(message).toMatchObject({ direction: "IN", channel: "WHATSAPP", body: "hola", status: "RECEIVED", simulated: true, atSim: SIM_ISO });
    expect(rig.recorded.intake[0]).toMatchObject({ worldId: "g07", epoch: 1, customerId: "cus-0008", origin: "SIMULATED", messageId: message?.messageId, text: { text: "hola" }, receivedAtReal: TEST_NOW.toISOString() });
    expect(rig.recorded.replies).toHaveLength(0);
  });

  it("[FL-059] stores and hands over the text already masked", async () => {
    const rig = await simulatedRig();
    await processWhatsAppEvent(simEvent("g07", { type: "text", text: "mi clave es 4471 y la tarjeta 4509 9535 6623 3704" }), rig.deps);
    const [message] = await rig.mc.connector.conversations.listMessages("g07", "cus-0008");
    expect(message?.body).toBe("mi clave es [CLAVE] y la tarjeta [TARJETA]");
    expect(rig.recorded.intake[0]?.text.text).toBe("mi clave es [CLAVE] y la tarjeta [TARJETA]");
  });
});

describe("number without a customer [FL-002]", () => {
  it("[FL-002] answers the fixed text without a turn and audits DENY UNKNOWN_SENDER", async () => {
    const rig = inboundRig();
    await seedWorld(rig.mc, "g07");
    const summary = await processWhatsAppEvent(simEvent("g07", { type: "text", text: "hola" }), rig.deps);
    expect(summary.records[0]?.messages[0]?.outcome).toBe("UNKNOWN_SENDER");
    expect(rig.recorded.intake).toHaveLength(0);
    expect(rig.recorded.replies).toEqual([expect.objectContaining({ textKey: "UNKNOWN_SENDER", kind: "REPLY", waId: WA_ID, worldId: "g07" })]);
    expect(rig.recorded.replies[0]?.customerId).toBeUndefined();
    const denied = await rig.mc.connector.audit.listByAction("g07", "DENY");
    expect(denied.map((entry) => [entry.outcome, entry.actor])).toEqual([["UNKNOWN_SENDER", "SYSTEM"]]);
  });
});

describe("duplicates and redeliveries [FL-106]", () => {
  it("[FL-106] processes the same wamid once: one message, one intake, one count", async () => {
    const rig = await simulatedRig();
    const event = simEvent("g07", { type: "text", text: "pagué y no se refleja" });
    await processWhatsAppEvent(event, rig.deps);
    const second = await processWhatsAppEvent(event, rig.deps);
    expect(second.records[0]?.messages[0]?.outcome).toBe("DUPLICATE");
    expect(rig.recorded.intake).toHaveLength(1);
    expect(await rig.mc.connector.conversations.listMessages("g07", "cus-0008")).toHaveLength(1);
    expect(await rig.mc.connector.caps.peek({ kind: "RATE", worldId: "g07", phoneHash: rig.phoneHash, at: TEST_NOW })).toBe(1);
  });

  it("[FL-106] runs a delivery again when the first attempt failed half way, without a second message", async () => {
    const rig = await simulatedRig();
    let fail = true;
    const intake = rig.deps.intake;
    const deps = { ...rig.deps, intake: { accept: async (message: Parameters<typeof intake.accept>[0]) => (fail ? Promise.reject(new Error("queue down")) : intake.accept(message)) } };
    const event = simEvent("g07", { type: "text", text: "pagué y no se refleja" });
    await expect(processWhatsAppEvent(event, deps)).rejects.toThrow("queue down");
    fail = false;
    const retried = await processWhatsAppEvent(event, deps);
    expect(retried.records[0]?.messages[0]?.outcome).toBe("INTAKE");
    expect(await rig.mc.connector.conversations.listMessages("g07", "cus-0008")).toHaveLength(1);
  });
});

describe("limits and world state", () => {
  it("[FL-105] refuses past the real-hour limit with one notice and DENY RATE_LIMIT, without a turn", async () => {
    const rig = await simulatedRig("g07", { rateLimitPerHour: 2 });
    const wamids = ["1", "2", "3", "4"].map((n) => `wamid.SIM.01K6ZT000000000000000000R${n}`);
    const outcomes = [];
    for (const wamid of wamids) outcomes.push((await processWhatsAppEvent(simEvent("g07", { type: "text", text: "hola" }, wamid), rig.deps)).records[0]?.messages[0]?.outcome);
    expect(outcomes).toEqual(["INTAKE", "INTAKE", "RATE_LIMITED", "RATE_LIMITED"]);
    expect(rig.recorded.intake).toHaveLength(2);
    expect(rig.recorded.replies.filter((reply) => reply.textKey === "RATE_LIMITED")).toHaveLength(1);
    expect((await rig.mc.connector.audit.listByAction("g07", "DENY")).map((entry) => entry.outcome)).toEqual(["RATE_LIMIT", "RATE_LIMIT"]);
  });

  it("discards (and audits) a message for a world that is being reset", async () => {
    const rig = await simulatedRig("g07", { status: "RESETTING" });
    const summary = await processWhatsAppEvent(simEvent("g07", { type: "text", text: "hola" }), rig.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "DISCARDED", reason: "RESETTING" });
    expect(await rig.mc.connector.audit.listByAction("g07", "WORLD_RESETTING")).toHaveLength(1);
    expect(rig.recorded.intake).toHaveLength(0);
  });

  it("[FL-029] answers an audio with the fixed text and never downloads it", async () => {
    const rig = await liveRig();
    const summary = await processWhatsAppEvent(liveEvent(fixture("entry-audio.json", { FROM: WA_ID, WAMID: "wamid.LIVE.AUDIO" })), rig.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "MEDIA_REJECTED", reason: "UNSUPPORTED_TYPE" });
    expect(rig.recorded.replies).toEqual([expect.objectContaining({ textKey: "MEDIA_UNSUPPORTED", kind: "RECEIPT_REQUEST" })]);
    expect(eum.commandCalls(GetWhatsAppMessageMediaCommand)).toHaveLength(0);
  });
});

describe("simulated documents", () => {
  it("[FL-029] answers a simulated PDF with the fixed text and never looks for its media", async () => {
    const rig = await simulatedRig();
    const summary = await processWhatsAppEvent(simEvent("g07", { type: "document", simMediaId: `SIM${"0".repeat(32)}`, mimeType: "application/pdf" }), rig.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "MEDIA_REJECTED", reason: "UNSUPPORTED_TYPE" });
    expect(rig.recorded.replies).toEqual([expect.objectContaining({ textKey: "MEDIA_UNSUPPORTED", kind: "RECEIPT_REQUEST" })]);
    expect(rig.recorded.intake).toHaveLength(0);
  });
});

describe("live WhatsApp [FL-103]", () => {
  it("[FL-103] resolves a live sender only through LIVEPHONE#, into the live world", async () => {
    const rig = await liveRig();
    const summary = await processWhatsAppEvent(liveEvent(text("hola")), rig.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "INTAKE", worldId: "demo", mode: "live", customerId: "cus-0004" });
    expect(rig.recorded.intake[0]).toMatchObject({ origin: "LIVE", eventAtReal: "2026-10-07T13:15:00.000Z" });
    const [message] = await rig.mc.connector.conversations.listMessages("demo", "cus-0004");
    expect(message).toMatchObject({ simulated: false, providerMessageId: "wamid.LIVE.0001" });
    const unknown = await liveRig({ livePhone: false });
    expect((await processWhatsAppEvent(liveEvent(text("hola")), unknown.deps)).records[0]?.messages[0]?.outcome).toBe("NO_LIVE_WORLD");
    expect(unknown.recorded.intake).toHaveLength(0);
  });

  it("[FL-103] downloads a live image by prefix and hands it to the intake with its real key", async () => {
    const rig = await liveRig();
    eum.on(GetWhatsAppMessageMediaCommand).callsFake(async (input: GetWhatsAppMessageMediaCommandInput) => {
      rig.bucket.put(`${input.destinationS3File?.key ?? ""}${input.mediaId ?? ""}`, 300_000, "image/jpeg");
      return {};
    });
    const entry = fixture("entry-image.json", { FROM: WA_ID, WAMID: "wamid.LIVE.IMG", MEDIA_ID: "1555666777888999", TEXT: "el comprobante" });
    const summary = await processWhatsAppEvent(liveEvent(entry), rig.deps);
    expect(summary.records[0]?.messages[0]?.outcome).toBe("INTAKE");
    expect(rig.recorded.intake[0]?.media).toEqual({ accepted: true, announceKey: "wa/demo/wamid.LIVE.IMG/", s3Key: "wa/demo/wamid.LIVE.IMG/1555666777888999", source: "WHATSAPP", contentType: "image/jpeg" });
    expect(rig.recorded.intake[0]?.text.text).toBe("el comprobante");
  });

  it("[FL-103] reads a template quick reply, a reply button and a list row by their nonces only", async () => {
    const rig = await liveRig();
    const [question = "", talk = "", loan = ""] = await issueNonces(rig.mc.connector, {
      worldId: "demo",
      customerId: "cus-0004",
      phoneHash: rig.phoneHash,
      messageId: "msg-out-9",
      buttons: [{ action: "HAVE_A_QUESTION", complaintId: "cmp-0004" }, { action: "TALK_TO_HUMAN" }, { action: "CHOOSE_LOAN", loanId: "L-0002" }],
      now: TEST_NOW,
    });
    const tap = (file: string, nonce: string, title: string, wamid: string) => liveEvent(fixture(file, { FROM: WA_ID, WAMID: wamid, NONCE: nonce, TITLE: title, CONTEXT: "wamid.OUT.9" }));
    await processWhatsAppEvent(tap("entry-template-reply.json", question, "Tengo una duda", "wamid.LIVE.T1"), rig.deps);
    await processWhatsAppEvent(tap("entry-button-reply.json", talk, "Hablar con alguien", "wamid.LIVE.T2"), rig.deps);
    await processWhatsAppEvent(tap("entry-list-reply.json", loan, "Préstamo express 0002", "wamid.LIVE.T3"), rig.deps);
    expect(rig.recorded.intake.map((message) => message.button)).toEqual([
      { action: "HAVE_A_QUESTION", complaintId: "cmp-0004" },
      { action: "CHOOSE_LOAN", loanId: "L-0002" },
    ]);
    expect(rig.recorded.effects.map((effect) => effect.kind)).toEqual(["HANDOFF"]);
  });

  it("[FL-103] applies the statuses of a live entry to our messages", async () => {
    const rig = await liveRig();
    await rig.mc.connector.conversations.putMessage({ worldId: "demo", customerId: "cus-0004", messageId: "msg-out-1", direction: "OUT", channel: "WHATSAPP", body: "x", status: "SENT", simulated: false, providerMessageId: "wamid.OUT.sent", atSim: SIM_NOW });
    const entry = fixture("entry-statuses.json", { SENT_ID: "wamid.OUT.sent", MARKETING_ID: "wamid.OUT.none", FAILED_ID: "wamid.OUT.none2", FROM: WA_ID });
    const summary = await processWhatsAppEvent(liveEvent(entry), rig.deps);
    expect(summary.records[0]?.statuses.filter((status) => status.outcome === "APPLIED")).toHaveLength(2);
    expect((await rig.mc.connector.conversations.findMessage("demo", "cus-0004", "msg-out-1"))?.status).toBe("READ");
  });

  it("[FL-104] refuses a record without a valid SNS signature, and a live record into a simulated world", async () => {
    const rig = await liveRig();
    const forged = { Records: [liveRecord(eumMessage(text("aprobá mi reintegro")), { signature: "AAAA" })] };
    expect((await processWhatsAppEvent(forged, rig.deps)).records[0]).toMatchObject({ accepted: false, origin: "LIVE", reason: "SIGNATURE_INVALID" });
    expect(rig.lines.some((line) => line.includes("WhatsAppEnvelopeRejected"))).toBe(true);
    const simulatedDemo = await liveRig({ demoMode: "simulated" });
    const summary = await processWhatsAppEvent(liveEvent(text("hola")), simulatedDemo.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "REJECTED", reason: "LIVE_IN_SIMULATED_WORLD" });
    expect((await simulatedDemo.mc.connector.audit.listByAction("demo", "INBOUND_REJECTED")).map((entry) => entry.outcome)).toEqual(["LIVE_IN_SIMULATED_WORLD"]);
    expect(rig.recorded.intake).toHaveLength(0);
  });

  it("[FL-104] refuses a simulated envelope into the live world while the guest simulator keeps working", async () => {
    const rig = await liveRig();
    const into = await processWhatsAppEvent(simEvent("demo", { type: "text", text: "hola" }), rig.deps);
    expect(into.records[0]?.messages[0]).toMatchObject({ outcome: "REJECTED", reason: "SIM_IN_LIVE_WORLD" });
    expect((await rig.mc.connector.audit.listByAction("demo", "INBOUND_REJECTED")).map((entry) => entry.outcome)).toEqual(["SIM_IN_LIVE_WORLD"]);
    const phoneHash = await testPhoneHash();
    const guest = inboundRig({ customers: { [`g07#${phoneHash}`]: "cus-0008" }, liveWorlds: ["demo"] });
    await seedWorld(guest.mc, "demo", { mode: "live" });
    await seedWorld(guest.mc, "g07");
    expect((await processWhatsAppEvent(simEvent("g07", { type: "text", text: "hola" }), guest.deps)).records[0]?.messages[0]?.outcome).toBe("INTAKE");
  });

  it("[FL-099] audits a QA-signed envelope aimed at a guest world in that world, and lets nothing in", async () => {
    const rig = await simulatedRig();
    const forged = simEvent("g07", { type: "text", text: "hola" });
    const record = forged.Records[0];
    if (record === undefined) throw new Error("no record");
    const qaKid = { ...record.Sns.MessageAttributes, "reclamo-sim-kid": { Type: "String", Value: "qa" } };
    const summary = await processWhatsAppEvent({ Records: [{ ...record, Sns: { ...record.Sns, MessageAttributes: qaKid } }] }, rig.deps);
    expect(summary.records[0]).toMatchObject({ accepted: false, origin: "SIMULATED", reason: "SIM_SIGNATURE_INVALID" });
    expect((await rig.mc.connector.audit.listByAction("g07", "INBOUND_REJECTED")).map((entry) => entry.outcome)).toEqual(["SIM_SIGNATURE_INVALID"]);
    expect(rig.recorded.intake).toHaveLength(0);
  });

  it("refuses an event that is not an SNS event at all", async () => {
    const rig = await simulatedRig();
    expect(await processWhatsAppEvent({ hello: "world" }, rig.deps)).toEqual({ records: [{ accepted: false, reason: "INVALID_EVENT", messages: [], statuses: [] }] });
  });
});
