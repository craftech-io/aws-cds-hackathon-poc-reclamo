// SC-20 · audit and metrics, last (docs/test-plan.md §4.5). The policy audit of every world of the run is
// 0; `qamin` just reset shows the seeded history of its template and measured KPIs with N = 0; a reset
// purges the agent's memory of the old epoch (the sentinel proves the extraction ran first); and the
// phone simulator's procedures sign the same envelope as `wa.inbound`. The simulator lives in a world of
// the `guest` template (its personas keep their fixed ids): the driver's fence admits no simulator call
// on `qamin`. Step 3 runs before step 2: its reset is the one step 2 reads (a world is reset at most once
// every 10 real minutes).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { consoleCall } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { messages } from "./lib/snapshot";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { createWorld } from "./lib/world";
import { resetAndWait } from "./sc-22-guest-world";

const QAMIN = "qamin";
/** `qamin`'s C01 (the qa-min template keeps the personas' fixed ids). */
const QAMIN_CUSTOMER = "cus-0001";
const SENTINEL = "mañana";
const MANIFEST = fileURLToPath(new URL("../seed/data/manifest.json", import.meta.url));

function qaMinComplaints(): number {
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { counts: Record<string, { Complaint: number }> }).counts["qa-min"]?.Complaint ?? -1;
}

interface Inspection {
  readonly actorId: string;
  readonly events: number;
  readonly records: readonly unknown[];
  readonly sentinelSeen: boolean | null;
}

const inspect = async (ctx: ScenarioContext, epoch?: number): Promise<Inspection> => (await ctx.qa("memory.inspect", { worldId: QAMIN, customerId: QAMIN_CUSTOMER, sentinel: SENTINEL, ...(epoch === undefined ? {} : { epoch }) })) as Inspection;

export default defineScenario({
  id: "SC-20",
  slug: "sc20",
  title: "Audit and metrics: zero violations, seeded history, memory purged by a reset, simulator envelope",
  suites: ["full"],
  last: true,
  steps: [
    {
      n: 1,
      title: "policyAudit of every scenario of the run → 0 violations, every world audited",
      flows: ["FL-075"],
      async run(ctx) {
        const violations = ctx.previous.reduce((sum, item) => sum + item.violations, 0);
        const unaudited = ctx.previous.filter((item) => item.unaudited > 0).map((item) => item.scenario);
        ctx.measure("violations", violations);
        ctx.check(ctx.previous.length > 0, "no earlier scenario to aggregate: SC-20 runs last in the full suite");
        ctx.check(violations === 0, `${violations} policy violation(s) over the run`);
        ctx.check(unaudited.length === 0, `worlds without a policy audit in ${unaudited.join(", ")}`);
      },
    },
    {
      n: 3,
      title: "a turn with a preference sentinel in qamin → memory.inspect shows it → reset → READY → no event nor record of the old actor (120 s) nor of the new one",
      flows: ["FL-100"],
      async run(ctx) {
        await ctx.qa("wa.inbound", { worldId: QAMIN, persona: "C01", content: { type: "text", text: `Escribime a la ${SENTINEL}, por favor, cuando tengan novedades` } });
        const before = await ctx.eventually("the sentinel's memory record", async () => {
          const seen = await inspect(ctx);
          return seen.sentinelSeen === true ? seen : undefined;
        }, WAITS.memoryExtractionSec, 60);
        const oldEpoch = (await ctx.snapshot(QAMIN)).epoch;
        ctx.note("oldActor", before.actorId);
        await ctx.settled(QAMIN);
        await resetAndWait(ctx, QAMIN, "OPERATOR");
        await ctx.eventually("the old actor purged", async () => {
          const old = await inspect(ctx, oldEpoch);
          return old.events === 0 && old.records.length === 0;
        }, WAITS.memoryPurgeSec, 10);
        const fresh = await inspect(ctx);
        ctx.check(fresh.events === 0 && fresh.records.length === 0, `the new epoch's actor has ${fresh.events} event(s) and ${fresh.records.length} record(s)`);
      },
    },
    {
      n: 2,
      title: "qamin just reset: the seeded-history box = the manifest; measured KPIs with N = 0",
      flows: ["FL-098"],
      async run(ctx) {
        const metrics = (await ctx.qa("metrics.get", { worldId: QAMIN })) as { n: number; seededHistory?: { total: number } };
        ctx.check(metrics.n === 0, `${metrics.n} measured complaint(s) in a world just reset`);
        ctx.check(metrics.seededHistory?.total === qaMinComplaints(), `seeded history ${metrics.seededHistory?.total ?? "missing"}, the manifest says ${qaMinComplaints()}`);
      },
    },
    {
      n: 4,
      title: "simulator.personas, sendText and attachReceipt by createCaller → the same signed envelope as wa.inbound",
      flows: ["FL-101"],
      async run(ctx) {
        const world = await createWorld(ctx, { template: "guest" });
        const asGuest = { worldId: world.worldId, role: "GUEST" as const };
        const listed = await consoleCall(ctx, "simulator", "personas", undefined, asGuest);
        const c01 = listed.personas.find((persona) => persona.persona === "C01");
        ctx.check(c01 !== undefined && c01.hasReceipt, "the simulator does not offer C01 with its receipt");
        const before = await ctx.settled(world.worldId, "cus-0001");
        await consoleCall(ctx, "simulator", "sendText", { persona: "C01", text: "Hola, ¿me confirman el estado de mi pago?" }, asGuest);
        await consoleCall(ctx, "simulator", "attachReceipt", { persona: "C01", source: { kind: "SCRIPT" } }, asGuest);
        const byDriver = (await ctx.qa("wa.inbound", { worldId: world.worldId, persona: "C01", content: { type: "text", text: "¿Y ya lo vieron?" } })) as { accepted: boolean };
        ctx.check(byDriver.accepted, "wa.inbound was not accepted where the simulator's messages were");
        const after = await ctx.settled(world.worldId, "cus-0001");
        const inbound = messages(after, { direction: "IN", channel: "WHATSAPP" }).slice(messages(before, { direction: "IN" }).length);
        ctx.exactly(after, 3, "inbound messages from the simulator and the driver", inbound);
        ctx.check(new Set(inbound.map((message) => message.status)).size === 1, `the three entered differently: ${inbound.map((message) => message.status).join(", ")}`);
      },
    },
  ],
});
