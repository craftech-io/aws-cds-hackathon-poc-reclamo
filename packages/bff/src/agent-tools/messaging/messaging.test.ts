import { describe, expect, it } from "vitest";
import { deadlineText } from "../../complaints/sla";
import { WHATSAPP_TEXT } from "../../copy";
import { gatewayContext } from "../common/principal";
import { WORLD } from "../common/testing";
import { blocked, effectWorld, inProcessCore } from "../actions/testing";
import { createMessagingTarget } from "./handler";
import { coreLoanOwnership } from "./ownership";

async function messagingWorld() {
  const world = await effectWorld();
  const target = createMessagingTarget(world.deps, { gate: world.gate.gate });
  const complaint = await world.addComplaint({ status: "AWAITING_NETWORK", type: "TRANSFER_NOT_CREDITED" });
  const turn = await world.openTurn({ complaintIds: [complaint.complaintId], eventId: "evt-network-1" });
  const send = (input: Record<string, unknown>, token = turn.token) => target.handle({ sessionToken: token, ...input }, gatewayContext("messaging___send_whatsapp"));
  return { world, complaint, turn, send };
}

describe("send_whatsapp [FL-042]", () => {
  it("goes through the gate to the session's customer, with 'Hablar con alguien' added by code", async () => {
    const { world, complaint, turn, send } = await messagingWorld();
    const answer = await send({ kind: "REPLY", text: "Tu transferencia sigue en proceso en la red.", buttons: [{ action: "SEE_DETAIL", ref: complaint.complaintId }] });
    expect(answer).toMatchObject({ ok: true, decision: "ALLOWED", ruleIds: [] });
    const request = world.gate.sent[0]?.request;
    expect(request).toMatchObject({
      worldId: WORLD,
      customerId: "cus-0001",
      complaintId: complaint.complaintId,
      sender: "AGENT",
      channel: "WHATSAPP",
      kind: "REPLY",
      turnId: turn.turnId,
      triggerEventId: "evt-network-1",
      buttons: [{ action: "SEE_DETAIL", ref: complaint.complaintId }, { action: "TALK_TO_HUMAN", ref: complaint.complaintId }],
    });
    expect(world.gate.sent[0]?.call.actor).toBe("AGENT");
    expect((await world.auditRows()).find((row) => row.action === "SEND_WHATSAPP")).toMatchObject({ outcome: "ALLOWED" });
  });

  it("the recipient is never an input: a recipient field, a collection kind or a third model button is refused before the gate", async () => {
    const { world, send } = await messagingWorld();
    for (const field of ["to", "phone", "recipient", "email"]) expect(await send({ kind: "REPLY", text: "Hola", [field]: "+5491100000000" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await send({ kind: "COLLECTION_REMINDER", text: "Recordá pagar" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await send({ kind: "REPLY", text: "Hola", buttons: [{ action: "SEE_DETAIL" }, { action: "HAVE_A_QUESTION" }, { action: "WITHDRAW" }] })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "TOO_MANY_BUTTONS" } });
    expect(world.gate.sent).toEqual([]);
  });

  it("[FL-042] exactly one COMPLAINT_UPDATE per event that opened the turn: the second is CONFLICT; a new event allows another", async () => {
    const { world, complaint, send } = await messagingWorld();
    const update = { kind: "COMPLAINT_UPDATE", text: "Tu transferencia ya se acreditó.", complaintId: complaint.complaintId };
    expect(await send(update)).toMatchObject({ ok: true, decision: "ALLOWED" });
    expect(await send(update)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await send({ kind: "REPLY", text: "¿Algo más?" })).toMatchObject({ ok: true });
    expect(world.gate.sent.filter((item) => item.request.kind === "COMPLAINT_UPDATE")).toHaveLength(1);
    const next = await world.openTurn({ complaintIds: [complaint.complaintId], eventId: "evt-network-2" });
    expect(await send(update, next.token)).toMatchObject({ ok: true });
  });

  it("[FL-042] a blocked update can be retried: only a sent (or deferred) one counts for the event", async () => {
    const { world, complaint, send } = await messagingWorld();
    world.gate.answerWith(() => blocked("CH-WA-NO-COLLECTION"));
    const update = { kind: "COMPLAINT_UPDATE", text: "Novedad de tu reclamo.", complaintId: complaint.complaintId };
    expect(await send(update)).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" }, decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"], reroutes: ["HUMAN_QUEUE"] });
    world.gate.answerWith((request) => ({ ok: true, decision: "DEFERRED", messageId: request.messageId ?? "msg-d", ruleIds: ["CH-CONTACT-HOURS"], nextAllowedAt: "2026-10-08T08:00:00-03:00", timerKey: "t" }));
    expect(await send(update)).toMatchObject({ ok: true, decision: "DEFERRED", deferredUntilText: "jueves 08/10 08:00" });
    expect(await send(update)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("the same message asked twice in the turn: the gate's replay (ADR-0021) is answered as the message already sent", async () => {
    const { world, send } = await messagingWorld();
    world.gate.answerWith((_request, index) =>
      index === 1 ? { ok: true, decision: "ALLOWED", messageId: "msg-first", ruleIds: [], providerMessageId: "wamid-1" } : { ok: true, decision: "ALLOWED", messageId: "msg-first", replayOf: "msg-first", ruleIds: [] },
    );
    const reply = { kind: "REPLY", text: "Tu reclamo sigue en curso." };
    expect(await send(reply)).toMatchObject({ ok: true, decision: "ALLOWED", messageId: "msg-first" });
    const again = await send(reply);
    expect(again).toMatchObject({ ok: true, decision: "ALLOWED", messageId: "msg-first", replayOf: "msg-first" });
    const audits = (await world.auditRows()).filter((row) => row.action === "SEND_WHATSAPP");
    expect(audits).toHaveLength(2);
    expect(audits.filter((row) => row.refs["replayOf"] === "msg-first")).toHaveLength(1);
  });

  it("a template: {{3}} outside the closed list is TEMPLATE_PARAM_NOT_ALLOWED, a value not in this turn's results is GROUNDING_FAIL", async () => {
    const { world, complaint, turn, send } = await messagingWorld();
    await world.connector.sessions.putTurnResult(WORLD, turn.turnId, "identify_customer", { ok: true, firstName: "Valeria" });
    const template = (params: string[]) => ({ kind: "COMPLAINT_UPDATE", template: { name: "reclamo_novedad", params }, complaintId: complaint.complaintId });
    expect(await send(template(["Valeria", complaint.complaintNumber, "Pagá hoy"]))).toMatchObject({ ok: false, error: { code: "TEMPLATE_PARAM_NOT_ALLOWED" } });
    expect(await send(template(["Martina", complaint.complaintNumber, "TRANSFER_CREDITED"]))).toMatchObject({ ok: false, error: { code: "GROUNDING_FAIL" } });
    // A truncated number, or a fragment of the name, is contained in a value but is not that value.
    expect(await send(template(["Valeria", complaint.complaintNumber.slice(0, -1), "TRANSFER_CREDITED"]))).toMatchObject({ ok: false, error: { code: "GROUNDING_FAIL" } });
    expect(await send(template(["Val", complaint.complaintNumber, "TRANSFER_CREDITED"]))).toMatchObject({ ok: false, error: { code: "GROUNDING_FAIL" } });
    expect(world.gate.sent).toEqual([]);
    expect(await send({ ...template(["Valeria", complaint.complaintNumber, "TRANSFER_CREDITED"]), buttons: [{ action: "WITHDRAW" }] })).toMatchObject({ ok: true });
    const request = world.gate.sent[0]?.request;
    expect(request?.template).toEqual({ name: "reclamo_novedad", params: ["Valeria", complaint.complaintNumber, "TRANSFER_CREDITED"] });
    expect(request?.buttons).toBeUndefined();
  });

  it("a template's deadline is exactly the message's complaint's deadline: a fragment or a complaint number in its slot is GROUNDING_FAIL", async () => {
    const { world, complaint, send } = await messagingWorld();
    const due = deadlineText(complaint.deadlineSim);
    const derivado = (deadline: string) => ({ kind: "COMPLAINT_UPDATE", template: { name: "reclamo_derivado", params: [complaint.complaintNumber, deadline] }, complaintId: complaint.complaintId });
    for (const loose of [due.slice(0, -4), due.slice(-5, -1), complaint.complaintNumber, "lunes 01/01"]) {
      expect(await send(derivado(loose)), loose).toMatchObject({ ok: false, error: { code: "GROUNDING_FAIL" } });
    }
    expect(world.gate.sent).toEqual([]);
    expect(await send(derivado(due))).toMatchObject({ ok: true });
    expect(world.gate.sent[0]?.request.template).toEqual({ name: "reclamo_derivado", params: [complaint.complaintNumber, due] });
  });

  it("[FL-003] [FL-053] before identification the challenge goes only as IDENTITY_CHALLENGE and the closure button is never offered", async () => {
    const { world, send } = await messagingWorld();
    const insideReply = "¡Hola! Para darte un número de reclamo primero necesito confirmar tu identidad. ¿Me decís la fecha de vencimiento de tu última cuota?";
    expect(await send({ kind: "REPLY", text: insideReply })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "CHALLENGE_OUTSIDE_ITS_KIND" } });
    expect(await send({ kind: "REPLY", text: `Hola. ${WHATSAPP_TEXT.CHALLENGE_LAST_MOVEMENT_AMOUNT}`, buttons: [{ action: "ACCEPT_EMAIL" }] })).toMatchObject({ ok: false, error: { reason: "CHALLENGE_OUTSIDE_ITS_KIND" } });
    expect(await send({ kind: "REPLY", text: "La baja se confirma por escrito.", buttons: [{ action: "CONFIRM_CLOSURE" }] })).toMatchObject({ ok: false, error: { code: "NOT_IDENTIFIED", reason: "BUTTON_BEFORE_IDENTIFICATION" } });
    expect(world.gate.sent).toEqual([]);

    expect(await send({ kind: "IDENTITY_CHALLENGE", text: WHATSAPP_TEXT.CHALLENGE_LAST_DUE_DATE })).toMatchObject({ ok: true });
    expect(await send({ kind: "REPLY", text: "Todo reclamo recibe un número en el momento en que se presenta." })).toMatchObject({ ok: true });
    await world.identify();
    expect(await send({ kind: "REPLY", text: "¿Confirmás la baja de tu cuenta?", buttons: [{ action: "CONFIRM_CLOSURE" }] })).toMatchObject({ ok: true });
    expect(world.gate.sent.map((item) => item.request.kind)).toEqual(["IDENTITY_CHALLENGE", "REPLY", "REPLY"]);
  });

  it("LAM-SCOPE on button refs and LAM-CONTROL: another customer's loan is FORBIDDEN; a taken-over conversation is CONTROL_OPERATOR", async () => {
    const { world, send } = await messagingWorld();
    world.owned.add("L-0001");
    expect(await send({ kind: "REPLY", text: "¿Sobre cuál préstamo?", buttons: [{ action: "CHOOSE_LOAN", ref: "L-0001" }] })).toMatchObject({ ok: true });
    expect(await send({ kind: "REPLY", text: "¿Sobre cuál préstamo?", buttons: [{ action: "CHOOSE_LOAN", ref: "L-9999" }] })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    await world.takeOver();
    expect(await send({ kind: "REPLY", text: "Hola" })).toMatchObject({ ok: false, error: { code: "CONTROL_OPERATOR" } });
    expect(world.gate.sent).toHaveLength(1);
  });
});

describe("loan ownership of the messaging target", () => {
  it("asks the core at the world's simulated instant; another customer's or an unknown loan is not the customer's", async () => {
    const world = await effectWorld();
    await world.connector.runtime.putClock({ worldId: WORLD, mode: "PAUSED", pausedSimNow: "2026-10-07T10:10:00-03:00", worldEpoch: 1 });
    const core = inProcessCore([
      { customerId: "cus-0001", loans: [{ loanId: "L-0001", principal: 1_000_000, instalments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-1${number - 1}-05`, amount: 400_000 })) }] },
      { customerId: "cus-0002", phoneHash: "b".repeat(64), loans: [{ loanId: "L-0002", principal: 1_000_000, instalments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-1${number - 1}-05`, amount: 400_000 })) }] },
    ]);
    const ownership = coreLoanOwnership(world.connector, () => core.client);
    const ref = (id: string) => ({ worldId: WORLD, customerId: "cus-0001", id });
    expect(await ownership.owns("LOAN", ref("L-0001"))).toBe(true);
    expect(await ownership.owns("LOAN", ref("L-0002"))).toBe(false);
    expect(await ownership.owns("LOAN", ref("L-0404"))).toBe(false);
    expect(await ownership.owns("CHARGE", ref("chg-1"))).toBe(false);
  });
});
