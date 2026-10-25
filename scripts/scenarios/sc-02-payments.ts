// SC-02 · payments (docs/test-plan.md §4.5). Six clones on Wed 07/10 10:10, each with its script message
// and receipt: C04 paid at the Red de cobro Sur in a batch already published (MATCHED on the spot), C11
// paid an instalment already applied, C12 paid part of one, C13 paid two together (above the agent's
// cap: a person approves), C14 paid the last one (the loan ends) and C15 paid from the wallet. The model
// investigates and writes; the code reconciles, decides caps and attachments, and applies money once.
import { expectWrittenAnswer } from "./lib/answers";
import { caseOf, consoleCall, latestResult, evidenceDetails } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { complaintIdOf, fileWithReceipt, keepComplaint, noCollectionOnWhatsApp, personaIn, progressOf, untilStatus } from "./lib/flows";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const PERSONAS = [
  { key: "a", model: "C04" },
  { key: "b", model: "C11" },
  { key: "c", model: "C12" },
  { key: "d", model: "C13" },
  { key: "e", model: "C14" },
  { key: "f", model: "C15" },
] as const;

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx), key);

/** Files the script complaint with its receipt and plays the customer until one of `statuses`. */
async function fileAndWait(ctx: ScenarioContext, key: string, statuses: Parameters<typeof untilStatus>[3]): Promise<string> {
  const persona = who(ctx, key);
  const complaintId = keepComplaint(ctx, key, await fileWithReceipt(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
  await untilStatus(ctx, persona, complaintId, statuses, { progress: progressOf(ctx, key), timeoutSec: WAITS.turnSec * 2 });
  return complaintId;
}

const payments = (view: Awaited<ReturnType<typeof caseOf>>) => view.actions.filter((action) => action.kind === "APPLY_PAYMENT" && action.status === "EXECUTED");

export default defineScenario({
  id: "SC-02",
  slug: "sc02",
  title: "Payments: matched, already applied, partial, above the cap, last instalment, wallet",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C04, C11, C12, C13, C14 and C15",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: PERSONAS });
      },
    },
    {
      n: 1,
      title: "C04: MATCHED against the published SUR batch, applied once, written answer",
      flows: ["FL-016"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const id = await fileAndWait(ctx, "a", ["RESOLVED", "ANSWERED", "CLOSED"]);
        await expectWrittenAnswer(ctx, persona, id, { attachments: ["STATEMENT"], progress: progressOf(ctx, "a") });
        const view = await caseOf(ctx, persona.worldId, id);
        ctx.check(latestResult(view, "SETTLEMENT_MATCH") === "MATCHED", `reconciliation ${latestResult(view, "SETTLEMENT_MATCH")}, expected MATCHED`);
        const settled = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.exactly(settled, 1, "payments applied", payments(settled));
      },
    },
    {
      n: 2,
      title: "C11: ALREADY_APPLIED → INFORMATIONAL, no payment",
      flows: ["FL-022"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = await fileAndWait(ctx, "b", ["RESOLVED", "ANSWERED", "CLOSED"]);
        await expectWrittenAnswer(ctx, persona, id, { progress: progressOf(ctx, "b") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.check(latestResult(view, "SETTLEMENT_MATCH") === "ALREADY_APPLIED", `reconciliation ${latestResult(view, "SETTLEMENT_MATCH")}, expected ALREADY_APPLIED`);
        ctx.check(view.complaint.outcome === "INFORMATIONAL", `outcome ${view.complaint.outcome}, expected INFORMATIONAL`);
        ctx.none(view, "payments applied", payments(view));
      },
    },
    {
      n: 3,
      title: "C12: a partial payment applied as it was paid, no collection language",
      flows: ["FL-023"],
      async run(ctx) {
        const persona = who(ctx, "c");
        const id = await fileAndWait(ctx, "c", ["RESOLVED", "ANSWERED", "CLOSED"]);
        await expectWrittenAnswer(ctx, persona, id, { progress: progressOf(ctx, "c") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        const [applied] = ctx.exactly(view, 1, "payments applied", payments(view));
        ctx.check(applied?.amountCents === 5_000_000, `applied ${applied?.amountCents} cents, expected the $ 50.000 of the batch line`);
        noCollectionOnWhatsApp(ctx, await ctx.settled(persona.worldId, persona.customerId));
      },
    },
    {
      n: 4,
      title: "C13: two instalments together, ABOVE_CAP → request_operator_approval with the evidence: AWAITING_APPROVAL",
      flows: ["FL-024"],
      async run(ctx) {
        const persona = who(ctx, "d");
        const id = await fileAndWait(ctx, "d", ["AWAITING_APPROVAL"]);
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        const [approval] = ctx.exactly(view, 1, "pending approvals", view.approvals.filter((item) => item.decision === "PENDING"));
        ensure(approval !== undefined, "no approval");
        ctx.check(approval.action === "APPLY_PAYMENT" && approval.amountCents === 31_240_000 && approval.capTier === "OPERATOR", `approval ${approval.action} ${approval.amountCents} ${approval.capTier}, expected APPLY_PAYMENT 31.240.000 OPERATOR`);
        ctx.check(evidenceDetails(view, "SETTLEMENT_MATCH").length >= 1, "the approval carries no reconciliation evidence");
        ctx.none(view, "payments applied before the approval", payments(view));
        ctx.state["approvalId"] = approval.approvalId;
      },
    },
    {
      n: 5,
      title: "OPERATOR approves with a recent sign-in: execute_approved_action applies it once by code, written answer",
      flows: ["FL-024", "FL-087"],
      async run(ctx) {
        const persona = who(ctx, "d");
        const id = complaintIdOf(ctx, "d");
        const approvalId = ctx.state["approvalId"] as string;
        await consoleCall(ctx, "approvals", "decide", { complaintId: id, approvalId, decision: "APPROVED" }, { worldId: persona.worldId, signedInSecAgo: 0 });
        await expectWrittenAnswer(ctx, persona, id, { progress: progressOf(ctx, "d") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        const [applied] = ctx.exactly(view, 1, "payments applied", payments(view));
        ctx.check(applied?.approvalId === approvalId && applied.amountCents === 31_240_000, "the payment is the approved one, with its amount");
        ctx.check(view.approvals.find((item) => item.approvalId === approvalId)?.executedAt !== undefined, "the approval was not executed");
      },
    },
    {
      n: 6,
      title: "C14: the last instalment → the loan CANCELLED, PAYOFF_CERTIFICATE and STATEMENT attached",
      flows: ["FL-025"],
      async run(ctx) {
        const persona = who(ctx, "e");
        const id = await fileAndWait(ctx, "e", ["RESOLVED", "ANSWERED", "CLOSED"]);
        await expectWrittenAnswer(ctx, persona, id, { attachments: ["PAYOFF_CERTIFICATE", "STATEMENT"], progress: progressOf(ctx, "e") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.exactly(view, 1, "payments applied", payments(view));
      },
    },
    {
      n: 7,
      title: "C15: paid from the wallet (source WALLET) → the instalment PAID",
      flows: ["FL-026"],
      async run(ctx) {
        const persona = who(ctx, "f");
        const id = await fileAndWait(ctx, "f", ["RESOLVED", "ANSWERED", "CLOSED"]);
        await expectWrittenAnswer(ctx, persona, id, { progress: progressOf(ctx, "f") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        const match = evidenceDetails(view, "SETTLEMENT_MATCH").at(-1);
        ctx.check(match?.["result"] === "MATCHED" && match["network"] === "WALLET", `reconciliation ${String(match?.["result"])} on ${String(match?.["network"])}, expected MATCHED on WALLET`);
        ctx.exactly(view, 1, "payments applied", payments(view));
      },
    },
  ],
});
