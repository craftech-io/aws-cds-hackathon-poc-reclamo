// SC-11 · identification and the register (docs/test-plan.md §4.5). Clones of C08 (enquiries), C10 (two
// loans), C02 (two wrong answers to the challenge), C01 (greeting, a repeated message, a withdrawal) and a
// second C01 (an unclear message, in a world of its own: a model is cloned once per world), plus the
// simulator's unlinked number. Identity is checked by code before any data is shown; what is a
// complaint, its number and its register entries are code too.
import { caseOf, consoleCall, itemsOf, timelineOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { type Persona, complaintIdOf, fileByScript, keepComplaint, personaIn, progressOf, say, sayScript, sentKind, until, untilStatus } from "./lib/flows";
import { complaintsOf, latestComplaint } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const PERSONAS = [
  { key: "a", model: "C08" },
  { key: "b", model: "C10" },
  { key: "c", model: "C02" },
  { key: "d", model: "C01" },
] as const;

const who = (ctx: ScenarioContext, key: string): Persona => personaIn(ctx, worldOf(ctx, key === "e" ? "e" : "main"), key);

const replied = (count: number) => (snapshot: { messages: ReadonlyArray<{ direction: string; status: string }> }) => snapshot.messages.filter((message) => message.direction === "OUT" && message.status !== "BLOCKED").length > count;

export default defineScenario({
  id: "SC-11",
  slug: "sc11",
  title: "Identification and the register",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C08, C10, C02 and C01; a second C01 (sc11-e)",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: PERSONAS });
        await createWorld(ctx, { suffix: "e", personas: [{ key: "e", model: "C01" }] });
      },
    },
    {
      n: 1,
      title: "\"hola\": the first outbound message of the epoch carries the automation disclosure, and only that one",
      flows: ["FL-001"],
      async run(ctx) {
        const persona = who(ctx, "d");
        await say(ctx, persona, { type: "text", text: "hola" });
        const greeted = await until(ctx, persona, "an answer to the greeting", replied(0));
        const conversation = greeted.conversation;
        ensure(conversation !== null, "no conversation after the greeting");
        ctx.check(conversation.disclosedEpochs.includes(conversation.sessionEpoch), "the session epoch is not marked as disclosed");
        const id = keepComplaint(ctx, "d", await fileByScript(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
        const timeline = await ctx.quietRead(persona.worldId, () => timelineOf(ctx, persona.worldId, id), persona.customerId);
        const outbound = itemsOf(timeline, "MESSAGE").filter((item) => item.direction === "OUT");
        const disclosed = ctx.exactly(timeline, 1, "outbound messages with the disclosure in the epoch", outbound.filter((item) => item.disclosure));
        ctx.check(disclosed[0]?.messageId === outbound[0]?.messageId, "the disclosure is not on the first outbound message");
        const thread = await ctx.snapshot(persona.worldId, persona.customerId);
        const first = thread.messages.find((message) => message.direction === "OUT" && message.disclosure);
        ctx.check(first?.buttons.some((button) => button.action === "TALK_TO_HUMAN") === true, "the first outbound message offers no TALK_TO_HUMAN button");
        ctx.exactly(thread, 1, "outbound messages of the thread with the disclosure", thread.messages.filter((message) => message.direction === "OUT" && message.disclosure));
      },
    },
    {
      n: 2,
      title: "a phone without a customer → the fixed answer, no turn, no complaint",
      flows: ["FL-002"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const before = await ctx.settled(worldId);
        const answer = await consoleCall(ctx, "simulator", "sendText", { persona: "UNLINKED", text: "Hola, quiero hacer un reclamo por un pago" }, { worldId, role: "OPERATOR" });
        ctx.note("unlinked", JSON.stringify(answer).slice(0, 120));
        const after = await ctx.settled(worldId);
        ctx.check(after.turnsToday === before.turnsToday, `the unknown sender spent ${after.turnsToday - before.turnsToday} turn(s)`);
        ctx.exactly(after, before.complaints.length, "open complaints of the world", after.complaints);
      },
    },
    {
      n: 3,
      title: "C02: two wrong answers → HUMAN_REVIEW IDENTITY_VERIFICATION, the challenge locked",
      flows: ["FL-004"],
      async run(ctx) {
        const persona = who(ctx, "c");
        const id = keepComplaint(ctx, "c", await fileByScript(ctx, persona, 0, "UNRECOGNIZED_CHARGE"));
        await untilStatus(ctx, persona, id, ["HUMAN_REVIEW"], { plan: { challenge: "WRONG" }, progress: progressOf(ctx, "c"), timeoutSec: WAITS.turnSec * 3 });
        const view = await caseOf(ctx, persona.worldId, id);
        ctx.check(view.complaint.handoff?.reason === "IDENTITY_VERIFICATION", `handoff ${view.complaint.handoff?.reason ?? "none"}, expected IDENTITY_VERIFICATION`);
        ctx.check(progressOf(ctx, "c").answered.size >= 2, `the autopilot answered ${progressOf(ctx, "c").answered.size} challenge(s), expected two wrong ones`);
        const timeline = await timelineOf(ctx, persona.worldId, id);
        ctx.check(itemsOf(timeline, "ACTION").some((item) => item.action === "CHALLENGE_LOCKED"), "no CHALLENGE_LOCKED on the case");
        const snapshot = await ctx.snapshot(persona.worldId, persona.customerId);
        ctx.check((snapshot.conversation as { identifiedUntilReal?: string } | null)?.identifiedUntilReal === undefined, "the customer is identified after two failures");
      },
    },
    {
      n: 4,
      title: "C10: two loans → the list to choose from, tapped with its nonce",
      flows: ["FL-005"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = keepComplaint(ctx, "b", await fileByScript(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
        const progress = progressOf(ctx, "b");
        await until(ctx, persona, "a loan chosen from the list", () => progress.tapped.has("CHOOSE_LOAN"), { plan: { buttons: ["CHOOSE_LOAN"] }, progress, timeoutSec: WAITS.turnSec * 2 });
        await ctx.eventually("the complaint names the chosen loan", async () => (await caseOf(ctx, persona.worldId, id)).complaint.subject?.loanId !== undefined, WAITS.turnSec, 5);
      },
    },
    {
      n: 5,
      title: "C08: an enquiry answered on the spot (instalments and date), nothing registered",
      flows: ["FL-008"],
      async run(ctx) {
        const persona = who(ctx, "a");
        await sayScript(ctx, persona, 0);
        await until(ctx, persona, "a REPLY to the enquiry", (snapshot) => sentKind(snapshot, "REPLY").length > 0, { progress: progressOf(ctx, "a"), timeoutSec: WAITS.turnSec * 2 });
        const snapshot = await ctx.settled(persona.worldId, persona.customerId);
        ctx.none(snapshot, "complaints registered for a plain enquiry", complaintsOf(snapshot));
      },
    },
    {
      n: 6,
      title: "C08: an enquiry that needs work → kind CONSULTA, INFORMATION_REQUEST, with its number",
      flows: ["FL-009"],
      async run(ctx) {
        const persona = who(ctx, "a");
        await sayScript(ctx, persona, 1);
        const snapshot = await until(ctx, persona, "an INFORMATION_REQUEST registered", (fresh) => latestComplaint(fresh, "INFORMATION_REQUEST") !== undefined, { progress: progressOf(ctx, "a"), timeoutSec: WAITS.turnSec * 2 });
        const view = latestComplaint(snapshot, "INFORMATION_REQUEST");
        ensure(view !== undefined, "no INFORMATION_REQUEST");
        ctx.check(view.complaint.kind === "CONSULTA" && /^R-\d{4}-\d{6}$/.test(view.complaint.complaintNumber), `${view.complaint.kind} ${view.complaint.complaintNumber}, expected CONSULTA with its number`);
      },
    },
    {
      n: 7,
      title: "an UNCLEAR message: the agent registers it before investigating",
      flows: ["FL-012"],
      async run(ctx) {
        const persona = who(ctx, "e");
        await say(ctx, persona, { type: "text", text: "Tengo un problema con la plata de la cuenta, no entiendo qué pasó" });
        const snapshot = await until(ctx, persona, "a complaint registered by the agent", (fresh) => complaintsOf(fresh).length > 0, { progress: progressOf(ctx, "e"), timeoutSec: WAITS.turnSec * 2 });
        const view = complaintsOf(snapshot)[0];
        ensure(view !== undefined, "no complaint");
        // An unclear message gets no number by rule: the filing is the agent's own register_complaint.
        const filing = view.complaint.statusHistory[0];
        ctx.check(filing?.from === null && filing.actor === "AGENT", `the complaint was filed by ${filing?.actor ?? "nobody"}, expected the agent's register_complaint`);
      },
    },
    {
      n: 8,
      title: "the same message again → the same number (rule), no second complaint",
      flows: ["FL-013"],
      async run(ctx) {
        const persona = who(ctx, "d");
        const id = complaintIdOf(ctx, "d");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        const acks = sentKind(before, "COMPLAINT_ACK").length;
        await sayScript(ctx, persona, 0);
        await ctx.eventually("the acknowledgement again", async () => sentKind(await ctx.snapshot(persona.worldId, persona.customerId), "COMPLAINT_ACK").length > acks, WAITS.ackSec + 5, 1);
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.exactly(after, before.complaints.length, "complaints of the customer", after.complaints);
        ctx.check(latestComplaint(after)?.complaint.complaintId === id, "the repeated message got another complaint");
      },
    },
    {
      n: 9,
      title: "the customer withdraws → WITHDRAWN → ANSWERED",
      flows: ["FL-015"],
      async run(ctx) {
        const persona = who(ctx, "d");
        const id = complaintIdOf(ctx, "d");
        await say(ctx, persona, { type: "text", text: "Quiero desistir del reclamo, ya no hace falta" });
        await untilStatus(ctx, persona, id, ["ANSWERED", "CLOSED"], { plan: { buttons: ["WITHDRAW"] }, progress: progressOf(ctx, "d"), timeoutSec: WAITS.turnSec * 2 });
        const view = await caseOf(ctx, persona.worldId, id);
        ctx.check(view.complaint.outcome === "WITHDRAWN", `outcome ${view.complaint.outcome}, expected WITHDRAWN`);
        const timeline = await timelineOf(ctx, persona.worldId, id);
        ctx.check(itemsOf(timeline, "REGISTER").some((entry) => entry.eventType === "WITHDRAWN"), "no WITHDRAWN entry in the register");
      },
    },
  ],
});
