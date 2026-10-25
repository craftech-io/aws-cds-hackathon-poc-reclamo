// SC-04 · payoff certificate (docs/test-plan.md §4.5). A clone of C05 (loan cancelled on 15/09) gets the
// certificate attached to the written answer and delivered; a clone of C21 (three instalments still due)
// gets an INFORMATIONAL answer without a certificate and without a single word of collection. Which
// attachments go out is decided by the code from the loan's state, never by the model.
import { expectWrittenAnswer } from "./lib/answers";
import { caseOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { fileByScript, keepComplaint, noCollectionOnWhatsApp, personaIn, progressOf, untilStatus } from "./lib/flows";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx), key);

export default defineScenario({
  id: "SC-04",
  slug: "sc04",
  title: "Payoff certificate: cancelled loan, and a loan with a balance left",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C05 and C21",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: [{ key: "a", model: "C05" }, { key: "b", model: "C21" }] });
      },
    },
    {
      n: 1,
      title: "C05: PAYOFF_CERTIFICATE attached to the written answer, DELIVERED",
      flows: ["FL-030"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const id = keepComplaint(ctx, "a", await fileByScript(ctx, persona, 0, "PAYOFF_CERTIFICATE"));
        await untilStatus(ctx, persona, id, ["RESOLVED", "ANSWERED", "CLOSED"], { progress: progressOf(ctx, "a"), timeoutSec: WAITS.turnSec * 2 });
        await expectWrittenAnswer(ctx, persona, id, { attachments: ["PAYOFF_CERTIFICATE"], progress: progressOf(ctx, "a") });
      },
    },
    {
      n: 2,
      title: "C21: INFORMATIONAL, no payoff certificate with a balance left, no collection language",
      flows: ["FL-031"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = keepComplaint(ctx, "b", await fileByScript(ctx, persona, 0, "PAYOFF_CERTIFICATE"));
        await expectWrittenAnswer(ctx, persona, id, { without: ["PAYOFF_CERTIFICATE"], progress: progressOf(ctx, "b") });
        const view = await caseOf(ctx, persona.worldId, id);
        ctx.check(view.complaint.outcome === "INFORMATIONAL", `outcome ${view.complaint.outcome}, expected INFORMATIONAL`);
        noCollectionOnWhatsApp(ctx, await ctx.settled(persona.worldId, persona.customerId));
      },
    },
  ],
});
