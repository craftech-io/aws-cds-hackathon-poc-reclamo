// SC-10 · early payoff, account closure and data changes (docs/test-plan.md §4.5). A clone of C36 asks
// what it takes to cancel the loan today (the amounts it is told are the core's quote) and then closes the
// account after confirming with the button; a clone of C37 changes its address and its email (the
// confirmation goes to the address on file, never to a new one) and its phone (too risky for a chat: a
// person takes it). What is allowed and how is decided by the core and the code, not by the model.
import { caseOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { fileByScript, keepComplaint, mailsOf, mailOutcome, personaIn, progressOf, sayScript, sentKind, until, untilStatus } from "./lib/flows";
import { latestDetails } from "./lib/money";
import { pesos } from "./lib/personas";
import { complaintsOf } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx), key);

/** Every action of the customer's complaints (a follow-up may land on the open complaint or on a new one). */
async function actionsOf(ctx: ScenarioContext, key: string) {
  const persona = who(ctx, key);
  const snapshot = await ctx.snapshot(persona.worldId, persona.customerId);
  return complaintsOf(snapshot).flatMap((view) => view.actions.map((action) => ({ ...action, complaintId: view.complaint.complaintId })));
}

export default defineScenario({
  id: "SC-10",
  slug: "sc10",
  title: "Early payoff, closure and data changes",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C36 and C37",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: [{ key: "a", model: "C36" }, { key: "b", model: "C37" }] });
      },
    },
    {
      n: 1,
      title: "C36: the early payoff quote of the core = the amounts the customer is told",
      flows: ["FL-052"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const id = keepComplaint(ctx, "a", await fileByScript(ctx, persona, 0, "CLOSURE_OR_EARLY_PAYOFF"));
        const quoted = await ctx.eventually("a PAYOFF_QUOTE on the case", async () => latestDetails(await caseOf(ctx, persona.worldId, id), "PAYOFF_QUOTE"), WAITS.turnSec * 2, 5);
        const total = quoted["totalCents"];
        ensure(typeof total === "number", "the quote has no total");
        const text = pesos(total);
        await until(ctx, persona, `the quote's total ${text} told`, (snapshot) => snapshot.messages.some((message) => message.direction === "OUT" && message.body.includes(text.replace(/,00$/, ""))), { progress: progressOf(ctx, "a") });
      },
    },
    {
      n: 2,
      title: "C36: closure confirmed with the button → ACCOUNT_CLOSURE and CLOSURE_CONFIRMATION",
      flows: ["FL-053"],
      async run(ctx) {
        const persona = who(ctx, "a");
        await sayScript(ctx, persona, 1);
        await until(ctx, persona, "ACCOUNT_CLOSURE executed", (snapshot) => complaintsOf(snapshot).some((view) => view.actions.some((action) => action.kind === "ACCOUNT_CLOSURE" && action.status === "EXECUTED")), { plan: { buttons: ["CONFIRM_CLOSURE"] }, progress: progressOf(ctx, "a"), timeoutSec: WAITS.turnSec * 2 });
        const snapshot = await ctx.settled(persona.worldId, persona.customerId);
        ctx.check(sentKind(snapshot, "CLOSURE_CONFIRMATION").length >= 1 || mailsOf(snapshot, "CLOSURE_CONFIRMATION", persona.customerId).length >= 1, "no CLOSURE_CONFIRMATION went out");
        ctx.exactly(snapshot, 1, "account closures", (await actionsOf(ctx, "a")).filter((action) => action.kind === "ACCOUNT_CLOSURE" && action.status === "EXECUTED"));
      },
    },
    {
      n: 3,
      title: "C37: address and email → each confirmed to the address on file",
      flows: ["FL-054"],
      async run(ctx) {
        const persona = who(ctx, "b");
        keepComplaint(ctx, "b", await fileByScript(ctx, persona, 0, "DATA_CHANGE"));
        await sayScript(ctx, persona, 1);
        const fields = (actions: Awaited<ReturnType<typeof actionsOf>>) => new Set(actions.filter((action) => action.kind === "DATA_CHANGE").map((action) => action.dataChangeField));
        await ctx.eventually("DATA_CHANGE of ADDRESS and EMAIL", async () => {
          const changed = fields(await actionsOf(ctx, "b"));
          return changed.has("ADDRESS") && changed.has("EMAIL");
        }, WAITS.turnSec * 2, 5);
        const snapshot = await ctx.settled(persona.worldId, persona.customerId);
        const confirmations = mailsOf(snapshot, "DATA_CHANGE_CONFIRMATION", persona.customerId);
        ctx.check(confirmations.length >= 1, "no DATA_CHANGE_CONFIRMATION mail");
        for (const mail of confirmations) await mailOutcome(ctx, persona.worldId, mail.mailId);
      },
    },
    {
      n: 4,
      title: "C37: the phone → REFERRED → HUMAN_REVIEW",
      flows: ["FL-055"],
      async run(ctx) {
        const persona = who(ctx, "b");
        await sayScript(ctx, persona, 2);
        await until(ctx, persona, "the phone change REFERRED", (snapshot) => complaintsOf(snapshot).some((view) => view.actions.some((action) => action.kind === "DATA_CHANGE" && action.status === "REFERRED")), { progress: progressOf(ctx, "b"), timeoutSec: WAITS.turnSec * 2 });
        const referred = (await actionsOf(ctx, "b")).find((action) => action.kind === "DATA_CHANGE" && action.status === "REFERRED");
        ensure(referred !== undefined, "no REFERRED data change");
        ctx.check(referred.dataChangeField === "PHONE", `the referred change is ${referred.dataChangeField}, expected PHONE`);
        await untilStatus(ctx, persona, referred.complaintId, ["HUMAN_REVIEW"], { progress: progressOf(ctx, "b") });
      },
    },
  ],
});
