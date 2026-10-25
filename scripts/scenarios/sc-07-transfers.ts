// SC-07 · transfers (docs/test-plan.md §4.5). Clones of C27 (completed: the network's trace), C28 (pending
// until Thu 08/10 12:00: the complaint waits for the network and the code tells the customer once when it
// completes), C29 (rejected and reversed), C30 (rejected, never reversed: the reversal is requested and
// the wallet credited once, claim `TRV#`) and C31 (an incoming transfer the network does not know: a
// person). The status always comes from `NetworkMock`; the model only reports it.
import { caseOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { complaintIdOf, fileByScript, keepComplaint, personaIn, progressOf, sentKind, untilStatus } from "./lib/flows";
import { executed, expectClaims, latestDetails } from "./lib/money";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { advanceTo, createWorld, worldOf } from "./lib/world";

const COMPLETES_AT = "2026-10-08T12:00:00-03:00";
const DONE = ["RESOLVED", "ANSWERED", "CLOSED"] as const;

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx), key);

async function investigate(ctx: ScenarioContext, key: string, statuses: Parameters<typeof untilStatus>[3]) {
  const persona = who(ctx, key);
  const id = keepComplaint(ctx, key, await fileByScript(ctx, persona, 0, "TRANSFER_NOT_CREDITED"));
  await untilStatus(ctx, persona, id, statuses, { progress: progressOf(ctx, key), timeoutSec: WAITS.turnSec * 2 });
  const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id));
  return { persona, id, view, status: latestDetails(view, "TRANSFER_STATUS") };
}

export default defineScenario({
  id: "SC-07",
  slug: "sc07",
  title: "Transfers: completed, pending, rejected and reversed, rejected without reversal, unknown",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C27, C28, C29, C30 and C31",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: ["C27", "C28", "C29", "C30", "C31"].map((model, index) => ({ key: String.fromCharCode(97 + index), model })) });
      },
    },
    {
      n: 1,
      title: "C27: COMPLETED, the network's trace in the evidence and in what the customer was told",
      flows: ["FL-041"],
      async run(ctx) {
        const { persona, status } = await investigate(ctx, "a", [...DONE]);
        ctx.check(status?.["status"] === "COMPLETED" && typeof status["traceId"] === "string", `transfer ${String(status?.["status"])}, expected COMPLETED with a trace`);
        const snapshot = await ctx.snapshot(persona.worldId, persona.customerId);
        const trace = String(status?.["traceId"]);
        ctx.check(snapshot.messages.some((message) => message.direction === "OUT" && message.body.includes(trace)), `no outbound message carries the trace ${trace}`);
      },
    },
    {
      n: 2,
      title: "C28: PENDING → AWAITING_NETWORK, waiting for the network's transition",
      flows: ["FL-042"],
      async run(ctx) {
        const { persona, status } = await investigate(ctx, "b", ["AWAITING_NETWORK"]);
        ctx.check(status?.["status"] === "PENDING", `transfer ${String(status?.["status"])}, expected PENDING`);
        const snapshot = await ctx.snapshot(persona.worldId);
        ctx.check(snapshot.timers.some((timer) => timer.kind === "NETWORK_TRANSITION" && Date.parse(timer.dueAtSim) === Date.parse(COMPLETES_AT)), "no NETWORK_TRANSITION pending for Thu 08/10 12:00");
      },
    },
    {
      n: 3,
      title: "advance to Thu 08/10 12:00: COMPLETED → exactly one COMPLAINT_UPDATE, sent by code",
      flows: ["FL-042"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const before = sentKind(await ctx.snapshot(persona.worldId, persona.customerId), "COMPLAINT_UPDATE").length;
        await advanceTo(ctx, persona.worldId, COMPLETES_AT);
        await ctx.eventually("a COMPLAINT_UPDATE after the transition", async () => sentKind(await ctx.snapshot(persona.worldId, persona.customerId), "COMPLAINT_UPDATE").length > before, WAITS.turnSec, 5);
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.exactly(after, before + 1, "COMPLAINT_UPDATE messages (one per network event)", sentKind(after, "COMPLAINT_UPDATE"));
        const view = await caseOf(ctx, persona.worldId, complaintIdOf(ctx, "b"));
        ctx.check(view.complaint.status !== "AWAITING_NETWORK", "the complaint is still AWAITING_NETWORK after the transfer completed");
      },
    },
    {
      n: 4,
      title: "C29: REJECTED_REVERSED, no reversal requested",
      flows: ["FL-043"],
      async run(ctx) {
        const { view, status } = await investigate(ctx, "c", [...DONE]);
        ctx.check(status?.["status"] === "REJECTED_REVERSED", `transfer ${String(status?.["status"])}, expected REJECTED_REVERSED`);
        ctx.none(view, "transfer reversals", executed(view, "TRANSFER_REVERSAL"));
      },
    },
    {
      n: 5,
      title: "C30: REJECTED_NOT_REVERSED → request_transfer_reversal → the wallet credited once, claim TRV#",
      flows: ["FL-044"],
      async run(ctx) {
        const { view, status } = await investigate(ctx, "d", [...DONE]);
        ctx.check(status?.["status"] === "REJECTED_NOT_REVERSED", `transfer ${String(status?.["status"])}, expected REJECTED_NOT_REVERSED`);
        ctx.exactly(view, 1, "transfer reversals", executed(view, "TRANSFER_REVERSAL"));
        expectClaims(ctx, view, "TRANSFER_REVERSAL");
      },
    },
    {
      n: 6,
      title: "C31: an incoming transfer the network does not know → UNKNOWN → HUMAN_REVIEW",
      flows: ["FL-045"],
      async run(ctx) {
        const { status } = await investigate(ctx, "e", ["HUMAN_REVIEW"]);
        ctx.check(status === undefined || status["status"] === "UNKNOWN", `transfer ${String(status?.["status"])}, expected UNKNOWN`);
      },
    },
  ],
});
