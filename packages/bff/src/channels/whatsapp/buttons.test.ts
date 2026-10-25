import { describe, expect, it } from "vitest";
import { BUTTON_TITLES } from "../../copy";
import type { Nonce } from "../../domain/runtime-claims";
import { TEST_NOW } from "../../connector/testing";
import { commandOf } from "./buttons";
import { processWhatsAppEvent } from "./inbound";
import { issueNonces } from "./nonces";
import { inboundRig, seedWorld, simEvent, testPhoneHash } from "./testing";

const nonce = (action: Nonce["action"], refs: Partial<Nonce> = {}): Nonce => ({ worldId: "demo", nonce: "01K6ZT0000NONCE0000000009", action, phoneHash: "e".repeat(64), customerId: "cus-0001", createdAtReal: TEST_NOW.toISOString(), ...refs });

describe("what a button does [FL-060]", () => {
  it("[FL-060] 'talk to a person' is a handoff decided by code, with the complaint when the button had one", () => {
    expect(commandOf(nonce("TALK_TO_HUMAN", { complaintId: "cmp-0001" }))).toEqual({ kind: "HANDOFF", reason: "CUSTOMER_ASKED", complaintId: "cmp-0001" });
    expect(commandOf(nonce("TALK_TO_HUMAN"))).toEqual({ kind: "HANDOFF", reason: "CUSTOMER_ASKED" });
  });

  it("opt-out and the email consent are decided by code; the rest reach the turn with their meaning", () => {
    expect(commandOf(nonce("OPT_OUT"))).toEqual({ kind: "OPT_OUT", via: "BUTTON" });
    expect(commandOf(nonce("DECLINE_EMAIL", { complaintId: "cmp-0001" }))).toEqual({ kind: "EMAIL_CONSENT", accepted: false, complaintId: "cmp-0001" });
    expect(commandOf(nonce("CHOOSE_LOAN", { loanId: "L-0002" }))).toEqual({ kind: "TURN", action: "CHOOSE_LOAN", loanId: "L-0002" });
    expect(commandOf(nonce("SEE_DETAIL", { complaintId: "cmp-0001" }))).toEqual({ kind: "TURN", action: "SEE_DETAIL", complaintId: "cmp-0001" });
  });

  it("[FL-060] a tap on 'Hablar con alguien' hands off without a turn, from the simulator as from the live channel", async () => {
    const phoneHash = await testPhoneHash();
    const rig = inboundRig({ customers: { [`demo#${phoneHash}`]: "cus-0001" } });
    await seedWorld(rig.mc, "demo");
    const [talk = ""] = await issueNonces(rig.mc.connector, { worldId: "demo", customerId: "cus-0001", phoneHash, messageId: "msg-out-1", buttons: [{ action: "TALK_TO_HUMAN", complaintId: "cmp-0001" }], now: TEST_NOW });
    const title = BUTTON_TITLES.TALK_TO_HUMAN.INTERACTIVE ?? "";
    const summary = await processWhatsAppEvent(simEvent("demo", { type: "button_reply", nonce: talk, title }), rig.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "HANDOFF", customerId: "cus-0001" });
    expect(rig.recorded.effects).toEqual([{ kind: "HANDOFF", input: expect.objectContaining({ reason: "CUSTOMER_ASKED", complaintId: "cmp-0001", customerId: "cus-0001" }) }]);
    expect(rig.recorded.intake).toHaveLength(0);
    // The same tap again (a new message) hands off again: the button is not one-shot.
    await processWhatsAppEvent(simEvent("demo", { type: "button_reply", nonce: talk, title }, "wamid.SIM.01K6ZT0000000000000000000B"), rig.deps);
    expect(rig.recorded.effects).toHaveLength(2);
  });

  it("[FL-060] a tap whose nonce does not resolve is audited and read as free text by the intake", async () => {
    const phoneHash = await testPhoneHash();
    const rig = inboundRig({ customers: { [`demo#${phoneHash}`]: "cus-0001" } });
    await seedWorld(rig.mc, "demo");
    await processWhatsAppEvent(simEvent("demo", { type: "template_reply", nonce: "01K6ZT0000NONCE00000000ZZ", title: "Hablar con una persona" }), rig.deps);
    expect(rig.recorded.effects).toHaveLength(0);
    expect(rig.recorded.intake[0]).toMatchObject({ refusedButton: true, text: { text: "Hablar con una persona" } });
    const denied = await rig.mc.connector.audit.listByAction("demo", "DENY");
    expect(denied.map((entry) => entry.outcome)).toEqual(["NONCE_UNKNOWN"]);
  });
});
