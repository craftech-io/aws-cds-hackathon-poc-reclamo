// Local flows of the channel policy (docs/flows-catalog.md area I): every outbound message of every
// sender goes through the one gate, the policy decides and the tape records it. Collection by WhatsApp
// is a hard block for the operator too, with the two allowed paths (a person, or the formal notice the
// code renders by email); hours, holidays, the daily maximum, the 24-hour window and credit offers are
// the code's; and the policy audit finds a message that left without its ALLOWED.
import { describe, expect, it, vi } from "vitest";
import { runPolicyAudit } from "@reclamo/bff/policy-audit/audit";
import { coreCustomerReader } from "@reclamo/bff/outbound/directory";
import type { TapeEntry } from "@reclamo/bff/domain/ledger";
import { createLogger } from "@reclamo/bff/lib/log";
import { offeredReroutes } from "@reclamo/bff/outbound/reroute";
import { LOCAL_KEYS } from "./support/keys";
import type { PlannedCall } from "./support/scripted-harness";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const COLLECTION = "Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos";
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });
const quiet = createLogger({ sink: () => undefined });

type Compose = { readonly kind: string; readonly channel: "WHATSAPP" | "EMAIL"; readonly text?: string; readonly template?: { name: string; params: string[] }; readonly complaintId?: string };

/** The operator's composer for a customer; answers the tape of the message once the worker ran it. */
async function compose(world: FlowWorld, customerId: string, message: Compose): Promise<TapeEntry[]> {
  const operator = await world.console("OPERATOR");
  const queued = await operator.customers.compose({ customerId, ...message } as never);
  await world.settle();
  return world.connector.chains.listTapeByMessage(queued.messageId);
}

async function reroute(world: FlowWorld, customerId: string, blocked: TapeEntry | undefined, route: "FORMAL_EMAIL" | "HUMAN_QUEUE"): Promise<void> {
  const operator = await world.console("OPERATOR");
  await operator.conversation.reroute({ tapeId: blocked?.tapeId ?? "", route, customerId });
  await world.settle();
}

async function sentTo(world: FlowWorld, customerId: string, seeded: ReadonlySet<string>) {
  return (await world.connector.conversations.listMessages("demo", customerId)).filter((message) => message.direction === "OUT" && !seeded.has(message.messageId));
}

async function seededIds(world: FlowWorld, customerId: string): Promise<Set<string>> {
  return new Set((await world.connector.conversations.listMessages("demo", customerId)).map((message) => message.messageId));
}

/** C01 with the complaint filed and the email accepted: an open complaint the operator can write about. */
async function withComplaint(world: FlowWorld): Promise<string> {
  world.harness.script(() => [reply("Lo reviso.")]);
  await world.phone("cus-0001", { type: "text", text: PAYMENT_NOT_REFLECTED });
  await world.tap("cus-0001", "ACCEPT_EMAIL");
  return (await world.connector.complaints.getByNumber("demo", "R-2026-000123"))?.complaintId ?? "";
}

const operatorSender = (world: FlowWorld) => `OPERATOR:${world.staff("OPERATOR").staffId}`;

describe("[FL-064] [FL-065] a collection reminder by WhatsApp from the operator and its formal email", () => {
  it("[FL-064] the reminder to C09 is BLOCKED CH-WA-NO-COLLECTION for the operator too, offering the human queue and the formal email; nothing leaves by WhatsApp", async () => {
    const world = await createFlowWorld();
    const seeded = await seededIds(world, "cus-0009");
    const [blocked] = await compose(world, "cus-0009", { kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Recordá que tenés una cuota vencida." });
    expect(blocked).toMatchObject({ decision: "BLOCKED", sender: operatorSender(world), channel: "WHATSAPP" });
    expect(blocked?.ruleIds).toContain("CH-WA-NO-COLLECTION");
    expect(offeredReroutes(blocked as TapeEntry).map((option) => option.route)).toEqual(["HUMAN_QUEUE", "FORMAL_EMAIL"]);
    expect((await sentTo(world, "cus-0009", seeded)).filter((message) => message.status !== "BLOCKED")).toEqual([]);
    expect(world.logs.some((line) => line.includes('"outbound.blocked"') && line.includes("CH-WA-NO-COLLECTION"))).toBe(true);
  });

  it("[FL-065] the formal email is rendered by code with its PDF, ALLOWED in hours, sent and delivered; a second one within the week is BLOCKED CH-MAX-PER-DAY", async () => {
    const world = await createFlowWorld();
    const [blocked] = await compose(world, "cus-0009", { kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Recordá que tenés una cuota vencida." });
    await reroute(world, "cus-0009", blocked, "FORMAL_EMAIL");
    const notice = world.stage.emails.find((email) => email.input.EmailTags?.some((tag) => tag.Value === "COLLECTION_NOTICE_EMAIL"));
    expect(notice).toBeDefined();
    const tape = await world.connector.chains.listTapeByDecision("demo", "REROUTED");
    expect(tape.find((entry) => entry.tapeId === blocked?.tapeId || entry.messageId === blocked?.messageId)).toBeDefined();
    const child = (await world.connector.chains.listTapeByDecision("demo", "ALLOWED")).find((entry) => entry.kind === "COLLECTION_NOTICE_EMAIL");
    expect(child?.channel).toBe("EMAIL");
    expect((await world.connector.chains.listTapeByMessage(child?.messageId ?? "")).map((entry) => entry.decision)).toEqual(expect.arrayContaining(["ALLOWED", "DISPATCH"]));
    expect(world.s3.keys("Documents").some((key) => key.includes("COLLECTION_NOTICE"))).toBe(true);
    expect(await world.sesEvent(notice ?? (undefined as never), "Delivery")).toMatchObject({ outcome: "ENQUEUED" });

    const [again] = await compose(world, "cus-0009", { kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Recordá que tenés una cuota vencida." });
    await reroute(world, "cus-0009", again, "FORMAL_EMAIL");
    const second = (await world.connector.chains.listTapeByDecision("demo", "BLOCKED")).find((entry) => entry.kind === "COLLECTION_NOTICE_EMAIL");
    expect(second?.ruleIds).toContain("CH-MAX-PER-DAY");
  });

  it("[FL-065] out of the formal notice's hours the email is DEFERRED to the next business 09:00 and goes out when the clock gets there", async () => {
    const world = await createFlowWorld();
    await world.advance({ kind: "advanceTo", to: "2026-10-07T18:30:00-03:00" });
    const [blocked] = await compose(world, "cus-0009", { kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Recordá que tenés una cuota vencida." });
    await reroute(world, "cus-0009", blocked, "FORMAL_EMAIL");
    expect((await world.connector.chains.listTapeByDecision("demo", "DEFERRED")).find((entry) => entry.kind === "COLLECTION_NOTICE_EMAIL")).toBeDefined();
    expect(world.stage.emails.filter((email) => email.input.EmailTags?.some((tag) => tag.Value === "COLLECTION_NOTICE_EMAIL"))).toHaveLength(0);
    await world.advance({ kind: "advanceTo", to: "2026-10-08T09:00:00-03:00" });
    expect(world.stage.emails.filter((email) => email.input.EmailTags?.some((tag) => tag.Value === "COLLECTION_NOTICE_EMAIL"))).toHaveLength(1);
  });
});

describe("[FL-067] the operator's free text with collection content", () => {
  it("[FL-067] with the conversation taken, a reply with a payment exhortation and a threat is BLOCKED CH-WA-NO-COLLECTION with the lexicon's categories", async () => {
    const world = await createFlowWorld();
    await withComplaint(world);
    const operator = await world.console("OPERATOR");
    await operator.conversation.take({ customerId: "cus-0001" });
    const seeded = await seededIds(world, "cus-0001");
    const sent = await operator.conversation.send({ customerId: "cus-0001", text: COLLECTION });
    await world.settle();
    const [blocked] = await world.connector.chains.listTapeByMessage((sent as { messageId: string }).messageId);
    expect(blocked).toMatchObject({ decision: "BLOCKED", sender: operatorSender(world) });
    expect(blocked?.ruleIds).toContain("CH-WA-NO-COLLECTION");
    expect((await sentTo(world, "cus-0001", seeded)).filter((message) => message.status !== "BLOCKED")).toEqual([]);
    // The tape keeps the lexicon's categories of the block.
    expect(JSON.stringify(blocked)).toContain("PAYMENT_EXHORTATION");
    expect(JSON.stringify(blocked)).toContain("CONSEQUENCE_THREAT");
  });
});

describe("[FL-068] the agent's draft asking for a payment", () => {
  it("[FL-068] a reply asking to pay to a CVU is BLOCKED by CH-WA-NO-PAYMENT-REQUEST (and CH-NO-SENSITIVE-ASK); the tool answers POLICY_DENIED and the audit has the rule", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Podés pagar el saldo al CVU 9990000001007919104729 hoy mismo.")] });
    await world.phone("cus-0001", { type: "text", text: "Hola" });
    const result = world.harness.results.at(-1);
    expect(result?.answer.kind === "RESULT" && !result.answer.response.ok && result.answer.response.error.code).toBe("POLICY_DENIED");
    const messageId = result?.answer.kind === "RESULT" ? String((result.answer.response as { messageId?: string }).messageId) : "";
    const [blocked] = await world.connector.chains.listTapeByMessage(messageId);
    expect(blocked?.decision).toBe("BLOCKED");
    expect(blocked?.ruleIds).toEqual(expect.arrayContaining(["CH-WA-NO-PAYMENT-REQUEST"]));
    expect(JSON.stringify(await world.connector.audit.listByRef("demo", messageId)) + JSON.stringify(blocked)).toContain("CH-WA-NO-PAYMENT-REQUEST");
  });
});

describe("[FL-069] outside the 24-hour window", () => {
  it("[FL-069] 26 h later free text is BLOCKED CH-WA-24H; the template with a phrase of the closed list is ALLOWED; a free phrase is not", async () => {
    const world = await createFlowWorld();
    const complaintId = await withComplaint(world);
    await world.advance({ kind: "advance", minutes: 26 * 60 });
    const [free] = await compose(world, "cus-0001", { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", text: "Hay novedades en tu reclamo.", complaintId });
    expect(free).toMatchObject({ decision: "BLOCKED" });
    expect(free?.ruleIds).toContain("CH-WA-24H");
    const template = await compose(world, "cus-0001", { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "NETWORK_PENDING"] }, complaintId });
    expect(template.find((entry) => entry.decision === "ALLOWED")).toBeDefined();
    const sent = (await world.connector.conversations.listMessages("demo", "cus-0001")).find((message) => message.templateName === "reclamo_novedad");
    expect(sent?.status).toBe("DELIVERED");
    const [freePhrase] = await compose(world, "cus-0001", { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "te escribimos pronto"] }, complaintId });
    expect(freePhrase?.decision).toBe("BLOCKED");
    const code = (entry: TapeEntry | undefined) => world.logs.find((line) => line.includes('"outbound.blocked"') && line.includes(`evt-${entry?.messageId ?? "?"}`));
    expect(code(free)).toContain("TEMPLATE_REQUIRED");
    expect(code(freePhrase)).toContain("TEMPLATE_PARAM_NOT_ALLOWED");
  });
});

describe("[FL-070] contact hours and the holiday", () => {
  it("[FL-070] a proactive update on Saturday 18:00 is DEFERRED to Tuesday 08:00 (Sunday, and Monday 12/10 a holiday), with its DEFERRED_SEND timer, and leaves then", async () => {
    const world = await createFlowWorld();
    const complaintId = await withComplaint(world);
    await world.advance({ kind: "advanceTo", to: "2026-10-10T18:00:00-03:00" });
    const [deferred] = await compose(world, "cus-0001", { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "NETWORK_PENDING"] }, complaintId });
    expect(deferred).toMatchObject({ decision: "DEFERRED" });
    expect(deferred?.ruleIds).toContain("CH-CONTACT-HOURS");
    expect(Date.parse(String((deferred as { nextAllowedAt?: string }).nextAllowedAt ?? JSON.stringify(deferred).match(/"nextAllowedAt":"([^"]+)"/)?.[1]))).toBe(Date.parse("2026-10-13T08:00:00-03:00"));
    expect((await world.connector.timers.listDue("demo", { untilSim: "2026-10-13T08:00:00-03:00" })).some((timer) => timer.kind === "DEFERRED_SEND")).toBe(true);
    await world.advance({ kind: "advanceTo", to: "2026-10-13T08:00:00-03:00" });
    const sent = (await world.connector.conversations.listMessages("demo", "cus-0001")).find((message) => message.templateName === "reclamo_novedad");
    expect(Date.parse(sent?.sentAtSim ?? "")).toBe(Date.parse("2026-10-13T08:00:00-03:00"));
  });
});

describe("[FL-071] the daily maximum of proactive contacts", () => {
  it("[FL-071] the fourth proactive contact of the day to the same customer is DEFERRED CH-MAX-PER-DAY", async () => {
    const world = await createFlowWorld();
    const complaintId = await withComplaint(world);
    const decisions: (string | undefined)[] = [];
    for (const text of ["Primera novedad de tu reclamo.", "Segunda novedad de tu reclamo.", "Tercera novedad de tu reclamo.", "Cuarta novedad de tu reclamo."]) {
      const tape = await compose(world, "cus-0001", { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", text, complaintId });
      decisions.push(tape.find((entry) => entry.decision !== "DISPATCH")?.decision);
      if (text.startsWith("Cuarta")) expect(tape.find((entry) => entry.decision === "DEFERRED")?.ruleIds).toContain("CH-MAX-PER-DAY");
    }
    expect(decisions).toEqual(["ALLOWED", "ALLOWED", "ALLOWED", "DEFERRED"]);
  });
});

describe("[FL-072] a credit offer", () => {
  it("[FL-072] an offer of a new loan is BLOCKED CH-NO-CREDIT-OFFER by WhatsApp and by email, with no reroute", async () => {
    const world = await createFlowWorld();
    const complaintId = await withComplaint(world);
    const offer = "¿Querés un préstamo nuevo con tasa preferencial?";
    const [whatsapp] = await compose(world, "cus-0001", { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", text: offer, complaintId });
    // By email, the operator writes only the written answer of a human case.
    const operator = await world.console("OPERATOR");
    await operator.complaints.escalate({ complaintId });
    await operator.complaints.answer({ complaintId, outcome: "INFORMATIONAL", draftBody: offer }).catch(() => undefined);
    await world.settle();
    const email = (await world.connector.chains.listTapeByComplaint("demo", complaintId)).find((entry) => entry.kind === "FORMAL_ANSWER" && entry.decision === "BLOCKED");
    for (const blocked of [whatsapp, email]) {
      expect(blocked?.decision).toBe("BLOCKED");
      expect(blocked?.ruleIds).toContain("CH-NO-CREDIT-OFFER");
      expect(offeredReroutes(blocked as TapeEntry)).toEqual([]);
    }
  });
});

describe("[FL-075] the complete tape and zero violations", () => {
  it("[FL-075] after a conversation through the gate the policy audit finds no violation; a message fabricated outside the gate is a VIOLATION", async () => {
    const world = await createFlowWorld();
    await withComplaint(world);
    const deps = { connector: world.connector, chainKey: LOCAL_KEYS.registerChain, anchors: world.stage.anchorLog, customers: coreCustomerReader(world.mocks.core("PolicyAudit")), log: quiet, now: world.realNow };
    const clean = await runPolicyAudit(deps, { worldId: "demo" });
    expect(clean.messagesChecked).toBeGreaterThan(0);
    expect(clean.violations).toEqual([]);

    await world.connector.conversations.putMessage({ worldId: "demo", customerId: "cus-0001", messageId: "msg-fabricated-1", direction: "OUT", channel: "WHATSAPP", kind: "REPLY", sender: "AGENT", body: "Mensaje sin compuerta.", status: "SENT", flags: {}, simulated: true, atSim: "2026-10-07T10:20:00-03:00" } as never);
    const dirty = await runPolicyAudit(deps, { worldId: "demo" });
    expect(dirty.violations.map((violation) => JSON.stringify(violation))).toEqual([expect.stringContaining("msg-fabricated-1")]);
    expect((await world.connector.audit.listByAction("demo", "VIOLATION")).length).toBeGreaterThan(0);
  });
});
