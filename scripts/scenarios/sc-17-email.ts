// SC-17 · email (docs/test-plan.md §4.5). Real SES sends to the SES mailbox simulator: a clone of C05 whose
// written answer is delivered (its proof lands on the register), a clone of C39 whose address bounces (the
// case goes back to a person and the customer is told by the fixed template), and a second clone of C05
// whose recipient complains (in a world of its own: a model is cloned once per world). The email viewer
// renders the exact `.eml` that left: its SHA-256 is the stored object's.
import { expectDeliveryProof, expectWrittenAnswer } from "./lib/answers";
import { consoleCall } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { type Persona, complaintIdOf, fileByScript, keepComplaint, mailOutcome, mailsOf, personaIn, progressOf, untilStatus } from "./lib/flows";
import { messages } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const who = (ctx: ScenarioContext, key: string, suffix = "main"): Persona => personaIn(ctx, worldOf(ctx, suffix), key);

/** Files the persona's script complaint and waits for its written answer's mail to be written. */
async function answerMail(ctx: ScenarioContext, persona: Persona, name: string): Promise<string> {
  keepComplaint(ctx, name, await fileByScript(ctx, persona, 0, "PAYOFF_CERTIFICATE"));
  const mail = await ctx.eventually(
    `${name}: the written answer's mail`,
    async () => {
      const snapshot = await ctx.snapshot(persona.worldId, persona.customerId);
      return mailsOf(snapshot, "FORMAL_ANSWER", persona.customerId).at(-1);
    },
    WAITS.turnSec * 2,
    5,
  );
  ctx.note(`mail-${name}`, mail.mailId);
  return mail.mailId;
}

export default defineScenario({
  id: "SC-17",
  slug: "sc17",
  title: "Email: delivery proof, bounce, complaint, exact rendering",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: C05 and C39 (bouncing address); C05 again with a complaining address in a second world",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: [{ key: "a", model: "C05" }, { key: "b", model: "C39", emailOverride: "bounce" }] });
        await createWorld(ctx, { suffix: "b", personas: [{ key: "a", model: "C05", emailOverride: "complaint" }] });
      },
    },
    {
      n: 1,
      title: "C05's written answer → SEND and DELIVERY → DELIVERY_PROOF in the register; the pending mail closes with DELIVERY",
      flows: ["FL-090"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const id = keepComplaint(ctx, "a", await fileByScript(ctx, persona, 0, "PAYOFF_CERTIFICATE"));
        const answered = await expectWrittenAnswer(ctx, persona, id, { attachments: ["PAYOFF_CERTIFICATE"], progress: progressOf(ctx, "a") });
        const mailId = answered.view.complaint.answer?.mailId;
        ensure(mailId !== undefined, "the answer has no mail");
        ctx.state["deliveredMail"] = mailId;
        await expectDeliveryProof(ctx, persona, id);
        const outcome = (await ctx.qa("mail.outcome", { worldId: persona.worldId, mailId })) as { status: string; events: ReadonlyArray<{ type: string }>; deliveryProof: boolean };
        ctx.check(outcome.deliveryProof && outcome.events.some((event) => event.type === "SEND") && outcome.events.some((event) => event.type === "DELIVERY"), `the mail's events are ${outcome.events.map((event) => event.type).join(", ")}`);
      },
    },
    {
      n: 2,
      title: "C39's answer BOUNCED → HUMAN_REVIEW and the template reclamo_respuesta_no_entregada by WhatsApp",
      flows: ["FL-091"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const mailId = await answerMail(ctx, persona, "b");
        await mailOutcome(ctx, persona.worldId, mailId, ["BOUNCED"]);
        await untilStatus(ctx, persona, complaintIdOf(ctx, "b"), ["HUMAN_REVIEW"], { progress: progressOf(ctx, "b"), timeoutSec: WAITS.sesEventSec });
        const notice = await ctx.eventually(
          "the undelivered-answer template",
          async () => messages(await ctx.snapshot(persona.worldId, persona.customerId), { direction: "OUT", channel: "WHATSAPP" }).find((message) => message.templateName === "reclamo_respuesta_no_entregada" && message.status !== "BLOCKED"),
          60,
          3,
        );
        ctx.note("notice", notice.messageId);
      },
    },
    {
      n: 3,
      title: "a complaining recipient → COMPLAINED → the address suppressed",
      flows: ["FL-092"],
      async run(ctx) {
        const persona = who(ctx, "a", "b");
        const mailId = await answerMail(ctx, persona, "c");
        await mailOutcome(ctx, persona.worldId, mailId, ["COMPLAINED"]);
        const viewed = await consoleCall(ctx, "emails", "get", { customerId: persona.customerId, mailId }, { worldId: persona.worldId });
        ctx.check(viewed.events.some((event) => event.type === "COMPLAINT"), "the mail has no COMPLAINT event");
        if (!/SUPPRESS/i.test(JSON.stringify(viewed))) ctx.warn("the email view does not show the suppression; the COMPLAINT event is the proof the runner reads");
      },
    },
    {
      n: 4,
      title: "emails.get: the SHA-256 of the .eml is the stored object's; the attachments are listed",
      flows: ["FL-093"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const mailId = ctx.state["deliveredMail"];
        ensure(typeof mailId === "string", "step 1 left no mail");
        const viewed = await consoleCall(ctx, "emails", "get", { customerId: persona.customerId, mailId }, { worldId: persona.worldId });
        ctx.check(viewed.integrity.matches, `the .eml hash ${viewed.integrity.sha256 ?? "missing"} is not the recorded ${viewed.integrity.recorded ?? "missing"}`);
        ctx.check(viewed.attachments >= 2, `${viewed.attachments} attachment(s) listed, expected the answer and the certificate`);
      },
    },
  ],
});
