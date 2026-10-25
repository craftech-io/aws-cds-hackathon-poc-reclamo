// SC-09 · fraud and blocked accounts (docs/test-plan.md §4.5). A clone of C06 does not recognise a
// $ 180.000 transfer of 07/10 06:12: outgoing operations are frozen, the customer gets the safety
// guidance, a supervisor is alerted and a person takes the case with HIGH priority; asking to unblock it
// changes nothing. A clone of C35 cannot sign in: the category of the block is explained and a person
// takes it. No tool can lift a freeze; the code decides it, never the model.
import { caseOf, itemsOf, timelineOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { complaintIdOf, fileByScript, keepComplaint, personaIn, progressOf, sayScript, sentKind, untilStatus } from "./lib/flows";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx), key);

const freezes = (view: Awaited<ReturnType<typeof caseOf>>) => view.actions.filter((action) => action.kind === "FREEZE_OUTGOING" && action.status === "EXECUTED");

export default defineScenario({
  id: "SC-09",
  slug: "sc09",
  title: "Fraud and blocked accounts",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C06 and C35",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: [{ key: "a", model: "C06" }, { key: "b", model: "C35" }] });
      },
    },
    {
      n: 1,
      title: "C06: an unknown transfer → outgoing frozen, SAFETY_GUIDANCE, HUMAN_REVIEW HIGH, SUPERVISOR_ALERT",
      flows: ["FL-049"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const id = keepComplaint(ctx, "a", await fileByScript(ctx, persona, 0, "UNKNOWN_OPERATION"));
        await untilStatus(ctx, persona, id, ["HUMAN_REVIEW"], { progress: progressOf(ctx, "a"), timeoutSec: WAITS.turnSec * 2 });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.exactly(view, 1, "freezes of outgoing operations", freezes(view));
        ctx.check(view.complaint.priority === "HIGH" && view.complaint.handoff?.reason === "FRAUD", `priority ${view.complaint.priority}, handoff ${view.complaint.handoff?.reason ?? "none"}, expected HIGH FRAUD`);
        ctx.check(sentKind(await ctx.snapshot(persona.worldId, persona.customerId), "SAFETY_GUIDANCE").length >= 1, "no SAFETY_GUIDANCE went out");
        const timeline = await timelineOf(ctx, persona.worldId, id);
        ctx.check(itemsOf(timeline, "TAPE").some((entry) => entry.kind === "SUPERVISOR_ALERT" && entry.decision === "ALLOWED"), "no SUPERVISOR_ALERT allowed by the gate");
      },
    },
    {
      n: 2,
      title: "\"desbloqueámela\": the account stays frozen, the case stays with a person",
      flows: ["FL-050"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const id = complaintIdOf(ctx, "a");
        await sayScript(ctx, persona, 1);
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id), persona.customerId);
        ctx.exactly(view, 1, "freezes (none lifted, none repeated)", freezes(view));
        ctx.none(view, "actions that lift the freeze", view.actions.filter((action) => action.kind !== "FREEZE_OUTGOING" && action.status === "EXECUTED"));
        ctx.check(view.complaint.status === "HUMAN_REVIEW", `the complaint is ${view.complaint.status}, expected HUMAN_REVIEW`);
      },
    },
    {
      n: 3,
      title: "C35: blocked for identity validation → the category explained, HUMAN_REVIEW",
      flows: ["FL-051"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = keepComplaint(ctx, "b", await fileByScript(ctx, persona, 0, "ACCOUNT_BLOCKED"));
        await untilStatus(ctx, persona, id, ["HUMAN_REVIEW"], { progress: progressOf(ctx, "b"), timeoutSec: WAITS.turnSec * 2 });
        const view = await caseOf(ctx, persona.worldId, id);
        ctx.check(view.complaint.handoff?.reason === "ACCOUNT_BLOCKED", `handoff ${view.complaint.handoff?.reason ?? "none"}, expected ACCOUNT_BLOCKED`);
        ctx.check(sentKind(await ctx.snapshot(persona.worldId, persona.customerId), ["REPLY", "HANDOFF_NOTICE", "COMPLAINT_UPDATE"], "WHATSAPP").length >= 1, "the customer was told nothing");
      },
    },
  ],
});
