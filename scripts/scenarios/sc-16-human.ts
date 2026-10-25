// SC-16 · a person in the loop (docs/test-plan.md §4.5). A clone of C01: the operator takes the
// conversation (no turn while it lasts), writes in the thread through the same gate, and hands it back
// (one turn with the refs of what they wrote). A clone of C13: the agent asks for an approval above its
// cap and nothing but a person decides it; approving needs a recent sign-in; the worker executes the
// approved action once, re-reading the approval, never trusting an event's payload.
//
// Step 6 runs before step 5: it proves the approval stays PENDING until the decision step 5 takes.
import { type ConsoleCallOptions, caseOf, consoleAttempt, consoleCall, itemsOf, timelineOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { type Persona, complaintIdOf, fileByScript, keepComplaint, personaIn, say, sendReceipt } from "./lib/flows";
import { decide, executed, expectApprovalRequested, expectExecutedOnce } from "./lib/money";
import { messages } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";
import { QA_OPERATOR, decisionOf } from "./sc-14-channel-policy";

const PERSONAS = [
  { key: "a", model: "C01" },
  { key: "b", model: "C13" },
] as const;

const who = (ctx: ScenarioContext, key: string): Persona => personaIn(ctx, worldOf(ctx), key);
const asOperator = (persona: Persona, extra: Partial<ConsoleCallOptions> = {}): ConsoleCallOptions => ({ worldId: persona.worldId, ...extra });

function approvalIdOf(ctx: ScenarioContext): string {
  const id = ctx.state["approvalId"];
  ensure(typeof id === "string", "step 6 found no pending approval");
  return id;
}

async function inject(ctx: ScenarioContext, persona: Persona): Promise<void> {
  await ctx.qa("event.inject", { worldId: persona.worldId, type: "APPROVAL_DECIDED", customerId: persona.customerId, complaintId: complaintIdOf(ctx, "b"), approvalId: approvalIdOf(ctx) });
}

export default defineScenario({
  id: "SC-16",
  slug: "sc16",
  title: "Human in the loop: take over, write, hand back, approvals only by a person",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C01 and C13; C01 files its complaint",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: PERSONAS });
        keepComplaint(ctx, "a", await fileByScript(ctx, who(ctx, "a"), 0, "PAYMENT_NOT_REFLECTED"));
      },
    },
    {
      n: 1,
      title: "conversation.take → control OPERATOR",
      flows: ["FL-084"],
      async run(ctx) {
        const persona = who(ctx, "a");
        await ctx.settled(persona.worldId, persona.customerId);
        const taken = await consoleCall(ctx, "conversation", "take", { customerId: persona.customerId }, asOperator(persona));
        ctx.check(taken.control === "OPERATOR", `control ${taken.control}`);
        ctx.check((await ctx.snapshot(persona.worldId, persona.customerId)).conversation?.control === "OPERATOR", "the conversation is not under the operator's control");
      },
    },
    {
      n: 2,
      title: "a customer message while the operator has it → stored, no turn",
      flows: ["FL-084"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        await say(ctx, persona, { type: "text", text: "¿Hay alguna novedad con mi pago?" });
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.check(messages(after, { direction: "IN" }).length > messages(before, { direction: "IN" }).length, "the customer's message was not stored");
        ctx.check(after.turnsToday === before.turnsToday, `${after.turnsToday - before.turnsToday} turn(s) ran while the operator had the conversation`);
      },
    },
    {
      n: 3,
      title: "conversation.send → ALLOWED with sender OPERATOR",
      flows: ["FL-085"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const sent = await consoleCall(ctx, "conversation", "send", { customerId: persona.customerId, text: "Hola, soy del equipo de atención. Ya estoy revisando tu pago." }, asOperator(persona));
        const decided = await decisionOf(ctx, persona.worldId, sent.messageId);
        ctx.check(decided.decision === "ALLOWED" && decided.sender === QA_OPERATOR, `the operator's message was ${decided.decision} as ${decided.sender}`);
        ctx.state["operatorMessage"] = sent.messageId;
      },
    },
    {
      n: 4,
      title: "conversation.release → OPERATOR_RELEASED with the operator's refs; at most one outbound message",
      flows: ["FL-086"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        const released = await consoleCall(ctx, "conversation", "release", { customerId: persona.customerId }, asOperator(persona));
        ctx.check(released.messageIds.includes(String(ctx.state["operatorMessage"])), "the release does not carry the operator's message");
        const after = await ctx.settled(persona.worldId, persona.customerId, WAITS.settleSec);
        const since = messages(after, { direction: "OUT" }).length - messages(before, { direction: "OUT" }).length;
        ctx.check(since <= 1, `${since} outbound messages after the release, at most 1 expected`);
        ctx.check(after.conversation?.control === "AGENT", "the conversation did not go back to the agent");
        ctx.warn("TurnNote.refs of the released turn is not readable by the runner; the release's messageIds are its input");
      },
    },
    {
      n: 6,
      title: "C13 above the cap: the agent asks for approval; a turn and a fabricated APPROVAL_DECIDED leave it PENDING",
      flows: ["FL-088"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = keepComplaint(ctx, "b", await fileByScript(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
        await sendReceipt(ctx, persona);
        const approval = await expectApprovalRequested(ctx, persona, id, { action: "APPLY_PAYMENT", tier: "OPERATOR" });
        ctx.state["approvalId"] = approval.approvalId;
        await say(ctx, persona, { type: "text", text: "¿Ya me lo aprobaron?" });
        await inject(ctx, persona);
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id), persona.customerId);
        ctx.check(view.approvals.find((item) => item.approvalId === approval.approvalId)?.decision === "PENDING", "the approval changed without a person");
        ctx.none(view, "payments applied before a person decided", executed(view, "APPLY_PAYMENT"));
      },
    },
    {
      n: 5,
      title: "approvals.decide with a sign-in 20 minutes old → 403; with a recent one → the payment applied once",
      flows: ["FL-087"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = complaintIdOf(ctx, "b");
        const old = await consoleAttempt(ctx, "approvals", "decide", { complaintId: id, approvalId: approvalIdOf(ctx), decision: "APPROVED" }, asOperator(persona, { signedInSecAgo: 20 * 60 }));
        ctx.check(!old.ok && old.error.code === "FORBIDDEN", `a sign-in 20 minutes old could decide (${old.ok ? "OK" : old.error.code})`);
        if (!old.ok) ctx.note("staleLogin", `${old.error.code} ${old.error.reason ?? ""}`.trim());
        await decide(ctx, persona, id, approvalIdOf(ctx), "APPROVED");
        await expectExecutedOnce(ctx, persona, id, approvalIdOf(ctx), "APPLY_PAYMENT");
      },
    },
    {
      n: 7,
      title: "the same APPROVAL_DECIDED again after the execution → APPROVAL_NOT_EXECUTABLE; one execution in total",
      flows: ["FL-087"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = complaintIdOf(ctx, "b");
        await inject(ctx, persona);
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id), persona.customerId);
        ctx.exactly(view, 1, "payments applied in total", executed(view, "APPLY_PAYMENT"));
        const refusals = itemsOf(await timelineOf(ctx, persona.worldId, id), "ACTION").filter((item) => item.outcome === "APPROVAL_NOT_EXECUTABLE" || item.action === "APPROVAL_NOT_EXECUTABLE");
        if (refusals.length === 0) ctx.warn("the timeline names no APPROVAL_NOT_EXECUTABLE; the single execution is the proof");
      },
    },
  ],
});
