// SC-14 · the channel policy (docs/test-plan.md §4.5; demo-critical cut, docs/build-plan.md §3). Clones of
// C09 (an overdue instalment, no complaint), C01 (an open complaint) and C12 (a partial payment) on Wed 07/10
// 10:10. Every outbound message of any sender goes through the one gate: collection by WhatsApp is blocked
// for the operator too, with its two permitted paths (the formal notice by email the code renders, or a
// person); hours, the holiday, the daily maximum, the 24-hour window, credit offers, the recipient fence
// and the agent's own drafts are code. Everything is asserted on the tape and the persisted messages.
//
// The tape helpers are exported: SC-13 and SC-16 read the gate's decisions the same way.
import { type ConsoleInputs, type ConsoleOutputs, consoleCall } from "./lib/console";
import { type Persona, fileByScript, keepComplaint, complaintIdOf, mailOutcome, personaIn } from "./lib/flows";
import { scriptOf } from "./lib/personas";
import { SENT, type Snapshot, messages } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { advanceBy, advanceTo, createWorld, worldOf } from "./lib/world";

export type Tape = ConsoleOutputs["tape"]["list"]["entries"][number];
type Compose = Omit<ConsoleInputs["customers"]["compose"], "customerId" | "worldId">;

/** The sender every console call of the driver signs as an OPERATOR (`stf-qa-operator`). */
export const QA_OPERATOR = "OPERATOR:stf-qa-operator";

/** The tape of the world's current epoch (newest first, up to 500 entries). */
export async function tapeAll(ctx: ScenarioContext, worldId: string): Promise<Tape[]> {
  return (await consoleCall(ctx, "tape", "list", { limit: 500 }, { worldId, role: "COMPLIANCE" })).entries;
}

/** The gate's decision on a message (the first entry that is not its `DISPATCH`), once the worker ran it. */
export async function decisionOf(ctx: ScenarioContext, worldId: string, messageId: string): Promise<Tape> {
  return ctx.eventually(`the gate's decision on ${messageId}`, async () => (await tapeAll(ctx, worldId)).find((entry) => entry.messageId === messageId && entry.decision !== "DISPATCH"), 90, 3);
}

/** The `DISPATCH` of a message, once its transport answered. */
export async function dispatchOf(ctx: ScenarioContext, worldId: string, messageId: string): Promise<Tape> {
  return ctx.eventually(`the DISPATCH of ${messageId}`, async () => (await tapeAll(ctx, worldId)).find((entry) => entry.messageId === messageId && entry.decision === "DISPATCH"), 90, 3);
}

/** The operator's composer (`customers.compose`, OPERATOR): the message is queued and the gate decides in the worker. */
export async function compose(ctx: ScenarioContext, persona: Persona, message: Compose): Promise<Tape> {
  const queued = await consoleCall(ctx, "customers", "compose", { customerId: persona.customerId, ...message } as ConsoleInputs["customers"]["compose"], { worldId: persona.worldId });
  ctx.note(`message-${ctx.step}`, queued.messageId);
  return decisionOf(ctx, persona.worldId, queued.messageId);
}

/** A permitted path for a blocked entry: the `REROUTED` entry and, for the formal email, its child's decision. */
export async function reroute(ctx: ScenarioContext, persona: Persona, blocked: Tape, route: "FORMAL_EMAIL" | "HUMAN_QUEUE"): Promise<{ readonly rerouted: Tape; readonly child: Tape | undefined }> {
  await consoleCall(ctx, "conversation", "reroute", { tapeId: blocked.tapeId, route, customerId: persona.customerId }, { worldId: persona.worldId });
  return ctx.eventually(
    `${route} of ${blocked.tapeId}`,
    async () => {
      const all = await tapeAll(ctx, persona.worldId);
      const rerouted = all.find((entry) => entry.decision === "REROUTED" && entry.rerouteOf === blocked.tapeId);
      if (rerouted === undefined) return undefined;
      const childId = rerouted.reroute?.childTapeId;
      if (route === "HUMAN_QUEUE" || childId === undefined) return { rerouted, child: undefined };
      const child = all.find((entry) => entry.tapeId === childId);
      return child === undefined ? undefined : { rerouted, child };
    },
    90,
    3,
  );
}

export function expectRule(ctx: ScenarioContext, entry: Tape, decision: Tape["decision"], rule: string): void {
  ctx.check(entry.decision === decision && entry.ruleIds.includes(rule), `${entry.kind} ${entry.channel}: ${entry.decision} [${entry.ruleIds.join(", ")}], expected ${decision} ${rule}`);
  if (decision === "BLOCKED") ctx.blocked("CHANNEL_POLICY", `${entry.kind} ${entry.channel} ${rule}`);
}

const PERSONAS = [
  { key: "a", model: "C09" },
  { key: "b", model: "C01" },
  { key: "c", model: "C12" },
] as const;
const REMINDER: Compose = { kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Recordá que tenés una cuota vencida." };
const AT_1930 = "2026-10-07T19:30:00-03:00";
const NEXT_0900 = "2026-10-08T09:00:00-03:00";
const SATURDAY_1800 = "2026-10-10T18:00:00-03:00";
const TUESDAY_0800 = "2026-10-13T08:00:00-03:00";
const PHRASES = ["NETWORK_PENDING", "APPROVAL_PENDING", "HUMAN_REVIEWED", "SETTLEMENT_PUBLISHED"] as const;

const who = (ctx: ScenarioContext, key: string): Persona => personaIn(ctx, worldOf(ctx), key);

/** The `reclamo_novedad` template for C01's complaint with a status phrase (or a free one). */
function update(ctx: ScenarioContext, phrase: string): Compose {
  const number = ctx.state["number:b"];
  ensure(typeof number === "string", "step 5 filed no complaint for C01");
  return { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", template: { name: "reclamo_novedad", params: [scriptOf("C01").name.split(" ")[0] ?? "", number, phrase] }, complaintId: complaintIdOf(ctx, "b") };
}

export default defineScenario({
  id: "SC-14",
  slug: "sc14",
  title: "Channel policy: collection blocked for everyone, permitted paths, hours, window, caps and fences",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C09, C01 and C12, clock paused on Wed 07/10 10:10",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: PERSONAS });
      },
    },
    {
      n: 1,
      title: "the operator's \"Recordatorio de mora\" by WhatsApp to C09 → BLOCKED CH-WA-NO-COLLECTION; nothing leaves",
      flows: ["FL-064"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const left = (snapshot: Snapshot) => messages(snapshot, { direction: "OUT", channel: "WHATSAPP" }).filter((message) => message.status !== "BLOCKED");
        const before = left(await ctx.snapshot(persona.worldId, persona.customerId)).length;
        const blocked = await compose(ctx, persona, REMINDER);
        expectRule(ctx, blocked, "BLOCKED", "CH-WA-NO-COLLECTION");
        ctx.check(blocked.sender === QA_OPERATOR, `the block names ${blocked.sender}, expected ${QA_OPERATOR}`);
        ctx.state["blocked:a"] = blocked;
        const snapshot = await ctx.settled(persona.worldId, persona.customerId);
        ctx.exactly(snapshot, before, "WhatsApp messages that left for C09", left(snapshot));
      },
    },
    {
      n: 2,
      title: "reroute FORMAL_EMAIL → REROUTED, the notice ALLOWED and DISPATCH SENT with its COLLECTION_NOTICE PDF, DELIVERED; a second notice → BLOCKED CH-MAX-PER-DAY",
      flows: ["FL-065"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const { child } = await reroute(ctx, persona, ctx.state["blocked:a"] as Tape, "FORMAL_EMAIL");
        ensure(child?.messageId !== undefined, "the formal email has no decision of its own");
        ctx.check(child.decision === "ALLOWED", `the formal email was ${child.decision} [${child.ruleIds.join(", ")}]`);
        ctx.check(child.kind === "COLLECTION_NOTICE_EMAIL" && child.channel === "EMAIL", `the child is ${child.kind} by ${child.channel}`);
        const dispatch = await dispatchOf(ctx, persona.worldId, child.messageId);
        ctx.check(dispatch.result === "SENT", `the formal email's DISPATCH is ${dispatch.result ?? "unknown"}`);
        const mail = await ctx.eventually("the formal email in Emails", async () => (await ctx.snapshot(persona.worldId, persona.customerId)).emails.find((item) => item.kind === "COLLECTION_NOTICE_EMAIL"), 60, 3);
        const viewed = await consoleCall(ctx, "emails", "get", { mailId: mail.mailId, customerId: persona.customerId }, { worldId: persona.worldId });
        ctx.check(viewed.attachments >= 1, "the formal email carries no PDF");
        if (!JSON.stringify(viewed.view ?? {}).includes("COLLECTION_NOTICE")) ctx.warn("the email view does not name the COLLECTION_NOTICE document kind");
        await mailOutcome(ctx, persona.worldId, mail.mailId);
        const again = await compose(ctx, persona, REMINDER);
        const second = await reroute(ctx, persona, again, "FORMAL_EMAIL");
        ensure(second.child !== undefined, "the second formal email has no decision");
        expectRule(ctx, second.child, "BLOCKED", "CH-MAX-PER-DAY");
        ctx.state["blocked:a2"] = await compose(ctx, persona, REMINDER);
      },
    },
    {
      n: 3,
      title: "C12 at 19:30: the formal email is DEFERRED to Thu 08/10 09:00; the clock gets there → ALLOWED and sent",
      flows: ["FL-065", "FL-070"],
      async run(ctx) {
        const persona = who(ctx, "c");
        await advanceTo(ctx, persona.worldId, AT_1930);
        const blocked = await compose(ctx, persona, REMINDER);
        expectRule(ctx, blocked, "BLOCKED", "CH-WA-NO-COLLECTION");
        const { child } = await reroute(ctx, persona, blocked, "FORMAL_EMAIL");
        ensure(child?.messageId !== undefined, "the deferred notice has no decision");
        expectRule(ctx, child, "DEFERRED", "CH-CONTACT-HOURS");
        ctx.check(child.nextAllowedAt !== undefined && Date.parse(child.nextAllowedAt) === Date.parse(NEXT_0900), `deferred to ${child.nextAllowedAt}, expected Thu 08/10 09:00`);
        await advanceTo(ctx, persona.worldId, NEXT_0900);
        await ctx.eventually("the deferred notice ALLOWED at 09:00", async () => (await tapeAll(ctx, persona.worldId)).some((entry) => entry.messageId === child.messageId && entry.decision === "ALLOWED"), 90, 3);
        ctx.check((await dispatchOf(ctx, persona.worldId, child.messageId)).result === "SENT", "the deferred notice was not sent");
      },
    },
    {
      n: 4,
      title: "reroute HUMAN_QUEUE → REROUTED with a task for a person; nothing is sent",
      flows: ["FL-066"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        const { rerouted } = await reroute(ctx, persona, ctx.state["blocked:a2"] as Tape, "HUMAN_QUEUE");
        ctx.check(rerouted.reroute?.route === "HUMAN_QUEUE", `rerouted to ${rerouted.reroute?.route ?? "nothing"}`);
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.exactly(after, before.messages.length, "messages of C09 after a human-queue reroute", after.messages);
        ctx.exactly(after, before.emails.length, "mails of the world after a human-queue reroute", after.emails);
      },
    },
    {
      n: 5,
      title: "C01 files; the operator takes the conversation and writes collection free text → BLOCKED CH-WA-NO-COLLECTION",
      flows: ["FL-067"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const filed = await fileByScript(ctx, persona, 0, "PAYMENT_NOT_REFLECTED");
        keepComplaint(ctx, "b", filed);
        ctx.state["number:b"] = filed.complaint.complaintNumber;
        await ctx.settled(persona.worldId, persona.customerId);
        await consoleCall(ctx, "conversation", "take", { customerId: persona.customerId }, { worldId: persona.worldId });
        const sent = await consoleCall(ctx, "conversation", "send", { customerId: persona.customerId, text: "Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos" }, { worldId: persona.worldId });
        const blocked = await decisionOf(ctx, persona.worldId, sent.messageId);
        expectRule(ctx, blocked, "BLOCKED", "CH-WA-NO-COLLECTION");
        ctx.check((blocked.collectionCategories ?? []).length > 0, "the block carries no lexicon categories");
      },
    },
    {
      n: 6,
      title: "26 h later: free text → BLOCKED CH-WA-24H (template required); the template ALLOWED; a free {{3}} → BLOCKED",
      flows: ["FL-069"],
      async run(ctx) {
        const persona = who(ctx, "b");
        await advanceBy(ctx, persona.worldId, 26 * 60);
        const free = await compose(ctx, persona, { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", text: "Hay novedades en tu reclamo.", complaintId: complaintIdOf(ctx, "b") });
        expectRule(ctx, free, "BLOCKED", "CH-WA-24H");
        const template = await compose(ctx, persona, update(ctx, "NETWORK_PENDING"));
        ctx.check(template.decision === "ALLOWED", `the template was ${template.decision} [${template.ruleIds.join(", ")}]`);
        const freePhrase = await compose(ctx, persona, update(ctx, "te escribimos pronto"));
        ctx.check(freePhrase.decision === "BLOCKED", `a free {{3}} was ${freePhrase.decision}, expected BLOCKED (TEMPLATE_PARAM_NOT_ALLOWED)`);
      },
    },
    {
      n: 7,
      title: "a proactive update on Sat 10/10 18:00 → DEFERRED to Tue 13/10 08:00 (12/10 a holiday) → the clock gets there → SENT",
      flows: ["FL-070"],
      async run(ctx) {
        const persona = who(ctx, "b");
        await advanceTo(ctx, persona.worldId, SATURDAY_1800);
        const deferred = await compose(ctx, persona, update(ctx, "APPROVAL_PENDING"));
        expectRule(ctx, deferred, "DEFERRED", "CH-CONTACT-HOURS");
        ctx.check(deferred.nextAllowedAt !== undefined && Date.parse(deferred.nextAllowedAt) === Date.parse(TUESDAY_0800), `deferred to ${deferred.nextAllowedAt}, expected Tue 13/10 08:00`);
        await advanceTo(ctx, persona.worldId, TUESDAY_0800);
        ensure(deferred.messageId !== undefined, "the deferred update has no message id");
        ctx.check((await dispatchOf(ctx, persona.worldId, deferred.messageId)).result === "SENT", "the deferred update was not sent on Tuesday");
      },
    },
    {
      n: 8,
      title: "the fourth proactive contact of the day → DEFERRED CH-MAX-PER-DAY",
      flows: ["FL-071"],
      async run(ctx) {
        const persona = who(ctx, "b");
        // The update deferred to Tuesday 08:00 was the first contact of the day: two more pass, the fourth waits.
        const decided: Tape[] = [];
        for (const phrase of PHRASES.slice(1)) decided.push(await compose(ctx, persona, update(ctx, phrase)));
        ctx.check(decided.slice(0, 2).every((entry) => entry.decision === "ALLOWED"), `the second and third contacts were ${decided.map((entry) => entry.decision).join(", ")}`);
        const fourth = decided.at(-1);
        ensure(fourth !== undefined, "no fourth contact");
        expectRule(ctx, fourth, "DEFERRED", "CH-MAX-PER-DAY");
      },
    },
    {
      n: 9,
      title: "the operator offers a new loan → BLOCKED CH-NO-CREDIT-OFFER, no permitted path",
      flows: ["FL-072"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const offer = await compose(ctx, persona, { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", text: "¿Querés un préstamo nuevo con tasa preferencial?", complaintId: complaintIdOf(ctx, "b") });
        expectRule(ctx, offer, "BLOCKED", "CH-NO-CREDIT-OFFER");
      },
    },
    {
      n: 10,
      title: "fence.probe: deceptive, reserved, Cc-like and malformed addresses are denied without calling SES; the simulator is allowed",
      flows: ["FL-073"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const probe = async (address: string) => ((await ctx.qa("fence.probe", { kind: "RECIPIENT", worldId, channel: "EMAIL", address })) as { verdict: { allowed: boolean; reason?: string } }).verdict;
        const control = await probe(`success+qa-${ctx.runId}-sc14@simulator.amazonses.com`);
        ctx.check(control.allowed, `the SES mailbox simulator was denied (${control.reason ?? ""})`);
        const denied = ["success@simulator.amazonses.com.example.com", "SUCCESS@SIMULATOR.AMAZONSES.COM.", "\"success@simulator.amazonses.com\"@example.org", "a@b@simulator.amazonses.com", "success@simulator.amazonses.com\r\nBcc: x@example.net", "success@simulator.amazonses.com, cc@example.net", "cliente@xn--jarilla-xya.example", "cliente@example.com", "success+qa+@simulator.amazonses.com"];
        for (const address of denied) {
          const verdict = await probe(address);
          ctx.check(!verdict.allowed, `the fence allowed a deceptive address (case ${denied.indexOf(address) + 1})`);
          if (!verdict.allowed) ctx.blocked("LAMBDA_FENCE", verdict.reason ?? "DENIED");
        }
        ctx.warn("a demo recipient from a QA world is proved in U (outbound/recipient-fence.test.ts): its address is configuration the runner never reads");
      },
    },
    {
      n: 11,
      title: "gate.probe (AGENT): \"podés pagar el saldo al CVU 9990…\" → BLOCKED CH-WA-NO-PAYMENT-REQUEST, nothing transported",
      flows: ["FL-068"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const answer = (await ctx.qa("gate.probe", { worldId: persona.worldId, customerId: persona.customerId, kind: "REPLY", text: "Podés pagar el saldo al CVU 9990000001007919104729 hoy mismo." })) as { outcome: { ok: boolean; ruleIds: readonly string[] }; transported: unknown };
        ctx.check(!answer.outcome.ok && answer.outcome.ruleIds.includes("CH-WA-NO-PAYMENT-REQUEST"), `the agent's payment request was ${answer.outcome.ok ? "allowed" : `blocked by ${answer.outcome.ruleIds.join(", ")}`}`);
        ctx.check(Array.isArray(answer.transported) ? answer.transported.length === 0 : !answer.transported, "a blocked draft reached the transport");
        ctx.blocked("CHANNEL_POLICY", "CH-WA-NO-PAYMENT-REQUEST");
      },
    },
    {
      n: 12,
      title: "gate.probe with collection text and bypassLexicon → BLOCKED by G2 alone (POLICY_DENIED)",
      flows: ["FL-067"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const answer = (await ctx.qa("gate.probe", { worldId: persona.worldId, customerId: persona.customerId, kind: "REPLY", text: "Tu cuota está vencida: pagala hoy o vamos a iniciar acciones.", bypassLexicon: true })) as { layer: string; verdict: { action: string; failure?: string } };
        ctx.check(answer.layer === "G2" && answer.verdict.action === "BLOCKED", `G2 alone answered ${answer.verdict.action} ${answer.verdict.failure ?? ""}`);
        ctx.blocked("G2", answer.verdict.failure ?? "BLOCKED");
        const snapshot = await ctx.settled(persona.worldId, persona.customerId);
        ctx.none(snapshot, "collection reminders that left by WhatsApp", messages(snapshot, { direction: "OUT", kind: "COLLECTION_REMINDER", status: SENT }));
      },
    },
  ],
});
