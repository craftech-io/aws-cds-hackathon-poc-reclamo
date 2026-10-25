// SC-08 · disbursements (docs/test-plan.md §4.5). Clones of C32 (credited, net of the origination fee),
// C33 (pending and still within its term: the agent follows it up), a second clone of C33 whose term runs
// out before the network credits it (a person takes it; in a world of its own, `sc08-c`: a model is cloned
// once per world) and C34 (failed and returned: a person). The disbursement's state and term come from
// the core; the follow-up is a timer the clock moves.
import { caseOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { complaintIdOf, fileByScript, keepComplaint, personaIn, progressOf, untilStatus } from "./lib/flows";
import { latestDetails } from "./lib/money";
import { complaintOwner } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { advanceTo, createWorld, worldOf } from "./lib/world";

/** The network credits C33's disbursement on Fri 09/10 15:00 (docs/seed-spec.md §4). */
const CREDITED_AT = "2026-10-09T15:00:00-03:00";
const DONE = ["RESOLVED", "ANSWERED", "CLOSED"] as const;

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx, key === "c" ? "c" : "main"), key);

async function investigate(ctx: ScenarioContext, key: string, statuses: Parameters<typeof untilStatus>[3]) {
  const persona = who(ctx, key);
  const id = keepComplaint(ctx, key, await fileByScript(ctx, persona, 0, "DISBURSEMENT_NOT_RECEIVED"));
  await untilStatus(ctx, persona, id, statuses, { progress: progressOf(ctx, key), timeoutSec: WAITS.turnSec * 2 });
  const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
  return { persona, id, view, disbursement: latestDetails(view, "DISBURSEMENT") };
}

export default defineScenario({
  id: "SC-08",
  slug: "sc08",
  title: "Disbursements: credited net of the fee, pending within term, overdue, failed",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C32, C33 and C34; a second C33 (sc08-c)",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: [{ key: "a", model: "C32" }, { key: "b", model: "C33" }, { key: "d", model: "C34" }] });
        await createWorld(ctx, { suffix: "c", personas: [{ key: "c", model: "C33" }] });
      },
    },
    {
      n: 1,
      title: "C32: CREDITED, the amount net of FEE-ORIG",
      flows: ["FL-046"],
      async run(ctx) {
        const { disbursement } = await investigate(ctx, "a", [...DONE]);
        ctx.check(disbursement?.["status"] === "CREDITED" && typeof disbursement["net"] === "number", `disbursement ${String(disbursement?.["status"])}, expected CREDITED with its net amount`);
      },
    },
    {
      n: 2,
      title: "C33: PENDING within its term → a FOLLOW_UP timer, no person yet",
      flows: ["FL-047"],
      async run(ctx) {
        const { persona, id, view, disbursement } = await investigate(ctx, "b", ["AWAITING_NETWORK", ...DONE]);
        ctx.check(disbursement?.["status"] === "PENDING", `disbursement ${String(disbursement?.["status"])}, expected PENDING`);
        ctx.check(view.complaint.status !== "HUMAN_REVIEW", "a disbursement within its term went to a person");
        const snapshot = await ctx.snapshot(persona.worldId);
        ctx.check(snapshot.timers.some((timer) => timer.kind === "FOLLOW_UP" && timer.ownerKey === complaintOwner(id)), "no FOLLOW_UP pending for the complaint");
      },
    },
    {
      n: 3,
      title: "the second clone of C33, never credited before its term ends: advance past the term → HUMAN_REVIEW",
      flows: ["FL-047"],
      async run(ctx) {
        const { persona, id } = await investigate(ctx, "c", ["AWAITING_NETWORK", ...DONE]);
        const snapshot = await ctx.settled(persona.worldId);
        const follow = snapshot.timers.find((timer) => timer.kind === "FOLLOW_UP" && timer.ownerKey === complaintOwner(id));
        ensure(follow !== undefined, "no FOLLOW_UP pending for the second clone");
        ctx.check(Date.parse(follow.dueAtSim) < Date.parse(CREDITED_AT), `the follow-up is due ${follow.dueAtSim}, after the network credits the disbursement`);
        await advanceTo(ctx, persona.worldId, follow.dueAtSim);
        await untilStatus(ctx, persona, complaintIdOf(ctx, "c"), ["HUMAN_REVIEW"], { progress: progressOf(ctx, "c"), timeoutSec: WAITS.turnSec * 2 });
      },
    },
    {
      n: 4,
      title: "C34: FAILED_RETURNED → HUMAN_REVIEW",
      flows: ["FL-048"],
      async run(ctx) {
        const { disbursement } = await investigate(ctx, "d", ["HUMAN_REVIEW"]);
        ctx.check(disbursement === undefined || disbursement["status"] === "FAILED_RETURNED", `disbursement ${String(disbursement?.["status"])}, expected FAILED_RETURNED`);
      },
    },
  ],
});
