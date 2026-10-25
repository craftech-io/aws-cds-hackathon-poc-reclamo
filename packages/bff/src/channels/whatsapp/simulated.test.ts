import { describe, expect, it } from "vitest";
import { SIM_NOW, TEST_NOW, message as messageRow, testConnector } from "../../connector/testing";
import { fixedClock } from "../../lib/clock";
import { createLogger } from "../../lib/log";
import { applyStatuses } from "./events";
import { parseEnvelope } from "./payloads";
import { SIM_MEDIA_ID, buildSimulatedEvent, newSimMediaId, qaSimulatedWamid, signSimulated, simKeyAllows, verifySimulatedRecord } from "./sim-envelope";
import { simulatedWhatsAppTransport } from "./simulated-transport";
import { TEST_SIM_KEYS, onlyRecord } from "./testing";

const log = createLogger({ sink: () => undefined });
const input = (worldId: string, kid: "console" | "qa" = "console", at: Date = TEST_NOW) => ({
  kid,
  worldId,
  from: "+5491100001007",
  wamid: "wamid.SIM.01K6ZT00000000000000000002",
  content: { type: "text" as const, text: "pagué y no se refleja" },
  at,
});

describe("simulated envelope [FL-101]", () => {
  it("[FL-101] builds the same SNS shape as a live event, signed for its world", () => {
    const record = onlyRecord(buildSimulatedEvent(TEST_SIM_KEYS.console, input("g07")));
    expect(record.EventSource).toBe("reclamo:sim");
    const parsed = parseEnvelope(record.Sns.Message);
    expect(parsed.changes[0]?.metadata.phone_number_id).toBe("simulated");
    expect(parsed.changes[0]?.messages[0]).toMatchObject({ from: "5491100001007", id: "wamid.SIM.01K6ZT00000000000000000002", type: "text", text: { body: "pagué y no se refleja" } });
    expect(verifySimulatedRecord(record, TEST_SIM_KEYS, TEST_NOW)).toEqual({ ok: true, kid: "console", worldId: "g07" });
  });

  it("[FL-099] refuses the QA key in a guest world or in demo, even with a valid signature", () => {
    for (const worldId of ["g07", "gtest", "gprobe", "gs-abcdefghij", "demo"]) {
      expect(simKeyAllows("qa", worldId), worldId).toBe(false);
      expect(() => buildSimulatedEvent(TEST_SIM_KEYS.qa, input(worldId, "qa"))).toThrow(RangeError);
    }
    // A forged envelope: QA key, guest world, signature computed correctly with the QA key.
    const forged = onlyRecord(buildSimulatedEvent(TEST_SIM_KEYS.qa, input("qa-run1-sc22a", "qa")));
    const attributes = { ...forged.Sns.MessageAttributes, "reclamo-sim-world": { Type: "String", Value: "g07" } };
    const resigned = onlyRecord(buildSimulatedEvent(TEST_SIM_KEYS.qa, input("qa-run1-sc22a", "qa")));
    expect(verifySimulatedRecord({ ...forged, Sns: { ...forged.Sns, MessageAttributes: attributes } }, TEST_SIM_KEYS, TEST_NOW)).toMatchObject({ ok: false, reason: "SIM_SIGNATURE_INVALID" });
    expect(verifySimulatedRecord(resigned, TEST_SIM_KEYS, TEST_NOW)).toMatchObject({ ok: true, kid: "qa" });
  });

  it("[FL-099] refuses a valid QA signature over a guest world with SIM_KEY_WORLD_MISMATCH", () => {
    const record = onlyRecord(buildSimulatedEvent(TEST_SIM_KEYS.qa, input("qa-run1-sc22a", "qa")));
    const ts = TEST_NOW.toISOString();
    const signature = signSimulated(TEST_SIM_KEYS.qa, "qa", "g07", ts, record.Sns.Message);
    const attributes = { ...record.Sns.MessageAttributes, "reclamo-sim-world": { Type: "String", Value: "g07" }, "reclamo-sim-signature": { Type: "String", Value: signature } };
    expect(verifySimulatedRecord({ ...record, Sns: { ...record.Sns, MessageAttributes: attributes } }, TEST_SIM_KEYS, TEST_NOW)).toEqual({ ok: false, reason: "SIM_KEY_WORLD_MISMATCH", worldId: "g07" });
  });

  it("[FL-099] lets each key write only to its class of worlds", () => {
    expect(["demo", "g07", "gtest", "gprobe", "gs-abcdefghij", "qa-run1-sc01"].every((worldId) => simKeyAllows("console", worldId))).toBe(true);
    expect(["qamin", "sim-batch1"].some((worldId) => simKeyAllows("console", worldId))).toBe(false);
    expect(["qa-run1-sc01", "qamin", "sim-batch1"].every((worldId) => simKeyAllows("qa", worldId))).toBe(true);
  });

  it("[FL-101] refuses an envelope older than five real minutes, a wrong key and an unknown kid", () => {
    const old = onlyRecord(buildSimulatedEvent(TEST_SIM_KEYS.console, input("g07", "console", new Date(TEST_NOW.getTime() - 6 * 60_000))));
    expect(verifySimulatedRecord(old, TEST_SIM_KEYS, TEST_NOW)).toMatchObject({ ok: false, reason: "SIM_EXPIRED" });
    const other = onlyRecord(buildSimulatedEvent("another-key-that-is-not-linked-here-000", input("g07")));
    expect(verifySimulatedRecord(other, TEST_SIM_KEYS, TEST_NOW)).toMatchObject({ ok: false, reason: "SIM_SIGNATURE_INVALID" });
    expect(verifySimulatedRecord(onlyRecord(buildSimulatedEvent(TEST_SIM_KEYS.console, input("g07"))), { qa: TEST_SIM_KEYS.qa }, TEST_NOW)).toMatchObject({ ok: false, reason: "SIM_KEY_UNKNOWN" });
    const unsigned = onlyRecord(buildSimulatedEvent(TEST_SIM_KEYS.console, input("g07")));
    expect(verifySimulatedRecord({ ...unsigned, Sns: { ...unsigned.Sns, MessageAttributes: {} } }, TEST_SIM_KEYS, TEST_NOW)).toMatchObject({ ok: false, reason: "SIM_MALFORMED" });
  });

  it("[FL-101] carries a simulated image as SIM<32 hex>, alphanumeric like a Meta media id", () => {
    const id = newSimMediaId();
    expect(id).toMatch(SIM_MEDIA_ID);
    const record = onlyRecord(buildSimulatedEvent(TEST_SIM_KEYS.console, { ...input("g07"), content: { type: "image", simMediaId: id, mimeType: "image/png" } }));
    expect(parseEnvelope(record.Sns.Message).changes[0]?.messages[0]?.image).toMatchObject({ id, mime_type: "image/png" });
    expect(() => buildSimulatedEvent(TEST_SIM_KEYS.console, { ...input("g07"), content: { type: "image", simMediaId: "sim-media:up/x.png", mimeType: "image/png" } })).toThrow(RangeError);
    expect(qaSimulatedWamid("run1/sc03/step2")).toMatch(/^wamid\.SIM\.[0-9a-f]{64}$/);
  });
});

describe("SimulatedWhatsAppTransport [FL-101]", () => {
  const setup = (templateStatus: string | undefined) => {
    const mc = testConnector();
    const transport = simulatedWhatsAppTransport({
      data: mc.connector,
      recipients: { whatsAppNumber: async (_worldId, customerId) => (customerId === "cus-0007" ? "+5491100001007" : undefined) },
      templates: { status: async () => templateStatus },
      realClock: fixedClock(TEST_NOW),
      log,
      newWamid: () => "wamid.SIM.OUT0001",
    });
    return { mc, transport };
  };
  const record = { worldId: "g07", customerId: "cus-0007", messageId: "msg-out-1" };

  it("[FL-101] validates the Meta JSON, keeps it and records sent and delivered one second apart", async () => {
    const { mc, transport } = setup("LOCAL_ONLY");
    const sent = await transport.send({ record, outbound: { kind: "text", body: "Recibimos tu mensaje." } });
    expect(sent).toMatchObject({ providerMessageId: "wamid.SIM.OUT0001", simulated: true, status: "DELIVERED", payload: { to: "5491100001007", type: "text" } });
    const events = await mc.connector.conversations.listEvents("g07", "cus-0007");
    expect(events.map((event) => [event.type, event.atReal])).toEqual([
      ["SENT", "2026-10-07T13:10:00.000Z"],
      ["DELIVERED", "2026-10-07T13:10:01.000Z"],
    ]);
    expect(events[0]?.detail?.payload).toEqual(sent.payload);
  });

  it("[FL-101] renders a template that only exists locally, and refuses one that is not in Reference", async () => {
    const template = { kind: "template" as const, name: "reclamo_derivado" as const, values: ["R-2026-000123", "jueves 22/10"], nonces: [] };
    expect((await setup("LOCAL_ONLY").transport.send({ record, outbound: template })).payload.type).toBe("template");
    await expect(setup(undefined).transport.send({ record, outbound: template })).rejects.toThrow(/not in Reference/);
    await expect(setup("LOCAL_ONLY").transport.send({ record: { ...record, customerId: "cus-9999" }, outbound: { kind: "text", body: "x" } })).rejects.toThrow(/no WhatsApp number/);
  });

  it("[FL-101] marks the thread read, and a status from another world touches nothing [FL-099]", async () => {
    const { mc, transport } = setup("LOCAL_ONLY");
    const row = messageRow("g07", { customerId: "cus-0007", messageId: "msg-out-1", direction: "OUT", channel: "WHATSAPP", status: "DELIVERED", simulated: true, providerMessageId: "wamid.SIM.OUT0001", atSim: SIM_NOW });
    await mc.connector.conversations.putMessage(row);
    const foreign = await applyStatuses([{ id: "wamid.SIM.OUT0001", status: "read", timestamp: "1791378960", recipient_id: "5491100001007" }], { data: mc.connector, log }, { simulated: true, worldId: "g08" });
    expect(foreign).toEqual([{ outcome: "FOREIGN_WORLD" }]);
    expect(await transport.markRead("g07", "cus-0007")).toBe(1);
    expect((await mc.connector.conversations.findMessage("g07", "cus-0007", "msg-out-1"))?.status).toBe("READ");
  });
});
