// Conversations, messages and emails over the memory connector: control changes only from the
// control the caller saw, the disclosure once per session epoch, sent contacts counted per customer,
// provider ids resolved to the message or email they belong to.
import { describe, expect, it } from "vitest";
import { SIM_NOW, conversation, email, message, testConnector } from "../testing";

async function withConversation() {
  const setup = testConnector();
  await setup.connector.conversations.create(conversation("demo"));
  return setup;
}

describe("conversation", () => {
  it("takes over and hands back only from the control the caller saw", async () => {
    const { connector } = await withConversation();
    const take = { worldId: "demo", customerId: "cus-0001", version: 1, from: "AGENT" as const, to: "OPERATOR" as const, by: "OPERATOR:stf-lucia" as const, atSim: SIM_NOW, staffId: "stf-lucia" };
    await connector.write(connector.conversations.setControlOp(take));
    await expect(connector.write(connector.conversations.setControlOp({ ...take, version: 2 }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.conversations.getMeta("demo", "cus-0001")).toMatchObject({ control: "OPERATOR", controlledBy: "stf-lucia", version: 2 });
    await connector.write(connector.conversations.setControlOp({ ...take, version: 2, from: "OPERATOR", to: "AGENT" }));
    const meta = await connector.conversations.getMeta("demo", "cus-0001", { consistent: true });
    expect(meta?.controlledBy).toBeUndefined();
    expect(meta?.controlHistory.map((entry) => entry.to)).toEqual(["OPERATOR", "AGENT"]);
  });

  it("marks the automation disclosure once per session epoch", async () => {
    const { connector } = await withConversation();
    await connector.write(connector.conversations.markDisclosedOp("demo", "cus-0001", 1));
    await expect(connector.write(connector.conversations.markDisclosedOp("demo", "cus-0001", 1))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.write(connector.conversations.markDisclosedOp("demo", "cus-0001", 2));
    expect((await connector.conversations.getMeta("demo", "cus-0001"))?.disclosedEpochs).toEqual([1, 2]);
  });

  it("updates identification and open complaints on the version read", async () => {
    const { connector } = await withConversation();
    const after = await connector.conversations.updateMeta("demo", "cus-0001", 1, { identifiedUntilReal: "2026-10-07T13:40:00Z", openComplaintIds: ["cmp-0001"] });
    expect(after).toMatchObject({ identifiedUntilReal: "2026-10-07T13:40:00Z", openComplaintIds: ["cmp-0001"], version: 2 });
    await expect(connector.conversations.updateMeta("demo", "cus-0001", 1, { sessionEpoch: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("messages", () => {
  it("keeps the thread in simulated time order and finds a message by id", async () => {
    const { connector } = await withConversation();
    await connector.conversations.putMessage(message("demo", { messageId: "msg-2", atSim: "2026-10-07T10:12:00-03:00" }));
    await connector.conversations.putMessage(message("demo"));
    await expect(connector.conversations.putMessage(message("demo"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await connector.conversations.listMessages("demo", "cus-0001")).map((row) => row.messageId)).toEqual(["msg-0001", "msg-2"]);
    expect((await connector.conversations.listMessages("demo", "cus-0001", { descending: true, limit: 1 })).map((row) => row.messageId)).toEqual(["msg-2"]);
    expect(await connector.conversations.findMessage("demo", "cus-0001", "msg-2")).toMatchObject({ atSim: "2026-10-07T10:12:00-03:00" });
    expect(await connector.conversations.findMessage("demo", "cus-0001", "msg-9")).toBeUndefined();
  });

  it("keeps the disclosure flag through a status update that does not name it", async () => {
    const { connector } = await withConversation();
    await connector.conversations.putMessage(message("demo", { messageId: "msg-flag", direction: "OUT", kind: "COMPLAINT_ACK", sender: "SYSTEM", status: "PENDING", body: "Hola", flags: { disclosure: true } }));
    const ref = { worldId: "demo", customerId: "cus-0001", atSim: SIM_NOW, messageId: "msg-flag" };
    expect(await connector.conversations.updateMessage(ref, { status: "DELIVERED" })).toMatchObject({ status: "DELIVERED", flags: { disclosure: true } });
  });

  it("counts what was sent to a customer, messages and emails, since an instant", async () => {
    const { connector } = await withConversation();
    const outbound = message("demo", { messageId: "msg-out", direction: "OUT", kind: "REPLY", sender: "AGENT", status: "PENDING", body: "Hola" });
    await connector.conversations.putMessage(outbound);
    expect((await connector.conversations.listSentSince("demo", "cus-0001", "2026-10-07T00:00:00-03:00")).messages).toEqual([]);
    const ref = { worldId: "demo", customerId: "cus-0001", atSim: SIM_NOW, messageId: "msg-out" };
    const sent = await connector.conversations.updateMessage(ref, { status: "SENT", providerMessageId: "wamid.SIM.1", sentAtSim: SIM_NOW }, 1);
    expect(sent).toMatchObject({ status: "SENT", version: 2 });
    await expect(connector.conversations.updateMessage(ref, { status: "READ" }, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.emails.put(email("demo"));
    const since = await connector.conversations.listSentSince("demo", "cus-0001", "2026-10-07T00:00:00-03:00");
    expect(since.messages.map((row) => row.messageId)).toEqual(["msg-out"]);
    expect(since.emails.map((row) => row.mailId)).toEqual(["mail-0001"]);
    expect((await connector.conversations.listSentSince("demo", "cus-0001", "2026-10-08T00:00:00-03:00")).messages).toEqual([]);
  });

  it("resolves a provider id to its message or email", async () => {
    const { connector } = await withConversation();
    await connector.conversations.putMessage(message("demo", { providerMessageId: "wamid.SIM.abc" }));
    await connector.emails.put(email("demo"));
    const ref = { worldId: "demo", customerId: "cus-0001", sentAtSim: SIM_NOW, mailId: "mail-0001" };
    await connector.write(connector.emails.setProviderMessageIdOp(ref, "0100-ses-id"));
    await expect(connector.write(connector.emails.setProviderMessageIdOp(ref, "0100-other"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.conversations.findByProviderMessageId("wamid.SIM.abc")).toMatchObject({ kind: "MESSAGE", message: { messageId: "msg-0001" } });
    expect(await connector.conversations.findByProviderMessageId("0100-ses-id")).toMatchObject({ kind: "EMAIL", email: { mailId: "mail-0001" } });
    expect(await connector.conversations.findByProviderMessageId("0100-unknown")).toBeUndefined();
  });

  it("stores provider events and turn notes in the conversation", async () => {
    const { connector } = await withConversation();
    await connector.write(connector.conversations.putEventOp({ worldId: "demo", customerId: "cus-0001", eventId: "evt-1", providerMessageId: "wamid.SIM.1", type: "delivered", atReal: "2026-10-07T13:11:00Z" }));
    await connector.write(connector.conversations.putTurnNoteOp({ worldId: "demo", customerId: "cus-0001", turnId: "turn-1", atSim: SIM_NOW, text: "Resumen", refs: ["msg-0001"] }));
    expect((await connector.conversations.listEvents("demo", "cus-0001")).map((row) => row.type)).toEqual(["delivered"]);
    expect((await connector.conversations.listTurnNotes("demo", "cus-0001")).map((row) => row.turnId)).toEqual(["turn-1"]);
  });
});

describe("emails", () => {
  it("records SES events with the delivery proof and lists the world's emails newest first", async () => {
    const { connector } = await withConversation();
    await connector.emails.put(email("demo"));
    await connector.emails.put(email("demo", { mailId: "mail-2", sentAtSim: "2026-10-07T11:00:00-03:00" }));
    const ref = { worldId: "demo", customerId: "cus-0001", sentAtSim: SIM_NOW, mailId: "mail-0001" };
    await connector.write(connector.emails.recordEventOp(ref, { type: "DELIVERY", atReal: "2026-10-07T13:12:00Z" }, "DELIVERED"));
    await expect(connector.write(connector.emails.recordEventOp({ ...ref, mailId: "mail-9" }, { type: "BOUNCE", atReal: "2026-10-07T13:12:00Z" }, "BOUNCED"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.emails.get(ref)).toMatchObject({ deliveryProof: "DELIVERED", events: [{ type: "DELIVERY" }] });
    expect((await connector.emails.find("demo", "cus-0001", "mail-2"))?.sentAtSim).toBe("2026-10-07T11:00:00-03:00");
    expect((await connector.emails.listWorld("demo")).emails.map((row) => row.mailId)).toEqual(["mail-2", "mail-0001"]);
  });
});
