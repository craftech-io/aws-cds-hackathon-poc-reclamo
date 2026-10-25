// The automation disclosure (FL-001): the first outbound WhatsApp of each conversation and of each
// session epoch starts with the fixed line, whoever sends it; no later outbound of the epoch repeats
// it; two senders racing put it on one message only. It never depends on the model.
import { describe, expect, it } from "vitest";
import { AUTOMATED_DISCLOSURE } from "../../copy";
import { createOutboundGate } from "../gate";
import { OPERATOR, VALERIA, call, customerWrote, gateRig, request, seedComplaint } from "../testing";
import { DISCLOSURE_PREFIX, disclosureOps, needsDisclosure, withDisclosure, withoutDisclosure } from "./disclosure";

const WROTE = "2026-10-07T10:05:00-03:00";

async function outbound(rig: Awaited<ReturnType<typeof gateRig>>) {
  return (await rig.kit.connector.conversations.listMessages(rig.worldId, VALERIA)).filter((message) => message.direction === "OUT");
}

describe("automation disclosure: the line [FL-001]", () => {
  it("is needed with no conversation yet and for an epoch whose first outbound did not carry it [FL-001]", () => {
    expect(needsDisclosure(undefined)).toBe(true);
    expect(needsDisclosure({ sessionEpoch: 1, disclosedEpochs: [] })).toBe(true);
    expect(needsDisclosure({ sessionEpoch: 2, disclosedEpochs: [1] })).toBe(true);
    expect(needsDisclosure({ sessionEpoch: 2, disclosedEpochs: [1, 2] })).toBe(false);
  });

  it("is the fixed line of copy/ before the body, and the stored body gives back what the sender wrote [FL-001]", () => {
    expect(DISCLOSURE_PREFIX).toBe(`${AUTOMATED_DISCLOSURE}\n\n`);
    const body = withDisclosure("¿En qué te ayudo?");
    expect(withoutDisclosure({ body, flags: { disclosure: true } })).toBe("¿En qué te ayudo?");
    expect(withoutDisclosure({ body, flags: {} })).toBe(body);
  });

  it("marks the epoch only when there is a conversation", () => {
    const rigless = { conversations: { markDisclosedOp: (worldId: string, customerId: string, epoch: number) => ({ kind: "update", worldId, customerId, epoch }) } } as never;
    expect(disclosureOps(rigless, undefined)).toEqual([]);
    expect(disclosureOps(rigless, { worldId: "demo", customerId: VALERIA, sessionEpoch: 3 })).toHaveLength(1);
  });
});

describe("automation disclosure through the gate [FL-001]", () => {
  it("the first outbound of the conversation carries the line and the button; the next one of the epoch does not [FL-001]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE, { disclosedEpochs: [] });
    const first = await rig.gate(request("COMPLAINT_ACK", { text: "Registramos tu reclamo." }), call(rig));
    const second = await rig.gate(request("COMPLAINT_ACK", { text: "Te escribimos por la novedad." }), call(rig));
    expect(first.ok && second.ok).toBe(true);
    const [one, two] = await outbound(rig);
    expect(one?.flags.disclosure).toBe(true);
    expect(one?.body.startsWith(DISCLOSURE_PREFIX)).toBe(true);
    expect(JSON.stringify(one?.interactive)).toContain("TALK_TO_HUMAN");
    expect(two?.flags.disclosure).toBeUndefined();
    expect(two?.body).toBe("Te escribimos por la novedad.");
    expect((await rig.kit.connector.conversations.getMeta(rig.worldId, VALERIA))?.disclosedEpochs).toEqual([1]);
    expect(rig.whatsappSent[0]?.outbound).toMatchObject({ kind: "buttons", body: `${DISCLOSURE_PREFIX}Registramos tu reclamo.` });
  });

  it("carries the line again in a new session epoch [FL-001]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE, { sessionEpoch: 2, disclosedEpochs: [1] });
    await rig.gate(request("COMPLAINT_ACK", { text: "Hola de nuevo." }), call(rig));
    const [message] = await outbound(rig);
    expect(message?.flags.disclosure).toBe(true);
    expect((await rig.kit.connector.conversations.getMeta(rig.worldId, VALERIA))?.disclosedEpochs).toEqual([1, 2]);
  });

  it("is put by the gate whoever sends: an operator's first message of the epoch carries it too [FL-001]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE, { disclosedEpochs: [], control: "OPERATOR", controlledBy: "stf-operator-01" });
    const outcome = await rig.gate(request("OPERATOR_MESSAGE", { sender: OPERATOR, text: "Hola, te escribe Laura del equipo de atención." }), call(rig, OPERATOR));
    expect(outcome.ok).toBe(true);
    const [message] = await outbound(rig);
    expect(message?.sender).toBe(OPERATOR);
    expect(message?.flags.disclosure).toBe(true);
    expect(message?.body).toBe(`${DISCLOSURE_PREFIX}Hola, te escribe Laura del equipo de atención.`);
  });

  it("never rides on a template: Meta's body cannot carry it, the next free text does", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE, { disclosedEpochs: [] });
    await seedComplaint(rig, { status: "HUMAN_REVIEW" });
    const outcome = await rig.gate(request("HANDOFF_NOTICE", { complaintId: "cmp-0001", template: { name: "reclamo_derivado", params: ["R-2026-000123", "jueves 22/10"] } }), call(rig));
    expect(outcome.ok).toBe(true);
    const [message] = await outbound(rig);
    expect(message?.flags.disclosure).toBeUndefined();
    expect((await rig.kit.connector.conversations.getMeta(rig.worldId, VALERIA))?.disclosedEpochs).toEqual([]);
  });

  it("two senders racing for the first outbound: only one carries the line, the other is rendered again without it [FL-001]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE, { disclosedEpochs: [] });
    const { connector } = rig.kit;
    let raced = false;
    // Another outbound of the epoch commits its line right after this one loaded the conversation.
    const gate = createOutboundGate({
      ...rig.deps,
      phoneHash: async (phone) => {
        if (!raced) {
          raced = true;
          await connector.write(connector.conversations.markDisclosedOp(rig.worldId, VALERIA, 1));
        }
        return rig.deps.phoneHash(phone);
      },
    });
    const outcome = await gate(request("COMPLAINT_ACK", { text: "Registramos tu reclamo." }), call(rig));
    expect(outcome.ok).toBe(true);
    const [message] = await outbound(rig);
    expect(message?.flags.disclosure).toBeUndefined();
    expect(message?.body).toBe("Registramos tu reclamo.");
    expect(rig.whatsappSent[0]?.outbound).toMatchObject({ body: "Registramos tu reclamo." });
  });
});
