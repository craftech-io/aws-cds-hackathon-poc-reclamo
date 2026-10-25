// Light load (docs/test-plan.md §7), on demand only (`--scenario LOAD`): 20 messages at once over 10 QA
// conversations, two per customer (a complaint and a follow-up). Nothing reaches the dead letters, each
// customer's messages keep their order (one FIFO group per customer), the complaint numbers are
// consecutive with no duplicate and no gap, and every conversation ends without a processing error.
// Slug `sc99`: the driver's keys and world ids take `sc<nn>`, and no scenario of §4.5 uses 99.
import { scriptMessage } from "./lib/personas";
import { COMPLAINT_NUMBER, complaintsOf, messages } from "./lib/snapshot";
import { defineScenario } from "./lib/steps";
import { WAITS } from "./lib/eventually";
import { createWorld, customerOf, worldOf } from "./lib/world";

const MODELS = ["C01", "C02", "C03", "C04", "C05", "C10", "C11", "C12", "C13", "C14"] as const;
const PERSONAS = MODELS.map((model, index) => ({ key: `p${index}`, model }));
const FOLLOW_UP = "¿Y? ¿Hay alguna novedad con lo que les escribí recién?";

export default defineScenario({
  id: "LOAD",
  slug: "sc99",
  title: "Light load: 20 simultaneous messages over 10 conversations",
  suites: ["full"],
  onDemand: true,
  steps: [
    {
      n: 0,
      title: "world.create: ten complaint personas",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: PERSONAS });
        ctx.state["alarmsBefore"] = ((await ctx.qa("alarm.history", {})) as { items: readonly unknown[] }).items.length;
      },
    },
    {
      n: 1,
      title: "20 messages at once: each customer's script message and a follow-up",
      flows: [],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const started = ctx.now();
        // Each customer's two sends start in order; the 10 customers run in parallel.
        const answers = await Promise.all(
          PERSONAS.map(async (persona) => {
            const first = (await ctx.qa("wa.inbound", { worldId, persona: persona.key, content: { type: "text", text: scriptMessage(persona.model).text } })) as { accepted: boolean };
            const second = (await ctx.qa("wa.inbound", { worldId, persona: persona.key, content: { type: "text", text: FOLLOW_UP } })) as { accepted: boolean };
            return first.accepted && second.accepted;
          }),
        );
        ctx.measure("burstMs", ctx.now() - started);
        ctx.check(answers.every(Boolean), `${answers.filter((accepted) => !accepted).length} customer(s) had a message refused`);
      },
    },
    {
      n: 2,
      title: "no dead letter, the order kept per customer, consecutive numbers with no duplicate nor gap",
      flows: [],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const world = await ctx.settled(worldId, undefined, WAITS.settleSec * 2);
        const numbers: string[] = [];
        for (const persona of PERSONAS) {
          const snapshot = await ctx.snapshot(worldId, customerOf(ctx, persona.key));
          ctx.check(snapshot.processError === null, `${persona.model}'s conversation has a processing error`);
          const inbound = messages(snapshot, { direction: "IN" }).map((message) => message.body);
          ctx.check(inbound.indexOf(FOLLOW_UP) > inbound.indexOf(scriptMessage(persona.model).text), `${persona.model}'s follow-up came before its first message`);
          numbers.push(...complaintsOf(snapshot).map((view) => view.complaint.complaintNumber));
        }
        const sequence = [...new Set(numbers)].filter((number) => COMPLAINT_NUMBER.test(number)).map((number) => Number(number.slice(-6))).sort((a, b) => a - b);
        ctx.exactly(world, numbers.length, "distinct complaint numbers", sequence);
        ctx.check(sequence.every((value, index) => index === 0 || value === (sequence[index - 1] ?? 0) + 1), `the numbers have a gap: ${sequence.join(", ")}`);
        const alarms = ((await ctx.qa("alarm.history", {})) as { items: readonly unknown[] }).items.length;
        ctx.check(alarms === ctx.state["alarmsBefore"], "an alarm (the QA dead letters) moved during the load");
        ctx.warn("a ThrottlingException retried by the SDK is in the workers' logs, which the runner does not read here");
      },
    },
  ],
});
