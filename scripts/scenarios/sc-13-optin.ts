// SC-13 · WhatsApp consent (docs/test-plan.md §4.5). Clones of C01 (opts out), C38 (never opted in) and
// C09 (no open complaint). The opt-out is a fixed answer by code with no turn, recorded in the core; an
// ambiguous "baja" closes nothing; and the channel policy blocks the operator's proactive WhatsApp to a
// customer who opted out, never opted in or has no open complaint, offering the email path. The decisions
// are read on the tape (SC-14's helpers); the operator's sends are console calls, never the model's choice.
import { type ConsoleOutputs, consoleCall } from "./lib/console";
import { type Persona, complaintIdOf, fileByScript, keepComplaint, personaIn, say, until } from "./lib/flows";
import { type Snapshot, messages } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { advanceBy, createWorld, worldOf } from "./lib/world";
import { type Tape, QA_OPERATOR, compose, expectRule, reroute } from "./sc-14-channel-policy";

const PERSONAS = [
  { key: "a", model: "C01" },
  { key: "b", model: "C38" },
  { key: "c", model: "C09" },
] as const;
const UPDATE = { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", text: "Hay una novedad en tu reclamo." } as const;

const who = (ctx: ScenarioContext, key: string): Persona => personaIn(ctx, worldOf(ctx), key);

type CustomerFile = ConsoleOutputs["customers"]["get"]["customer"];

async function customerFile(ctx: ScenarioContext, persona: Persona): Promise<CustomerFile> {
  return (await consoleCall(ctx, "customers", "get", { customerId: persona.customerId }, { worldId: persona.worldId })).customer;
}

const confirmations = (snapshot: Snapshot) => messages(snapshot, { direction: "OUT", kind: "OPT_OUT_CONFIRMATION" });

/** The blocked update's email path: `REROUTED`, and the child `ALLOWED` by email. */
async function byEmail(ctx: ScenarioContext, persona: Persona, blocked: Tape): Promise<void> {
  const { rerouted, child } = await reroute(ctx, persona, blocked, "FORMAL_EMAIL");
  ctx.check(rerouted.decision === "REROUTED", "the block was not rerouted");
  ensure(child !== undefined, "the email path has no decision");
  ctx.check(child.decision === "ALLOWED" && child.channel === "EMAIL", `the email path was ${child.decision} by ${child.channel}`);
}

export default defineScenario({
  id: "SC-13",
  slug: "sc13",
  title: "Opt-in and opt-out: fixed answers, no closure by a word, proactive WhatsApp blocked",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C01, C38 and C09; C01 and C38 file their complaints and accept the email",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: PERSONAS });
        for (const key of ["a", "b"]) {
          const persona = who(ctx, key);
          keepComplaint(ctx, key, await fileByScript(ctx, persona, 0));
          await say(ctx, persona, { type: "button", action: "ACCEPT_EMAIL" });
        }
      },
    },
    {
      n: 1,
      title: "\"baja\" asks which one; the opt-out button → OPT_OUT_CONFIRMATION by code, no turn, recorded in the core",
      flows: ["FL-006"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        await say(ctx, persona, { type: "text", text: "baja" });
        await until(ctx, persona, "the question with two buttons", (snapshot) => messages(snapshot, { direction: "OUT" }).length > messages(before, { direction: "OUT" }).length, { timeoutSec: 60 });
        await say(ctx, persona, { type: "button", action: "OPT_OUT" });
        const after = await until(ctx, persona, "OPT_OUT_CONFIRMATION", (snapshot) => confirmations(snapshot).length > 0, { timeoutSec: 60 });
        ctx.check(after.turnsToday === before.turnsToday, `the opt-out spent ${after.turnsToday - before.turnsToday} turn(s)`);
        const file = await customerFile(ctx, persona);
        ctx.check(file.whatsapp.optedOut && file.whatsapp.optedOutAtSim !== undefined, "the core has no opt-out with its date");
        ctx.check(file.account.status === "ACTIVE", `the account is ${file.account.status} after "baja"`);
      },
    },
    {
      n: 2,
      title: "\"STOP\" confirms by code; \"baja\" alone closes nothing; the operator's update by WhatsApp → BLOCKED CH-OPTOUT → email",
      flows: ["FL-006"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        await say(ctx, persona, { type: "text", text: "STOP" });
        await say(ctx, persona, { type: "text", text: "baja" });
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.check(after.turnsToday === before.turnsToday, `"STOP" and "baja" spent ${after.turnsToday - before.turnsToday} turn(s)`);
        ctx.none(after, "closure confirmations after the word \"baja\"", messages(after, { direction: "OUT", kind: "CLOSURE_CONFIRMATION" }));
        ctx.check((await customerFile(ctx, persona)).account.status === "ACTIVE", "the word \"baja\" closed the account");
        const blocked = await compose(ctx, persona, { ...UPDATE, complaintId: complaintIdOf(ctx, "a") });
        expectRule(ctx, blocked, "BLOCKED", "CH-OPTOUT");
        ctx.check(blocked.sender === QA_OPERATOR, `the block names ${blocked.sender}`);
        await byEmail(ctx, persona, blocked);
      },
    },
    {
      n: 3,
      title: "C38 without opt-in, 26 h later: the operator's update → BLOCKED CH-OPTIN → REROUTED → email ALLOWED",
      flows: ["FL-007"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const inWindow = await ctx.settled(persona.worldId, persona.customerId);
        ctx.check(messages(inWindow, { direction: "OUT", channel: "WHATSAPP", status: ["SENT", "DELIVERED", "READ"] }).length > 0, "nothing was answered inside the window the customer opened");
        await advanceBy(ctx, persona.worldId, 26 * 60);
        const blocked = await compose(ctx, persona, { ...UPDATE, complaintId: complaintIdOf(ctx, "b") });
        expectRule(ctx, blocked, "BLOCKED", "CH-OPTIN");
        await byEmail(ctx, persona, blocked);
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.none(after, "proactive WhatsApp updates to a customer without opt-in", messages(after, { direction: "OUT", channel: "WHATSAPP", kind: "COMPLAINT_UPDATE", status: ["SENT", "DELIVERED", "READ"] }));
      },
    },
    {
      n: 4,
      title: "the reclamo_novedad template to C09 without an open complaint → BLOCKED CH-WA-CUSTOMER-INITIATED; nothing sent",
      flows: ["FL-074"],
      async run(ctx) {
        const persona = who(ctx, "c");
        const left = (snapshot: Snapshot) => messages(snapshot, { direction: "OUT" }).filter((message) => message.status !== "BLOCKED");
        const before = left(await ctx.snapshot(persona.worldId, persona.customerId)).length;
        const blocked = await compose(ctx, persona, { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", template: { name: "reclamo_novedad", params: ["Martín", "R-2026-000100", "NETWORK_PENDING"] } });
        expectRule(ctx, blocked, "BLOCKED", "CH-WA-CUSTOMER-INITIATED");
        const snapshot = await ctx.settled(persona.worldId, persona.customerId);
        ctx.exactly(snapshot, before, "messages that left for C09", left(snapshot));
      },
    },
  ],
});
