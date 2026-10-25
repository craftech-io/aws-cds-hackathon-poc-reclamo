// SC-06 · duplicate debits (docs/test-plan.md §4.5). Clones of C25 (instalment 6 debited twice, within
// the agent's cap: refunded at once), C03 (the same above the cap: a person approves) and C26 (two
// instalments of the same amount on the same day: not a duplicate). Then C25 complains again about the
// same debit: the core's claim by natural key (`RFD#`) answers CONFLICT with the action that already
// exists, and there is one refund in total, never two.
import { expectWrittenAnswer } from "./lib/answers";
import { caseOf } from "./lib/console";
import { complaintIdOf, fileByScript, keepComplaint, personaIn, progressOf, untilStatus } from "./lib/flows";
import { WAITS } from "./lib/eventually";
import { decide, executed, expectApprovalRequested, expectClaims, expectExecutedOnce, latestDetails } from "./lib/money";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx), key);

async function file(ctx: ScenarioContext, key: string, name = key): Promise<string> {
  return keepComplaint(ctx, name, await fileByScript(ctx, who(ctx, key), 0, "DUPLICATE_DEBIT"));
}

export default defineScenario({
  id: "SC-06",
  slug: "sc06",
  title: "Duplicate debits: within the cap, above it, a false duplicate, a second complaint on the same debit",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C25, C03 and C26",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: [{ key: "a", model: "C25" }, { key: "b", model: "C03" }, { key: "c", model: "C26" }] });
      },
    },
    {
      n: 1,
      title: "C25: DUPLICATE within the cap → refunded at once, written answer",
      flows: ["FL-037"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const id = await file(ctx, "a");
        await expectWrittenAnswer(ctx, persona, id, { progress: progressOf(ctx, "a") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.check(latestDetails(view, "DUPLICATE_CHECK")?.["verdict"] === "DUPLICATE", "the duplicate check is not DUPLICATE");
        const [refund] = ctx.exactly(view, 1, "refunds", executed(view, "REFUND_DUPLICATE"));
        ctx.check(refund?.amountCents === 7_230_000, `refund of ${refund?.amountCents} cents, expected the $ 72.300 instalment`);
        expectClaims(ctx, view, "REFUND_DUPLICATE");
        ctx.state["refundActionId"] = refund?.actionId;
      },
    },
    {
      n: 2,
      title: "C03: DUPLICATE above the cap → approval → refunded once by code",
      flows: ["FL-038"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = await file(ctx, "b");
        const approval = await expectApprovalRequested(ctx, persona, id, { action: "REFUND_DUPLICATE", tier: "OPERATOR", amountCents: 14_630_000 });
        await decide(ctx, persona, id, approval.approvalId, "APPROVED");
        await expectExecutedOnce(ctx, persona, id, approval.approvalId, "REFUND_DUPLICATE");
      },
    },
    {
      n: 3,
      title: "C26: two instalments of the same amount the same day → NOT_DUPLICATE, no refund",
      flows: ["FL-039"],
      async run(ctx) {
        const persona = who(ctx, "c");
        const id = await file(ctx, "c");
        await expectWrittenAnswer(ctx, persona, id, { progress: progressOf(ctx, "c") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.check(latestDetails(view, "DUPLICATE_CHECK")?.["verdict"] === "NOT_DUPLICATE", `duplicate check ${String(latestDetails(view, "DUPLICATE_CHECK")?.["verdict"])}, expected NOT_DUPLICATE`);
        ctx.none(view, "refunds", executed(view, "REFUND_DUPLICATE"));
      },
    },
    {
      n: 4,
      title: "C25 again on the same debit, its first complaint ANSWERED: CONFLICT with the existing action, one refund in total",
      flows: ["FL-037"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const first = complaintIdOf(ctx, "a");
        const second = await file(ctx, "a", "a2");
        ctx.check(second !== first, "the second complaint reused the answered one");
        await untilStatus(ctx, persona, second, ["RESOLVED", "ANSWERED", "CLOSED", "HUMAN_REVIEW"], { progress: progressOf(ctx, "a"), timeoutSec: WAITS.turnSec * 2 });
        const again = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, second));
        const original = await caseOf(ctx, persona.worldId, first);
        ctx.none(again, "refunds executed by the second complaint", executed(again, "REFUND_DUPLICATE"));
        const conflict = again.actions.find((action) => action.kind === "REFUND_DUPLICATE" && action.status === "CONFLICT");
        ctx.check(conflict !== undefined, "refund_duplicate_debit did not answer CONFLICT on the second complaint");
        ctx.exactly(again, 1, "refunds in total for the debit", [...executed(original, "REFUND_DUPLICATE"), ...executed(again, "REFUND_DUPLICATE")]);
        ctx.check(conflict?.coreRef === undefined || conflict.coreRef === original.actions.find((action) => action.actionId === ctx.state["refundActionId"])?.coreRef, "the CONFLICT does not point to the existing refund");
      },
    },
  ],
});
