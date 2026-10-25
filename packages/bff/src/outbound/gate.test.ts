// The outbound gate, step by step (docs/architecture-integrations.md §4): every evaluation leaves a
// tape entry, a refusal is an answer (never an exception), nothing refused reaches a transport, and
// what goes out is exactly what the tape hashed. The dispatch steps (claim, transport, deferral, the
// email cap) are in gate-dispatch.test.ts.
import { ToolError } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { message as messageRow } from "../connector/testing";
import { STATUS_QUESTION } from "./g2-query";
import { MARTIN, OPERATOR, VALERIA, agentTurn, call, customerWrote, gateRig, linesNamed, request, seedComplaint, tapeOf } from "./testing";
import { GATE_AUDIT, type OutboundRequest } from "./types";

const WROTE = "2026-10-07T10:05:00-03:00";
const TAKEN = { control: "OPERATOR" as const, controlledBy: "stf-operator-01" };

async function outbound(rig: Awaited<ReturnType<typeof gateRig>>, customerId = VALERIA) {
  return (await rig.kit.connector.conversations.listMessages(rig.worldId, customerId)).filter((row) => row.direction === "OUT");
}

describe("gate: the operator writes in the thread [FL-085]", () => {
  it("an operator who took the conversation sends through the gate: ALLOWED then DISPATCH SENT, the message signed by the operator [FL-085]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE, TAKEN);
    const outcome = await rig.gate(request("REPLY", { sender: OPERATOR, text: "Hola Valeria, ya estoy revisando tu caso." }), call(rig, OPERATOR));
    expect(outcome).toMatchObject({ ok: true, decision: "ALLOWED" });
    const tape = await tapeOf(rig);
    expect(tape.map((entry) => [entry.decision, entry.result ?? null, entry.sender])).toEqual([
      ["ALLOWED", null, OPERATOR],
      ["DISPATCH", "SENT", OPERATOR],
    ]);
    expect(tape[0]?.ruleIds).toEqual(expect.arrayContaining(["CH-CONTROL", "CH-WA-24H"]));
    const [sent] = await outbound(rig);
    expect(sent).toMatchObject({ sender: OPERATOR, kind: "REPLY", status: "DELIVERED", tapeRef: tape[0]?.tapeId });
    expect(rig.whatsappSent).toHaveLength(1);
  });

  it("an operator who did not take the conversation is blocked by CH-CONTROL and nothing goes out [FL-085]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    const outcome = await rig.gate(request("REPLY", { sender: OPERATOR, text: "Hola, ya estoy revisando tu caso." }), call(rig, OPERATOR));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-CONTROL"] });
    expect(rig.whatsappSent).toEqual([]);
  });

  it("a sender the world does not know (no staff row) never writes to a customer [FL-085]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE, TAKEN);
    const stranger = "OPERATOR:stf-stranger" as OutboundRequest["sender"];
    const outcome = await rig.gate(request("REPLY", { sender: stranger, text: "Hola." }), call(rig, stranger));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-SENDER"] });
    expect(rig.whatsappSent).toEqual([]);
  });
});

describe("gate: collection by WhatsApp from an operator [FL-064]", () => {
  it("is BLOCKED by CH-WA-NO-COLLECTION with the permitted paths, on the tape in the operator's name, and nothing goes out [FL-064]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, MARTIN, WROTE, { ...TAKEN, customerId: MARTIN });
    const outcome = await rig.gate(request("COLLECTION_REMINDER", { customerId: MARTIN, sender: OPERATOR, text: "Martín, tenés la cuota 3 vencida." }), call(rig, OPERATOR));
    expect(outcome).toMatchObject({
      ok: false,
      decision: "BLOCKED",
      ruleIds: ["CH-WA-NO-COLLECTION"],
      reroutes: [{ route: "HUMAN_QUEUE" }, { route: "FORMAL_EMAIL", previewKind: "COLLECTION_NOTICE_EMAIL" }],
      failure: { error: { code: "POLICY_DENIED" } },
    });
    const tape = await tapeOf(rig);
    expect(tape.map((entry) => [entry.decision, entry.ruleIds, entry.sender])).toEqual([["BLOCKED", ["CH-WA-NO-COLLECTION"], OPERATOR]]);
    expect(rig.whatsappSent).toEqual([]);
    const [attempt] = await outbound(rig, MARTIN);
    expect(attempt).toMatchObject({ status: "BLOCKED", tapeRef: tape[0]?.tapeId });
    expect(linesNamed(rig, "outbound.decision")).toEqual([expect.objectContaining({ metric: "GateDecisions", decision: "BLOCKED", ruleId: "CH-WA-NO-COLLECTION", senderClass: "OPERATOR" })]);
  });

  it("collection wording in an operator's reply is blocked even when the kind says REPLY [FL-064]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, MARTIN, WROTE, { ...TAKEN, customerId: MARTIN });
    const outcome = await rig.gate(request("REPLY", { customerId: MARTIN, sender: OPERATOR, text: "Recordá que tenés la cuota 3 vencida, pagala hoy para evitar recargos." }), call(rig, OPERATOR));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"] });
    expect(rig.whatsappSent).toEqual([]);
  });
});

describe("gate: text not grounded in the turn [FL-062]", () => {
  it("an agent reply with an amount no tool returned is BLOCKED on VERIFY with GROUNDING_FAIL; the figure never goes out [FL-062]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await agentTurn(rig, VALERIA, "trn-0001", [{ outstanding: "$ 64.210,00", nextDue: "22/10/2026" }]);
    const outcome = await rig.gate(request("REPLY", { sender: "AGENT", turnId: "trn-0001", text: "Te quedan $ 99.999,00 por pagar." }), call(rig, "AGENT"));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["VERIFY"], failure: { error: { code: "GROUNDING_FAIL" } } });
    expect((await tapeOf(rig)).map((entry) => [entry.decision, entry.ruleIds])).toEqual([["BLOCKED", ["VERIFY"]]]);
    expect(rig.whatsappSent).toEqual([]);
    expect(JSON.stringify(rig.lines)).not.toContain("99.999");
  });

  it("the same reply with the values the tools returned goes out [FL-062]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await agentTurn(rig, VALERIA, "trn-0001", [{ outstanding: "$ 64.210,00", nextDue: "22/10/2026" }]);
    const outcome = await rig.gate(request("REPLY", { sender: "AGENT", turnId: "trn-0001", text: "Te quedan $ 64.210,00 y la próxima cuota vence el 22/10/2026." }), call(rig, "AGENT"));
    expect(outcome).toMatchObject({ ok: true, decision: "ALLOWED" });
    expect(rig.g2.inputs[0]?.grounding?.source).toContain("64.210,00");
    // The scores that let it through stay on the message (EV-1 calibrates ADR-0008's threshold with them).
    const sent = await rig.kit.connector.conversations.findMessage(rig.worldId, VALERIA, outcome.ok ? outcome.messageId : "");
    expect(sent?.g2).toEqual({ groundingScore: 0.92, relevanceScore: 0.81 });
  });

  it("a G2 grounding refusal is BLOCKED on G2, logged and audited with its reason and scores, never with the text [FL-062]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await agentTurn(rig, VALERIA, "trn-0001", [{ outstanding: "$ 64.210,00" }]);
    rig.g2.verdict = { action: "BLOCKED", failure: "GROUNDING", groundingScore: 0.41, relevanceScore: 0.77 };
    const text = "Te quedan $ 64.210,00 y todo está en orden.";
    const outcome = await rig.gate(request("REPLY", { sender: "AGENT", turnId: "trn-0001", text }), call(rig, "AGENT"));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["G2"], failure: { error: { code: "GROUNDING_FAIL" } } });
    expect(linesNamed(rig, "outbound.g2_refused")).toEqual([expect.objectContaining({ reason: "GROUNDING", groundingScore: 0.41, relevanceScore: 0.77, grounded: true })]);
    const [audit] = await rig.kit.connector.audit.listByAction(rig.worldId, GATE_AUDIT.G2_REFUSED);
    expect(audit).toMatchObject({ ruleIds: ["G2"], outcome: "GROUNDING", detail: { reason: "GROUNDING", groundingScore: 0.41, relevanceScore: 0.77 } });
    expect(JSON.stringify(audit)).not.toContain("todo está en orden");
    expect(JSON.stringify(linesNamed(rig, "outbound.g2_refused"))).not.toContain("todo está en orden");
    expect(rig.whatsappSent).toEqual([]);
  });

  it("scores a reply to small talk against the fixed status question, and a real question against the customer's words [FL-062]", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await rig.kit.connector.conversations.putMessage(messageRow(rig.worldId, { customerId: VALERIA, messageId: "in-hola", body: "hola", atSim: "2026-10-07T10:08:00-03:00" }));
    await agentTurn(rig, VALERIA, "trn-0001", [{ openComplaint: "R-2026-000123", balance: "$ 64.210,00" }]);
    await rig.gate(request("REPLY", { sender: "AGENT", turnId: "trn-0001", text: "Hola Valeria. Tu reclamo R-2026-000123 sigue en curso." }), call(rig, "AGENT"));
    expect(rig.g2.inputs[0]?.grounding?.query).toBe(STATUS_QUESTION);
    await rig.kit.connector.conversations.putMessage(messageRow(rig.worldId, { customerId: VALERIA, messageId: "in-q", body: "¿cuánto me queda por pagar?", atSim: "2026-10-07T10:09:00-03:00" }));
    await rig.gate(request("REPLY", { sender: "AGENT", turnId: "trn-0001", text: "Te quedan $ 64.210,00." }), call(rig, "AGENT"));
    expect(rig.g2.inputs[1]?.grounding?.query).toBe("¿cuánto me queda por pagar?");
  });

  it("a short service text without facts is checked by G2 without grounding (only the denied topics decide)", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await agentTurn(rig, VALERIA, "trn-0001", []);
    await rig.gate(request("IDENTITY_CHALLENGE", { sender: "AGENT", turnId: "trn-0001", text: "Para seguir, contame tu fecha de nacimiento." }), call(rig, "AGENT"));
    expect(rig.g2.inputs).toEqual([{ kind: "IDENTITY_CHALLENGE", text: "Para seguir, contame tu fecha de nacimiento." }]);
  });

  it("G2 unavailable fails closed: BLOCKED on G2 with UNAVAILABLE, nothing goes out", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await agentTurn(rig, VALERIA, "trn-0001", []);
    const { GuardrailUnavailableError } = await import("./g2");
    rig.g2.verdict = new GuardrailUnavailableError("ApplyGuardrail failed");
    const outcome = await rig.gate(request("REPLY", { sender: "AGENT", turnId: "trn-0001", text: "Ya lo estoy revisando." }), call(rig, "AGENT"));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["G2"], failure: { error: { code: "UNAVAILABLE", reason: "GUARDRAIL_UNAVAILABLE" } } });
    expect(rig.whatsappSent).toEqual([]);
  });

  it("a system text of copy/ never reaches G2", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await rig.gate(request("COMPLAINT_ACK", { text: "Registramos tu reclamo." }), call(rig));
    expect(rig.g2.inputs).toEqual([]);
  });
});

describe("gate: templates outside the window", () => {
  it("free text outside the 24-hour window is TEMPLATE_REQUIRED; a template with a phrase outside the closed list is TEMPLATE_PARAM_NOT_ALLOWED; both on the tape", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, "2026-10-05T10:05:00-03:00");
    await seedComplaint(rig);
    const text = await rig.gate(request("COMPLAINT_UPDATE", { complaintId: "cmp-0001", text: "Hay una novedad en tu reclamo." }), call(rig));
    expect(text).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-WA-24H"], failure: { error: { code: "TEMPLATE_REQUIRED" } } });
    const loose = await rig.gate(request("COMPLAINT_UPDATE", { complaintId: "cmp-0001", template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "ya te pagamos todo"] } }), call(rig));
    expect(loose).toMatchObject({ ok: false, decision: "BLOCKED", failure: { error: { code: "TEMPLATE_PARAM_NOT_ALLOWED" } } });
    const listed = await rig.gate(request("COMPLAINT_UPDATE", { complaintId: "cmp-0001", template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "HUMAN_REVIEWED"] } }), call(rig));
    expect(listed).toMatchObject({ ok: true, decision: "ALLOWED" });
    expect(rig.whatsappSent.map((sent) => sent.outbound.kind)).toEqual(["template"]);
    expect((await tapeOf(rig)).map((entry) => entry.decision)).toEqual(["BLOCKED", "BLOCKED", "ALLOWED", "DISPATCH"]);
  });
});

describe("gate: who may ask and for whom", () => {
  it("the agent sends only inside an open turn of this customer", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await customerWrote(rig, MARTIN, WROTE, { customerId: MARTIN });
    await agentTurn(rig, MARTIN, "trn-0009", []);
    const foreignTurn = await rig.gate(request("REPLY", { sender: "AGENT", turnId: "trn-0009", text: "Ya lo estoy revisando." }), call(rig, "AGENT"));
    const noTurn = await rig.gate(request("REPLY", { sender: "AGENT", text: "Ya lo estoy revisando." }), call(rig, "AGENT"));
    expect(foreignTurn).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-SENDER"] });
    expect(noTurn).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-SENDER"] });
    expect(await tapeOf(rig)).toHaveLength(2);
  });

  it("a complaint of another customer never moves a message to that case", async () => {
    const rig = await gateRig();
    await seedComplaint(rig, { customerId: MARTIN });
    await expect(rig.gate(request("COMPLAINT_UPDATE", { complaintId: "cmp-0001", text: "Hay una novedad." }), call(rig))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rig.whatsappSent).toEqual([]);
  });

  it("an invalid request (an unknown key, a bad id) is INVALID before anything is read", async () => {
    const rig = await gateRig();
    const extra = { ...request("COMPLAINT_ACK", { text: "Hola" }), recipient: "+5491100000000" } as unknown as OutboundRequest;
    await expect(rig.gate(extra, call(rig))).rejects.toBeInstanceOf(ToolError);
    await expect(rig.gate(request("COMPLAINT_ACK", { customerId: "nobody", text: "Hola" }), call(rig))).rejects.toMatchObject({ code: "INVALID" });
    expect(await tapeOf(rig)).toEqual([]);
  });

  it("a written answer goes out only under the claim its FINAL_ANSWER put on the complaint", async () => {
    const rig = await gateRig();
    await seedComplaint(rig, { status: "RESOLVED" });
    const answer = request("FORMAL_ANSWER", { sender: "AGENT", channel: "EMAIL", complaintId: "cmp-0001", messageId: "msg-answer-1", text: "Revisamos tu reclamo y lo resolvimos." });
    await expect(rig.gate(answer, call(rig, "AGENT"))).rejects.toMatchObject({ code: "CONFLICT", reason: "ANSWER_NOT_CLAIMED" });
    expect(rig.email.sent).toEqual([]);
  });
});

describe("gate: the tape records every evaluation", () => {
  it("a block, an allowed send and its dispatch each leave an entry; the customer is a keyed hash, never the id", async () => {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE);
    await rig.gate(request("IDENTITY_CHALLENGE", { text: "¿Cuándo vence tu próxima cuota?" }), call(rig));
    await rig.gate(request("COMPLAINT_ACK", { text: "Registramos tu reclamo." }), call(rig));
    const tape = await tapeOf(rig);
    expect(tape.map((entry) => entry.decision)).toEqual(["BLOCKED", "ALLOWED", "DISPATCH"]);
    expect(tape.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(JSON.stringify(tape)).not.toContain(VALERIA);
    expect(new Set(tape.map((entry) => entry.customerRef)).size).toBe(1);
    expect(rig.kit.anchorRequests.length).toBeGreaterThanOrEqual(3);
  });
});
