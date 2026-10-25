import { describe, expect, it } from "vitest";
import { SIM_NOW, message as messageRow, testConnector } from "../../connector/testing";
import { createLogger } from "../../lib/log";
import { applyStatuses, nextStatus, statusEventId } from "./events";
import { parseEnvelope } from "./payloads";
import { eumMessage, fixture } from "./testing";

const statusesOf = () => {
  const entry = fixture("entry-statuses.json", { SENT_ID: "wamid.OUT.sent", MARKETING_ID: "wamid.OUT.marketing", FAILED_ID: "wamid.OUT.failed", FROM: "5491100009001" });
  return parseEnvelope(eumMessage(entry)).changes.flatMap((change) => change.statuses);
};

async function setup() {
  const mc = testConnector();
  const lines: string[] = [];
  const log = createLogger({ sink: (line) => lines.push(line) });
  const out = (messageId: string, providerMessageId: string, extra: Record<string, unknown> = {}) =>
    mc.connector.conversations.putMessage(messageRow("demo", { customerId: "cus-0004", messageId, direction: "OUT", channel: "WHATSAPP", status: "SENT", simulated: false, providerMessageId, atSim: SIM_NOW, ...extra }));
  await out("msg-1", "wamid.OUT.sent", { templateName: "reclamo_novedad" });
  await out("msg-2", "wamid.OUT.marketing", { templateName: "reclamo_resuelto" });
  await out("msg-3", "wamid.OUT.failed");
  const scope = { simulated: false as const, isLiveWorld: async (worldId: string) => worldId === "demo" };
  return { mc, lines, log, scope };
}

describe("delivery statuses [FL-103]", () => {
  it("[FL-103] parses the real shape, drops states it does not know and keeps pricing and errors", () => {
    const statuses = statusesOf();
    expect(statuses.map((status) => `${status.id}:${status.status}`)).toEqual(["wamid.OUT.sent:sent", "wamid.OUT.sent:delivered", "wamid.OUT.sent:read", "wamid.OUT.marketing:delivered", "wamid.OUT.failed:failed"]);
    expect(statuses[0]?.pricing?.category).toBe("utility");
    expect(statuses[4]?.errors?.[0]?.code).toBe(131047);
  });

  it("[FL-103] moves each message forward, records one event per status and never twice", async () => {
    const { mc, log, scope } = await setup();
    const outcomes = await applyStatuses(statusesOf(), { data: mc.connector, log }, scope);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["UNCHANGED", "APPLIED", "APPLIED", "APPLIED", "APPLIED"]);
    const read = await mc.connector.conversations.findMessage("demo", "cus-0004", "msg-1");
    expect(read?.status).toBe("READ");
    expect((await mc.connector.conversations.findMessage("demo", "cus-0004", "msg-3"))?.status).toBe("FAILED");
    const again = await applyStatuses(statusesOf(), { data: mc.connector, log }, scope);
    expect(again.every((outcome) => outcome.outcome === "DUPLICATE")).toBe(true);
    const events = await mc.connector.conversations.listEvents("demo", "cus-0004");
    expect(events).toHaveLength(5);
    expect(events.find((event) => event.eventId === statusEventId({ id: "wamid.OUT.failed", status: "failed" }))?.detail).toMatchObject({ errorCode: 131047, errorTitle: "Re-engagement message" });
  });

  it("[FL-103] raises the alarm metric for a template billed outside utility and for a failed send, without the recipient", async () => {
    const { mc, lines, log, scope } = await setup();
    await applyStatuses(statusesOf(), { data: mc.connector, log }, scope);
    const alarms = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.metric !== undefined);
    expect(alarms.map((line) => line.metric)).toEqual(["WhatsAppPricingCategory", "WhatsAppSendFailed"]);
    expect(alarms[0]).toMatchObject({ category: "marketing", template: "reclamo_resuelto" });
    expect(lines.join("\n")).not.toContain("5491100009001");
  });

  it("[FL-099] a live status never touches a message of a world that is not live, nor an unknown one", async () => {
    const { mc, log } = await setup();
    const notLive = { simulated: false as const, isLiveWorld: async () => false };
    expect(await applyStatuses(statusesOf().slice(0, 1), { data: mc.connector, log }, notLive)).toEqual([{ outcome: "FOREIGN_WORLD" }]);
    const unknown = { ...statusesOf()[0]!, id: "wamid.OUT.nobody" };
    expect(await applyStatuses([unknown], { data: mc.connector, log }, notLive)).toEqual([{ outcome: "UNKNOWN_MESSAGE" }]);
  });

  it("never takes a message back: a late delivered after read changes nothing", () => {
    expect(nextStatus("READ", "delivered")).toBeUndefined();
    expect(nextStatus("READ", "failed")).toBeUndefined();
    expect(nextStatus("SENT", "read")).toBe("READ");
    expect(nextStatus("DELIVERED", "failed")).toBe("FAILED");
  });
});
