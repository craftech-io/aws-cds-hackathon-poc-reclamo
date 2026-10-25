// Reroutes of a blocked message (FL-065, FL-066): a path offered by the block is picked, decided from
// the tape (never from the caller), and a formal email goes through the gate again as a new request.
import { describe, expect, it } from "vitest";
import { rerouteThroughGate } from "./gate";
import { MARTIN, OPERATOR, ROCIO, VALERIA, call, customerWrote, gateRig, request, seedComplaint, tapeOf } from "./testing";
import { GATE_AUDIT, type GateOutcome } from "./types";

const WROTE = "2026-10-07T10:05:00-03:00";
const TAKEN = { control: "OPERATOR" as const, controlledBy: "stf-operator-01" };

/** Martín's thread taken by the operator, who tries a collection reminder by WhatsApp (FL-064). */
async function blockedReminder(simNow?: string) {
  const rig = await gateRig();
  await customerWrote(rig, MARTIN, WROTE, { ...TAKEN, customerId: MARTIN });
  if (simNow !== undefined) rig.simNow = simNow;
  const blocked = await rig.gate(request("COLLECTION_REMINDER", { customerId: MARTIN, sender: OPERATOR, text: "Martín, tenés la cuota 3 vencida." }), call(rig, OPERATOR));
  if (blocked.ok || blocked.tapeId === undefined) throw new Error("expected a block on the tape");
  return { rig, tapeId: blocked.tapeId, reroute: rerouteThroughGate(rig.deps) };
}

function rawOf(rig: Awaited<ReturnType<typeof gateRig>>, index = 0): string {
  return new TextDecoder().decode(rig.email.sent[index]?.Content?.Raw?.Data);
}

describe("reroute to the formal debt notice by email [FL-065]", () => {
  it("a new request goes through the gate: REROUTED with the child's entry, ALLOWED and DISPATCH SENT, the notice rendered by code with its PDF [FL-065]", async () => {
    const { rig, tapeId, reroute } = await blockedReminder();
    const outcome = await reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId, route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR));
    expect(outcome).toMatchObject({ ok: true, decision: "REROUTED", reroutedTo: "FORMAL_EMAIL" });
    const tape = await tapeOf(rig);
    expect(tape.map((entry) => [entry.decision, entry.kind, entry.channel])).toEqual([
      ["BLOCKED", "COLLECTION_REMINDER", "WHATSAPP"],
      ["ALLOWED", "COLLECTION_NOTICE_EMAIL", "EMAIL"],
      ["DISPATCH", "COLLECTION_NOTICE_EMAIL", "EMAIL"],
      ["REROUTED", "COLLECTION_REMINDER", "WHATSAPP"],
    ]);
    const [, allowed, dispatched, rerouted] = tape;
    expect(allowed?.rerouteOf).toBe(tapeId);
    expect(allowed?.ruleIds).toEqual(expect.arrayContaining(["CH-FORMAL-CONTENT", "CH-CONTACT-HOURS", "CH-MAX-PER-DAY"]));
    expect(dispatched?.result).toBe("SENT");
    expect(rerouted).toMatchObject({ rerouteOf: tapeId, reroute: { route: "FORMAL_EMAIL", childTapeId: allowed?.tapeId } });
    expect(outcome.ok && outcome.decision === "REROUTED" ? outcome.childTapeId : undefined).toBe(allowed?.tapeId);
    expect(rig.email.sent).toHaveLength(1);
    expect(rig.email.sent[0]?.Destination).toEqual({ ToAddresses: [`success+${MARTIN}@simulator.amazonses.com`] });
    const raw = rawOf(rig);
    expect(raw).toContain("application/pdf");
    expect(raw).toContain("collection-notice.pdf");
    expect(rig.whatsappSent).toEqual([]);
  });

  it("carries no free text: what the operator wrote never reaches the notice [FL-065]", async () => {
    const { rig, tapeId, reroute } = await blockedReminder();
    await reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId, route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR));
    const stored = (await rig.kit.connector.conversations.listMessages(rig.worldId, MARTIN)).find((message) => message.kind === "COLLECTION_NOTICE_EMAIL");
    expect(stored?.body).toContain("Préstamo personal 0009");
    expect(stored?.body).not.toContain("tenés la cuota 3 vencida");
    expect(rig.g2.inputs).toEqual([]);
  });

  it("outside the hours of a formal notice the child is DEFERRED to the next 09:00 of a business day [FL-065]", async () => {
    const { rig, tapeId, reroute } = await blockedReminder("2026-10-07T18:30:00-03:00");
    const outcome = await reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId, route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR));
    expect(outcome).toMatchObject({ ok: true, decision: "REROUTED" });
    const tape = await tapeOf(rig);
    expect(tape.map((entry) => entry.decision)).toEqual(["BLOCKED", "DEFERRED", "REROUTED"]);
    expect(tape[1]?.nextAllowedAt).toBe("2026-10-08T09:00:00-03:00");
    expect(rig.email.sent).toEqual([]);
  });

  it("a second formal notice within seven days is BLOCKED by CH-MAX-PER-DAY [FL-065]", async () => {
    const { rig, tapeId, reroute } = await blockedReminder();
    await reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId, route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR));
    rig.simNow = "2026-10-09T11:00:00-03:00";
    const again = await rig.gate(request("COLLECTION_REMINDER", { customerId: MARTIN, sender: OPERATOR, text: "Martín, tenés la cuota 3 vencida." }), call(rig, OPERATOR));
    const second = await reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId: again.tapeId ?? "", route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR));
    expect(second).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-MAX-PER-DAY"] });
    expect(rig.email.sent).toHaveLength(1);
    expect((await tapeOf(rig)).at(-1)).toMatchObject({ decision: "REROUTED", rerouteOf: again.tapeId });
  });

  it("a block is rerouted once: picking again answers the first pick and sends nothing more [FL-065]", async () => {
    const { rig, tapeId, reroute } = await blockedReminder();
    const first = await reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId, route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR));
    const again = await reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId, route: "HUMAN_QUEUE", by: OPERATOR }, call(rig, OPERATOR));
    expect(again).toMatchObject({ ok: true, decision: "REROUTED", reroutedTo: "FORMAL_EMAIL", childTapeId: (first as Extract<GateOutcome, { decision: "REROUTED" }>).childTapeId });
    expect(rig.email.sent).toHaveLength(1);
    expect((await tapeOf(rig)).filter((entry) => entry.decision === "REROUTED")).toHaveLength(1);
  });

  it("the paths come from the stored block, never from the caller: a path the block did not offer is INVALID [FL-065]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    const blocked = await rig.gate(request("REPLY", { sender: OPERATOR, text: "Hola." }), call(rig, OPERATOR));
    expect(blocked).toMatchObject({ ok: false, ruleIds: ["CH-CONTROL"] });
    await expect(rerouteThroughGate(rig.deps)({ worldId: rig.worldId, customerId: VALERIA, tapeId: blocked.tapeId ?? "", route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR))).rejects.toMatchObject({ code: "INVALID" });
    expect(rig.email.sent).toEqual([]);
  });

  it("a block of another customer, an unknown block, or another sender's block for the system are refused [FL-065]", async () => {
    const { rig, tapeId, reroute } = await blockedReminder();
    await expect(reroute({ worldId: rig.worldId, customerId: VALERIA, tapeId, route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId: "tp-9999", route: "FORMAL_EMAIL", by: OPERATOR }, call(rig, OPERATOR))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId, route: "HUMAN_QUEUE", by: "SYSTEM" }, call(rig))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rig.email.sent).toEqual([]);
  });
});

describe("reroute to the human queue [FL-066]", () => {
  it("creates a human task on the conversation, audits it and sends nothing; the tape adds REROUTED HUMAN_QUEUE [FL-066]", async () => {
    const { rig, tapeId, reroute } = await blockedReminder();
    const outcome = await reroute({ worldId: rig.worldId, customerId: MARTIN, tapeId, route: "HUMAN_QUEUE", by: OPERATOR }, call(rig, OPERATOR));
    expect(outcome).toMatchObject({ ok: true, decision: "REROUTED", reroutedTo: "HUMAN_QUEUE" });
    const [task] = await rig.kit.connector.conversations.listTasks(rig.worldId, MARTIN);
    expect(task).toMatchObject({ author: OPERATOR, task: { status: "OPEN", route: "HUMAN_QUEUE", tapeId } });
    const [audit] = await rig.kit.connector.audit.listByAction(rig.worldId, GATE_AUDIT.HUMAN_QUEUE);
    expect(audit).toMatchObject({ ruleIds: ["CH-WA-NO-COLLECTION"], refs: { tapeId }, outcome: "HUMAN_TASK" });
    expect((await tapeOf(rig)).map((entry) => [entry.decision, entry.reroute?.route ?? null])).toEqual([
      ["BLOCKED", null],
      ["REROUTED", "HUMAN_QUEUE"],
    ]);
    expect(rig.email.sent).toEqual([]);
    expect(rig.whatsappSent).toEqual([]);
  });

  it("puts the task on the complaint when the blocked message belongs to one [FL-066]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, MARTIN, WROTE, { ...TAKEN, customerId: MARTIN });
    await seedComplaint(rig, { customerId: MARTIN });
    const blocked = await rig.gate(request("COLLECTION_REMINDER", { customerId: MARTIN, complaintId: "cmp-0001", sender: OPERATOR, text: "Martín, tenés la cuota 3 vencida." }), call(rig, OPERATOR));
    await rerouteThroughGate(rig.deps)({ worldId: rig.worldId, customerId: MARTIN, tapeId: blocked.tapeId ?? "", route: "HUMAN_QUEUE", by: OPERATOR }, call(rig, OPERATOR));
    const notes = await rig.kit.connector.caseItems.listNotes(rig.worldId, "cmp-0001");
    expect(notes).toEqual([expect.objectContaining({ kind: "HUMAN_TASK", task: expect.objectContaining({ route: "HUMAN_QUEUE", tapeId: blocked.tapeId }) })]);
  });
});

describe("the system reroutes its own blocked update", () => {
  it("a complaint update to a customer without WhatsApp opt-in goes by email instead, through the gate again", async () => {
    const rig = await gateRig();
    await seedComplaint(rig, { customerId: ROCIO });
    const outcome = await rig.gate(request("COMPLAINT_UPDATE", { customerId: ROCIO, complaintId: "cmp-0001", template: { name: "reclamo_novedad", params: ["Rocío", "R-2026-000123", "SETTLEMENT_PUBLISHED"] } }), call(rig));
    expect(outcome).toMatchObject({ ok: true, decision: "REROUTED", reroutedTo: "FORMAL_EMAIL" });
    expect((await tapeOf(rig)).map((entry) => [entry.decision, entry.channel, entry.ruleIds[0] ?? null])).toEqual([
      ["BLOCKED", "WHATSAPP", "CH-OPTIN"],
      ["ALLOWED", "EMAIL", "CH-SENDER"],
      ["DISPATCH", "EMAIL", null],
      ["REROUTED", "WHATSAPP", "CH-OPTIN"],
    ]);
    expect(rig.whatsappSent).toEqual([]);
    expect(rig.email.sent).toHaveLength(1);
    const stored = (await rig.kit.connector.conversations.listMessages(rig.worldId, ROCIO)).find((message) => message.channel === "EMAIL");
    expect(stored?.body).toContain("ya tenemos la rendición de la red");
  });
});
