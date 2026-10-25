// Local flows of the intake (docs/flows-catalog.md areas A and B): the phone of a persona in the demo
// world reaches the real `InboundWhatsApp`, the classifier answers from the evaluation set, the number is
// given by code before any turn, and the scripted Harness plays the agent through the Gateway. The
// asserts read the persisted state, the register and the tape, never a text the model would write.
import { describe, expect, it, vi } from "vitest";
import { buildSimulatedEvent, newSimulatedWamid } from "@reclamo/bff/channels/whatsapp/sim-envelope";
import type { Message } from "@reclamo/bff/domain/conversation";
import { WHATSAPP_TEXT } from "@reclamo/bff/copy/index";
import { unknownPartyOf } from "@reclamo/bff/outbound/unknown-sender";
import { LOCAL_KEYS, phoneHashOf } from "./support/keys";
import { type PlannedCall, type ScriptedTurn, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, challengeAnswer, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const C01 = "cus-0001";
const C08 = "cus-0008";
/** Texts of the classifier's evaluation set (scripts/seed/data/evals/classifier.json). */
const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const HOW_MUCH_LEFT = "¿Cuánto me falta pagar del préstamo?";
const PAYMENTS_DETAIL = "Necesito el detalle de todos los pagos del año";


/** `<worldId>.<sessionId>.<turnId>.<exp>.<HMAC>`: the turn the session token was issued for. */
function turnIdOf(turn: ScriptedTurn | undefined): string {
  return turn?.sessionToken.split(".")[2] ?? "";
}

async function outbound(world: FlowWorld, customerId: string): Promise<Message[]> {
  return (await world.connector.conversations.listMessages("demo", customerId)).filter((message) => message.direction === "OUT").sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim) || a.messageId.localeCompare(b.messageId));
}

async function lastInboundId(world: FlowWorld, customerId: string): Promise<string> {
  const inbound = (await world.connector.conversations.listMessages("demo", customerId)).filter((message) => message.direction === "IN");
  const last = inbound.sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim)).at(-1);
  if (last === undefined) throw new Error(`${customerId} wrote nothing`);
  return last.messageId;
}

const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });

describe("[FL-001] first message: the automated assistant introduces itself", () => {
  it("[FL-001] a greeting gets the disclosure line and the talk-to-a-person button once per session epoch, and never stays unanswered", async () => {
    const world = await createFlowWorld({ plans: [[reply("¡Hola Valeria! ¿En qué te ayudo?")], [reply("Contame qué necesitás.")], []] });
    await world.phone(C01, { type: "text", text: "Hola" });
    const [turn] = world.harness.turns;
    expect(turn?.event.type).toBe("CUSTOMER_MESSAGE");
    expect(turn?.preloaded.identify_customer).toMatchObject({ status: "NEEDS_CHALLENGE" });
    expect(world.guardrails.g2.inputs[0]).toMatchObject({ kind: "REPLY" });

    const meta = await world.connector.conversations.getMeta("demo", C01);
    expect(meta).toMatchObject({ disclosedEpochs: [0], sessionEpoch: 0 });
    expect(Date.parse(meta?.windowOpenUntilSim ?? "")).toBe(Date.parse("2026-10-08T10:10:00-03:00"));
    const [first] = await outbound(world, C01);
    expect(first).toMatchObject({ kind: "REPLY", sender: "AGENT", flags: { disclosure: true } });
    expect((first?.interactive as { buttons: { action: string }[] }).buttons.map((button) => button.action)).toContain("TALK_TO_HUMAN");
    expect((await world.connector.chains.listTapeByMessage(first?.messageId ?? "")).map((entry) => entry.decision)).toEqual(expect.arrayContaining(["ALLOWED", "DISPATCH"]));

    await world.phone(C01, { type: "text", text: "Buenas" });
    const second = (await outbound(world, C01))[1];
    expect(second?.kind).toBe("REPLY");
    expect(second?.flags.disclosure).not.toBe(true);

    // A turn that writes nothing: the code answers anyway (ALWAYS_ANSWER), at the same paused instant.
    await world.phone(C01, { type: "text", text: "Hola" });
    expect((await outbound(world, C01)).length).toBe(3);
    expect(await world.connector.complaints.listByCustomer("demo", C01)).toEqual([]);
  });
});

describe("[FL-002] a number that is not linked", () => {
  it("[FL-002] gets the fixed reply through the gate with no turn, no classifier and no complaint, and its text is not kept", async () => {
    const world = await createFlowWorld();
    const from = "+5491199999901";
    const event = buildSimulatedEvent(LOCAL_KEYS.simEnvelope.console, { kid: "console", worldId: "demo", from, wamid: newSimulatedWamid(world.realNow().getTime()), content: { type: "text", text: "Hola, ¿esto es Jarilla?" }, at: world.realNow() });
    const summary = await world.inboundWhatsApp(event);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "UNKNOWN_SENDER" });
    expect(world.harness.turns).toHaveLength(0);
    expect(world.classifier.texts).toHaveLength(0);
    expect((await world.connector.audit.listByAction("demo", "DENY")).some((entry) => entry.outcome === "UNKNOWN_SENDER")).toBe(true);
    const party = unknownPartyOf(await phoneHashOf(from));
    const messages = await world.connector.conversations.listMessages("demo", party);
    const fixed = messages.find((message) => message.direction === "OUT");
    expect(fixed).toMatchObject({ sender: "SYSTEM", status: "DELIVERED" });
    expect(fixed?.body).toContain(WHATSAPP_TEXT.UNKNOWN_SENDER);
    expect(messages.find((message) => message.direction === "IN")?.body).toBe("");
    expect((await world.connector.chains.listTapeByMessage(fixed?.messageId ?? "")).map((entry) => entry.decision)).toEqual(expect.arrayContaining(["ALLOWED", "DISPATCH"]));
    expect(await world.connector.complaints.listByCustomer("demo", party)).toEqual([]);
    expect(await world.connector.counters.getComplaintCounter("demo", 1, 2026)).toBe(122);
  });
});

describe("[FL-010] a complaint gets its number on the spot", () => {
  it("[FL-010] the acknowledgement with the number, the deadline and the email buttons leaves before any turn, in one transaction with FILED and three milestones", async () => {
    const world = await createFlowWorld({ plans: () => [] });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    expect(complaint).toMatchObject({ customerId: C01, kind: "RECLAMO", type: "PAYMENT_NOT_REFLECTED", status: "REGISTERED", origin: "LIVE" });
    expect(Date.parse(complaint?.deadlineSim ?? "")).toBe(Date.parse("2026-10-22T23:59:59-03:00"));
    const sent = await outbound(world, C01);
    const ack = sent.find((message) => message.kind === "COMPLAINT_ACK");
    expect(ack).toMatchObject({ sender: "SYSTEM", flags: { disclosure: true } });
    expect(sent.every((message) => (message.createdAt ?? "") >= (ack?.createdAt ?? ""))).toBe(true);
    expect(ack?.body).toContain("R-2026-000123");
    expect((ack?.interactive as { buttons: { action: string }[] }).buttons.map((button) => button.action)).toEqual(expect.arrayContaining(["ACCEPT_EMAIL", "TALK_TO_HUMAN"]));
    expect(ack?.body).not.toMatch(/\$\s?\d/);
    const register = await world.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123");
    expect(register.map((entry) => entry.eventType)).toContain("FILED");
    const timers = await world.connector.timers.listByOwner("demo", `CMP#${complaint?.complaintId}`);
    expect(timers.filter((timer) => timer.kind === "SLA").map((timer) => timer.status)).toEqual(["SCHEDULED", "SCHEDULED", "SCHEDULED"]);
    const kpis = await world.connector.metrics.list("demo");
    const ackLatency = kpis.find((kpi) => kpi.complaintId === complaint?.complaintId)?.ackLatencyMs;
    expect(ackLatency).toBeLessThan(10_000);
    const firstTurn = world.harness.turns[0];
    expect(firstTurn?.facts.find((fact) => fact.name === "complaint")?.attributes).toMatchObject({ number: "R-2026-000123", status: "REGISTERED" });
  });
});

describe("[FL-003] the identity challenge passed", () => {
  it("[FL-003] the agent asks, the customer answers and verify_challenge identifies them for 30 minutes and moves the complaint to INVESTIGATING", async () => {
    const world = await createFlowWorld();
    world.harness.script((turn) => (repliesToChallenge(turn) ? [verifyWritten] : [askChallenge]));
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    expect((await outbound(world, C01)).filter((message) => message.kind === "IDENTITY_CHALLENGE").at(-1)?.body).toContain(WHATSAPP_TEXT.CHALLENGE_LAST_DUE_DATE);
    await answerChallenge(world, C01);
    expect(world.harness.turns.at(-1)?.inbound).toBe("5/10");
    expect(outputOf(world.harness.results.at(-1))).toMatchObject({ result: "OK" });
    const meta = await world.connector.conversations.getMeta("demo", C01);
    expect(Date.parse(meta?.identifiedUntilReal ?? "")).toBe(world.realNow().getTime() + 30 * 60_000);
    expect((await world.connector.caps.getChallenge("demo", C01))?.failures ?? []).toHaveLength(0);
    expect((await world.connector.audit.listByAction("demo", "IDENTIFIED")).map((entry) => entry.outcome)).toContain("OK");
    expect((await world.connector.complaints.getByNumber("demo", "R-2026-000123"))?.status).toBe("INVESTIGATING");
  });

  it("[FL-003] a greeting is never an answer: the model's guess and a copy of the prompt are refused and count nothing; the customer's own answer identifies once", async () => {
    const world = await createFlowWorld();
    const realDueDate = await challengeAnswer(world, C01);
    // The model asks and, in the same turn, verifies a value the customer never wrote (the persona's real
    // due date) and a copy of the prompt: both refused before the core, nothing counted.
    world.harness.script([[askChallenge, { tool: "verify_challenge", input: { answer: realDueDate } }, { tool: "verify_challenge", input: { answer: "con día y mes (dd/mm)" } }], [verifyWritten], [{ tool: "verify_challenge", input: { answer: realDueDate } }]]);
    await world.phone(C01, { type: "text", text: "hola" });
    const refused = world.harness.results.filter((call) => call.tool === "verify_challenge").map((call) => (call.answer.kind === "RESULT" && !call.answer.response.ok ? call.answer.response.error : undefined));
    expect(refused).toEqual([expect.objectContaining({ code: "INVALID", reason: "ANSWER_NOT_WRITTEN" }), expect.objectContaining({ code: "INVALID", reason: "ANSWER_NOT_WRITTEN" })]);
    expect(await world.connector.caps.getChallenge("demo", C01)).toBeUndefined();
    expect((await world.connector.conversations.getMeta("demo", C01))?.identifiedUntilReal).toBeUndefined();
    expect((await world.connector.audit.listByAction("demo", "CHALLENGE_ANSWER_REFUSED")).map((entry) => entry.outcome)).toEqual(["ANSWER_NOT_WRITTEN", "ANSWER_NOT_WRITTEN"]);

    // The customer writes it: identified.
    await answerChallenge(world, C01);
    expect(outputOf(world.harness.results.at(-1))).toMatchObject({ result: "OK" });

    // Past the identification, the model replays the answer: that reply is spent, no second identification.
    world.advanceReal(31 * 60_000);
    await world.phone(C01, { type: "text", text: "¿Me confirmás?" });
    const replayed = world.harness.results.at(-1);
    expect(replayed?.answer.kind === "RESULT" && !replayed.answer.response.ok && replayed.answer.response.error.reason).toBe("ANSWER_ALREADY_USED");
    expect(Date.parse((await world.connector.conversations.getMeta("demo", C01))?.identifiedUntilReal ?? "")).toBeLessThan(world.realNow().getTime());
  });
});

describe("[FL-004] two failed challenges: a person verifies", () => {
  it("[FL-004] the second failure locks, escalates IDENTITY_VERIFICATION with its notice, and a new complaint or a clock move does not reset the count", async () => {
    // The agent asks; each wrong answer of the customer is verified as written, and the first one asked again.
    const world = await createFlowWorld({ plans: [[askChallenge], [verifyWritten, askChallenge], [verifyWritten]] });
    const verified = () => world.harness.results.filter((call) => call.tool === "verify_challenge");
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    await answerChallenge(world, C01, { answer: "1/1" });
    expect(outputOf(verified()[0])).toMatchObject({ result: "FAILED" });
    await answerChallenge(world, C01, { answer: "2/2" });
    expect(outputOf(verified()[1])).toMatchObject({ result: "LOCKED" });
    const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    expect(complaint).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "IDENTITY_VERIFICATION" } });
    expect((await outbound(world, C01)).some((message) => message.kind === "HANDOFF_NOTICE")).toBe(true);

    world.harness.script(() => [{ tool: "get_account" }]);
    await world.advance({ kind: "advance", minutes: 120 });
    await world.phone(C01, { type: "text", text: "Hola de nuevo" });
    const denied = world.harness.results.at(-1);
    expect(denied?.answer.kind === "RESULT" && !denied.answer.response.ok && denied.answer.response.error.code).toBe("NOT_IDENTIFIED");
    expect((await world.connector.caps.getChallenge("demo", C01))?.failures).toHaveLength(2);
    expect((await world.connector.caps.getChallenge("demo", C01))?.lockedAtReal).toBeDefined();
  });
});

describe("[FL-008] a question answered on the spot is not registered", () => {
  it("[FL-008] CONSULTA: the agent reads the loan and its instalments and replies with the amounts; no number, no register entry", async () => {
    const world = await createFlowWorld();
    world.harness.script((turn) =>
      repliesToChallenge(turn)
        ? [
            verifyWritten,
            { tool: "get_account" },
            { tool: "get_instalments", input: { loanId: "L-0008" } },
            { tool: "send_whatsapp", input: (earlier) => ({ kind: "REPLY", text: `Tu próxima cuota vence el ${String((outputOf(earlier[2]).instalments as { dueDateText?: string; status?: string }[]).find((row) => row.status !== "PAID")?.dueDateText ?? "")}.` }) },
          ]
        : [askChallenge],
    );
    await world.phone(C08, { type: "text", text: HOW_MUCH_LEFT });
    await answerChallenge(world, C08);
    expect(world.logs.some((line) => line.includes('"intake.classified"') && line.includes('"kind":"CONSULTA"'))).toBe(true);
    const sent = outputOf(world.harness.results.at(-1));
    expect(sent).toMatchObject({ decision: "ALLOWED" });
    const tape = await world.connector.chains.listTapeByMessage(String(sent.messageId));
    expect(tape.find((entry) => entry.decision === "ALLOWED")?.evaluated).toEqual(expect.arrayContaining([{ ruleId: "CH-WA-NO-COLLECTION", result: "PASS" }]));
    expect((await world.connector.complaints.listByCustomer("demo", C08)).filter((complaint) => complaint.origin === "LIVE")).toEqual([]);
    expect(await world.connector.counters.getComplaintCounter("demo", 1, 2026)).toBe(122);
    const results = await world.connector.sessions.listTurnResults("demo", turnIdOf(world.harness.turns[1]));
    expect(results.map((result) => result.tool)).toContain("get_instalments");
  });
});

describe("[FL-009] a question that needs work is registered with its number", () => {
  it("[FL-009] register_complaint CONSULTA INFORMATION_REQUEST gives a correlative number, FILED and three milestones; the message of origin is the turn's, by code", async () => {
    const world = await createFlowWorld();
    world.harness.script([[{ tool: "register_complaint", input: { kind: "CONSULTA", type: "INFORMATION_REQUEST", summary: "Pide el detalle de los pagos del año." } }]]);
    await world.phone(C08, { type: "text", text: PAYMENTS_DETAIL });
    const complaint = (await world.connector.complaints.listByCustomer("demo", C08)).find((candidate) => candidate.origin === "LIVE");
    expect(complaint).toMatchObject({ kind: "CONSULTA", type: "INFORMATION_REQUEST", complaintNumber: "R-2026-000123", sourceMessageId: await lastInboundId(world, C08) });
    expect((await world.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).map((entry) => entry.eventType)).toContain("FILED");
    expect((await world.connector.timers.listByOwner("demo", `CMP#${complaint?.complaintId}`)).filter((timer) => timer.status === "SCHEDULED")).toHaveLength(3);
  });
});

describe("[FL-012] the agent registers what the classifier left as a question", () => {
  it("[FL-012] investigating before registering is COMPLAINT_REQUIRED; register_complaint then gives the number and its fixed acknowledgement", async () => {
    const world = await createFlowWorld();
    let source = "";
    world.harness.script(async (turn) => {
      if (!repliesToChallenge(turn)) {
        source = await lastInboundId(world, C01);
        return [askChallenge];
      }
      return [
        verifyWritten,
        { tool: "get_disbursement" },
        { tool: "register_complaint", input: { kind: "RECLAMO", type: "DISBURSEMENT_NOT_RECEIVED", summary: "No le llegó el dinero del préstamo.", sourceMessageId: source } },
        { tool: "get_disbursement" },
      ];
    });
    await world.phone(C01, { type: "text", text: "Una consulta" });
    await answerChallenge(world, C01);
    const [, , early, registered, late] = world.harness.results;
    expect(early?.answer.kind === "RESULT" && !early.answer.response.ok && early.answer.response.error.code).toBe("COMPLAINT_REQUIRED");
    expect(outputOf(registered)).toMatchObject({ complaintNumber: "R-2026-000123" });
    expect(late?.answer.kind === "RESULT" && late.answer.response.ok).toBe(true);
    const acks = (await outbound(world, C01)).filter((message) => message.kind === "COMPLAINT_ACK");
    expect(acks).toHaveLength(1);
    expect(acks[0]?.sender).toBe("SYSTEM");
    expect((await world.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).map((entry) => entry.eventType)).toContain("FILED");
  });
});

describe("[FL-013] a repeated message about an open complaint", () => {
  it("[FL-013] the same type is recognized without the model: the acknowledgement repeats the existing number and nothing is added", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo estoy revisando.")] });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    const before = await world.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123");
    await world.phone(C01, { type: "text", text: "Hice el pago el lunes y no aparece acreditado" });
    expect(await world.connector.complaints.getByNumber("demo", "R-2026-000124")).toBeUndefined();
    expect(await world.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).toHaveLength(before.length);
    const acks = (await outbound(world, C01)).filter((message) => message.kind === "COMPLAINT_ACK");
    expect(acks).toHaveLength(2);
    expect(acks.every((ack) => ack.body.includes("R-2026-000123"))).toBe(true);
  });
});

describe("[FL-015] the customer withdraws the complaint", () => {
  it("[FL-015] identified: WITHDRAWN, the written confirmation and the milestones cancelled; not identified: NOT_IDENTIFIED and nothing changes", async () => {
    const world = await createFlowWorld();
    world.harness.script(() => [{ tool: "update_complaint", input: { withdrawn: true, outcome: "WITHDRAWN" } }, reply("Para cerrarlo necesito confirmar tu identidad.")]);
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    const refused = world.harness.results[0];
    expect(refused?.answer.kind === "RESULT" && !refused.answer.response.ok && refused.answer.response.error.code).toBe("NOT_IDENTIFIED");
    const kept = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    expect(kept?.status).toBe("REGISTERED");
    expect((await world.connector.timers.listByOwner("demo", `CMP#${kept?.complaintId}`)).filter((timer) => timer.status === "SCHEDULED")).toHaveLength(3);

    world.harness.script(() => [reply("Gracias, anotado el email.")]);
    await world.tap(C01, "ACCEPT_EMAIL");
    world.harness.script((turn) =>
      repliesToChallenge(turn)
        ? [
            verifyWritten,
            { tool: "update_complaint", input: { withdrawn: true, outcome: "WITHDRAWN" } },
            { tool: "answer_complaint_in_writing", input: { outcome: "WITHDRAWN", draftBody: "Registramos que desististe de tu reclamo y lo cerramos." } },
          ]
        : [askChallenge],
    );
    await world.phone(C01, { type: "text", text: "ya está, se acreditó, cerralo" });
    await answerChallenge(world, C01);
    const done = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    expect(done).toMatchObject({ status: "ANSWERED", outcome: "WITHDRAWN" });
    expect((await world.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).map((entry) => entry.eventType)).toEqual(expect.arrayContaining(["FILED", "WITHDRAWN"]));
    expect((await world.connector.timers.listByOwner("demo", `CMP#${done?.complaintId}`)).filter((timer) => timer.kind === "SLA").every((timer) => timer.status === "CANCELLED")).toBe(true);
  });
});
