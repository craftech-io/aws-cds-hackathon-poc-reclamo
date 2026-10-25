// SC-05 · charges (docs/test-plan.md §4.5). Clones of C22 (a correct late-payment charge, explained with
// the terms), C02 (a card replacement never asked for, within the agent's cap: reversed with a credit
// note), C23 twice (an insurance never taken out, above the agent's cap: an OPERATOR approves one and
// rejects the other) and C24 (an origination fee charged twice, above the OPERATOR's cap: only a
// SUPERVISOR may approve it); a second C02 with two reversals this month in its history (FL-040). The
// verdict comes from the core's fee table, never from the model; caps and tiers are code. A message that
// left passed G2 with the grounding threshold of ADR-0008 (the gate). A model is cloned once per world:
// the second C23 and the C02 with history live in worlds of their own (`sc05-d`, `sc05-h`).
import { expectWrittenAnswer } from "./lib/answers";
import { caseOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { complaintIdOf, fileByScript, keepComplaint, personaIn, progressOf, untilStatus } from "./lib/flows";
import { decide, decisionRefused, executed, expectApprovalRequested, expectClaims, expectExecutedOnce, latestDetails } from "./lib/money";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const PERSONAS = [
  { key: "a", model: "C22" },
  { key: "b", model: "C02" },
  { key: "c", model: "C23" },
  { key: "e", model: "C24" },
] as const;

/** Two reversals the agent executed on its own this month (C02's $ 2.500 stays within the agent's cap). */
const TWO_REVERSALS = [
  { persona: "f", action: "REVERSE_CHARGE", amountCents: 120_000, daysAgo: 8 },
  { persona: "f", action: "REVERSE_CHARGE", amountCents: 95_000, daysAgo: 20 },
] as const;

/** Clone key → the suffix of its world (the main world otherwise). */
const WORLD_OF: Readonly<Record<string, string>> = { d: "d", f: "h" };

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx, WORLD_OF[key] ?? "main"), key);

async function file(ctx: ScenarioContext, key: string): Promise<string> {
  return keepComplaint(ctx, key, await fileByScript(ctx, who(ctx, key), 0, "UNRECOGNIZED_CHARGE"));
}

export default defineScenario({
  id: "SC-05",
  slug: "sc05",
  title: "Charges: correct, wrong within the cap, above the agent's cap, above the operator's tier",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C22, C02, C23 and C24; a second C23 (sc05-d); a C02 with two reversals this month (sc05-h)",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: PERSONAS });
        await createWorld(ctx, { suffix: "d", personas: [{ key: "d", model: "C23" }] });
        await createWorld(ctx, { suffix: "h", personas: [{ key: "f", model: "C02" }], history: TWO_REVERSALS });
      },
    },
    {
      n: 1,
      title: "C22: the charge is CORRECT, explained with the terms; no reversal",
      flows: ["FL-032"],
      async run(ctx) {
        const persona = who(ctx, "a");
        const id = await file(ctx, "a");
        await expectWrittenAnswer(ctx, persona, id, { progress: progressOf(ctx, "a") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.check(latestDetails(view, "CHARGE_CHECK")?.["verdict"] === "CORRECT", `charge check ${String(latestDetails(view, "CHARGE_CHECK")?.["verdict"])}, expected CORRECT`);
        ctx.none(view, "reversals", executed(view, "REVERSE_CHARGE"));
      },
    },
    {
      n: 2,
      title: "C02: WRONG → reversal within the cap, credit note attached, refund entry",
      flows: ["FL-033"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = await file(ctx, "b");
        await expectWrittenAnswer(ctx, persona, id, { attachments: ["CREDIT_NOTE"], progress: progressOf(ctx, "b") });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.check(latestDetails(view, "CHARGE_CHECK")?.["verdict"] === "WRONG", "the charge check is not WRONG");
        const [reversal] = ctx.exactly(view, 1, "reversals", executed(view, "REVERSE_CHARGE"));
        ctx.check(reversal?.amountCents === 250_000 && reversal.approvalId === undefined, `reversal of ${reversal?.amountCents} cents, expected $ 2.500 without an approval`);
        expectClaims(ctx, view, "REVERSE_CHARGE");
      },
    },
    {
      n: 3,
      title: "C23: above the agent's cap → an OPERATOR's approval is requested",
      flows: ["FL-034"],
      async run(ctx) {
        const id = await file(ctx, "c");
        const approval = await expectApprovalRequested(ctx, who(ctx, "c"), id, { action: "REVERSE_CHARGE", tier: "OPERATOR", amountCents: 3_890_000 });
        ctx.state["approval:c"] = approval.approvalId;
      },
    },
    {
      n: 4,
      title: "the OPERATOR approves: the reversal runs once, by code",
      flows: ["FL-034"],
      async run(ctx) {
        const persona = who(ctx, "c");
        const id = complaintIdOf(ctx, "c");
        const approvalId = ctx.state["approval:c"] as string;
        await decide(ctx, persona, id, approvalId, "APPROVED");
        await expectExecutedOnce(ctx, persona, id, approvalId, "REVERSE_CHARGE");
      },
    },
    {
      n: 5,
      title: "a clone of C23: the OPERATOR rejects with a reason → HUMAN_REVIEW, no reversal",
      flows: ["FL-035"],
      async run(ctx) {
        const persona = who(ctx, "d");
        const id = await file(ctx, "d");
        const approval = await expectApprovalRequested(ctx, persona, id, { action: "REVERSE_CHARGE", tier: "OPERATOR" });
        await decide(ctx, persona, id, approval.approvalId, "REJECTED", "OPERATOR", "El seguro figura contratado en la solicitud firmada.");
        await untilStatus(ctx, persona, id, ["HUMAN_REVIEW"], { progress: progressOf(ctx, "d"), timeoutSec: WAITS.turnSec * 2 });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.none(view, "reversals after a rejection", executed(view, "REVERSE_CHARGE"));
        ctx.check(view.approvals.find((item) => item.approvalId === approval.approvalId)?.decision === "REJECTED", "the approval is not REJECTED");
      },
    },
    {
      n: 6,
      title: "C24: SUPERVISOR tier: the OPERATOR is refused (CAP_TIER), the SUPERVISOR approves",
      flows: ["FL-036"],
      async run(ctx) {
        const persona = who(ctx, "e");
        const id = await file(ctx, "e");
        const approval = await expectApprovalRequested(ctx, persona, id, { action: "REVERSE_CHARGE", tier: "SUPERVISOR", amountCents: 21_200_000 });
        const refusal = await decisionRefused(ctx, persona, id, approval.approvalId, "OPERATOR");
        ctx.check(/FORBIDDEN/.test(refusal) && /CAP_TIER/.test(refusal), `the OPERATOR's decision answered ${refusal}, expected FORBIDDEN CAP_TIER`);
        await decide(ctx, persona, id, approval.approvalId, "APPROVED", "SUPERVISOR");
        await expectExecutedOnce(ctx, persona, id, approval.approvalId, "REVERSE_CHARGE");
      },
    },
    {
      n: 7,
      title: "a clone of C02 with two reversals this month → ABOVE_CAP MONTHLY_AUTO_LIMIT",
      flows: ["FL-040"],
      async run(ctx) {
        const persona = who(ctx, "f");
        const id = await file(ctx, "f");
        // $ 2.500 is within the agent's cap (step 2 reversed it alone): only the monthly limit asks an OPERATOR.
        const approval = await expectApprovalRequested(ctx, persona, id, { action: "REVERSE_CHARGE", tier: "OPERATOR", amountCents: 250_000 });
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
        ctx.none(view, "automatic reversals of the new complaint", executed(view, "REVERSE_CHARGE"));
        ctx.note("monthlyLimitApproval", approval.approvalId);
      },
    },
  ],
});
