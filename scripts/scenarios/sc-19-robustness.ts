// SC-19 · robustness (docs/test-plan.md §4.5). Clones of C08 (three, one per world) and C04 (two). Caps
// count on the real clock whatever the world's clock says; a turn cap or the QA pool's global cap stops a
// turn before the Harness; a repeated delivery is one message; a failed or silent turn ends in a fixed
// notice or in the obligation the code enqueues; a poisoned event lands in the QA dead letters with its
// alarm; the guardrail stops a known attack; and the per-world kill switch keeps the number on the spot
// while no turn runs. It runs alone: priming the QA pool's global cap would stop every other scenario.
import { WAITS } from "./lib/eventually";
import { type Persona, fileByScript, keepComplaint, complaintIdOf, personaIn, say, sayScript, sendReceipt, sentKind, untilStatus } from "./lib/flows";
import { messages } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const who = (ctx: ScenarioContext, key: string, suffix = "main"): Persona => personaIn(ctx, worldOf(ctx, suffix), key);

/** Sends a text and returns the inbound outcomes InboundWhatsApp answered. */
async function outcomesOf(ctx: ScenarioContext, persona: Persona, text: string): Promise<readonly string[]> {
  return (await say(ctx, persona, { type: "text", text })).outcomes;
}

/** A message whose turn must not reach the Harness: the day's turns do not move. */
async function noTurn(ctx: ScenarioContext, persona: Persona, text: string, what: string): Promise<void> {
  const before = await ctx.settled(persona.worldId, persona.customerId);
  await say(ctx, persona, { type: "text", text });
  const after = await ctx.settled(persona.worldId, persona.customerId);
  ctx.check(after.turnsToday === before.turnsToday, `${what}: ${after.turnsToday - before.turnsToday} turn(s) ran`);
  ctx.check(messages(after, { direction: "IN" }).length > messages(before, { direction: "IN" }).length, `${what}: the message was not stored`);
}

export default defineScenario({
  id: "SC-19",
  slug: "sc19",
  title: "Robustness: real-clock caps, duplicates, failed and silent turns, dead letters, guardrail, kill switch",
  suites: ["full"],
  alone: true,
  steps: [
    {
      n: 0,
      title: "world.create: C08 with rateLimitPerHour 3; C08 and C04; C08; C04",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: [{ key: "a", model: "C08" }], settings: { rateLimitPerHour: 3 } });
        await createWorld(ctx, { suffix: "b", personas: [{ key: "a", model: "C08" }, { key: "b", model: "C04" }] });
        await createWorld(ctx, { suffix: "c", personas: [{ key: "a", model: "C08" }] });
        await createWorld(ctx, { suffix: "d", personas: [{ key: "a", model: "C04" }] });
      },
    },
    {
      n: 1,
      title: "four messages in the same real hour with rateLimitPerHour 3 → the fourth DENY RATE_LIMIT, no turn; +1 simulated hour and a fifth → still denied",
      flows: ["FL-105"],
      async run(ctx) {
        const persona = who(ctx, "a");
        for (const text of ["Hola", "¿Cuánto debo?", "¿Cuándo vence?"]) ctx.check(!(await outcomesOf(ctx, persona, text)).includes("RATE_LIMITED"), `"${text}" was rate limited before the cap`);
        const before = await ctx.settled(persona.worldId, persona.customerId);
        ctx.check((await outcomesOf(ctx, persona, "¿Me confirman?")).includes("RATE_LIMITED"), "the fourth message in the hour was admitted");
        await ctx.qa("clock.advance", { worldId: persona.worldId, minutes: 60 });
        ctx.check((await outcomesOf(ctx, persona, "¿Y ahora?")).includes("RATE_LIMITED"), "the simulated clock reopened a cap counted on the real clock");
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.check(after.turnsToday === before.turnsToday, `denied messages spent ${after.turnsToday - before.turnsToday} turn(s)`);
      },
    },
    {
      n: 2,
      title: "caps.prime(TURNCAP) at the cap → TURN_CAP without invoking the Harness",
      flows: ["FL-105"],
      async run(ctx) {
        const persona = who(ctx, "a", "c");
        await ctx.qa("caps.prime", { worldId: persona.worldId, bucket: "TURNCAP", value: 100_000, window: "DAY" });
        await noTurn(ctx, persona, "¿Cuánto me falta pagar?", "a world past its turn cap");
      },
    },
    {
      n: 3,
      title: "the same delivery twice, and redelivered with the same wamid → one message and one number",
      flows: ["FL-106"],
      async run(ctx) {
        const persona = who(ctx, "b", "b");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        const content = { type: "text" as const, text: "Pagué la cuota el viernes en la Red de cobro Sur y todavía no se refleja" };
        const deliver = ctx.repeatable("wa.inbound", { worldId: persona.worldId, persona: persona.key, content });
        const first = (await deliver()) as { wamid: string };
        // The runner's retry under one key (the driver replays it), then a real redelivery: a new call with the same wamid.
        await deliver();
        const again = (await ctx.qa("wa.inbound", { worldId: persona.worldId, persona: persona.key, content, redeliveryOf: first.wamid })) as { wamid: string };
        ctx.check(again.wamid === first.wamid, "the redelivery did not carry the first message's wamid");
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.exactly(after, messages(before, { direction: "IN" }).length + 1, "inbound messages after a repeated delivery", messages(after, { direction: "IN" }));
        const [filed] = ctx.exactly(after, before.complaints.length + 1, "complaints after a repeated delivery", after.complaints).filter((view) => !before.complaints.some((old) => old.complaint?.complaintId === view.complaint?.complaintId));
        ensure(filed?.complaint != null, "the delivery filed no complaint");
        ctx.state["complaint:dup"] = filed.complaint.complaintId;
      },
    },
    {
      n: 4,
      title: "turn.forceFailure → the fixed HANDOFF_NOTICE (AGENT_FALLBACK)",
      flows: ["FL-107"],
      async run(ctx) {
        const persona = who(ctx, "a", "b");
        await ctx.qa("turn.forceFailure", { worldId: persona.worldId, customerId: persona.customerId });
        await sayScript(ctx, persona, 0);
        await ctx.eventually("HANDOFF_NOTICE after a failed turn", async () => sentKind(await ctx.snapshot(persona.worldId, persona.customerId), "HANDOFF_NOTICE").length > 0, WAITS.turnSec, 5);
      },
    },
    {
      n: 5,
      title: "event.poison → processError, the world quiet, the event in the QA DLQ within 10 minutes and its alarm; dlq.delete",
      flows: ["FL-108"],
      async run(ctx) {
        const persona = who(ctx, "a", "d");
        const { eventId } = (await ctx.qa("event.poison", { worldId: persona.worldId, customerId: persona.customerId })) as { eventId: string };
        ctx.state["poisonEvent"] = eventId;
        await ctx.eventually("the poisoned event in the QA dead letters", async () => ((await ctx.qa("dlq.find", { eventId })) as { found: boolean }).found, WAITS.dlqSec, 30);
        const snapshot = await ctx.settled(persona.worldId, persona.customerId);
        ctx.check(snapshot.processError !== null, "the conversation records no processError");
        const alarms = (await ctx.qa("alarm.history", {})) as { items: readonly unknown[] };
        ctx.check(alarms.items.length > 0, "no alarm history for the dead letter");
        ctx.check(((await ctx.qa("dlq.delete", { eventId })) as { deleted: boolean }).deleted, "the dead letter was not deleted");
      },
    },
    {
      n: 6,
      title: "guardrail.probe → GUARDRAIL_INTERVENED",
      flows: [],
      async run(ctx) {
        const probe = (await ctx.qa("guardrail.probe", {})) as { intervened: boolean; policy?: string };
        ctx.check(probe.intervened, "G1 let a known attack through");
        ctx.blocked("HARNESS_G1", probe.policy ?? "BLOCKED");
      },
    },
    {
      n: 7,
      title: "kill.setWorld(on): a complaint gets its number and acknowledgement by rule, no turn, HANDOFF_NOTICE; off → the next message has a turn",
      flows: ["FL-109"],
      async run(ctx) {
        const persona = who(ctx, "a", "d");
        await ctx.qa("kill.setWorld", { worldId: persona.worldId, on: true });
        const before = await ctx.settled(persona.worldId, persona.customerId);
        const filed = keepComplaint(ctx, "kill", await fileByScript(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
        const during = await ctx.settled(persona.worldId, persona.customerId);
        ctx.check(during.turnsToday === before.turnsToday, `${during.turnsToday - before.turnsToday} turn(s) ran with the agent cut`);
        ctx.check(sentKind(during, "HANDOFF_NOTICE").length > sentKind(before, "HANDOFF_NOTICE").length, "no HANDOFF_NOTICE with the agent cut");
        ctx.note("killedComplaint", filed);
        ctx.warn("the AgentKilled metric is read post-deploy, not by the runner");
        await ctx.qa("kill.setWorld", { worldId: persona.worldId, on: false });
        await say(ctx, persona, { type: "text", text: "¿Hay novedades de mi reclamo?" });
        await ctx.eventually("a turn after the cut is lifted", async () => (await ctx.snapshot(persona.worldId, persona.customerId)).turnsToday > during.turnsToday, WAITS.turnSec, 5);
      },
    },
    {
      n: 8,
      title: "caps.prime(GLOBALCAP_QA) at the cap → TURN_CAP of the QA pool without invoking the Harness",
      flows: ["FL-105"],
      async run(ctx) {
        const persona = who(ctx, "a", "b");
        await ctx.qa("caps.prime", { bucket: "GLOBALCAP_QA", value: 100_000, window: "DAY" });
        try {
          await noTurn(ctx, persona, "¿Me pasan el detalle de la cuota?", "the QA pool past its global cap");
        } finally {
          await ctx.qa("caps.prime", { bucket: "GLOBALCAP_QA", value: 0, window: "DAY" });
        }
      },
    },
    {
      n: 9,
      title: "turn.forceSilence: NO_OUTBOUND → HOLDING_NOTICE; SKIP_ANSWER on C04 → RESOLVED without an answer → ANSWER_DUE → ANSWERED",
      flows: ["FL-107"],
      async run(ctx) {
        const silent = who(ctx, "a", "b");
        await ctx.qa("turn.forceSilence", { worldId: silent.worldId, customerId: silent.customerId, mode: "NO_OUTBOUND" });
        const holding = sentKind(await ctx.settled(silent.worldId, silent.customerId), "HOLDING_NOTICE").length;
        await say(ctx, silent, { type: "text", text: "¿Me confirman cuánto me queda?" });
        await ctx.eventually("HOLDING_NOTICE after a silent turn", async () => sentKind(await ctx.snapshot(silent.worldId, silent.customerId), "HOLDING_NOTICE").length > holding, WAITS.turnSec, 5);
        const skipping = who(ctx, "b", "b");
        await ctx.settled(skipping.worldId, skipping.customerId);
        await ctx.qa("turn.forceSilence", { worldId: skipping.worldId, customerId: skipping.customerId, mode: "SKIP_ANSWER" });
        const id = complaintIdOf(ctx, "dup");
        await sendReceipt(ctx, skipping);
        const done = await untilStatus(ctx, skipping, id, ["ANSWERED", "CLOSED", "HUMAN_REVIEW"], { timeoutSec: WAITS.turnSec * 3 });
        const status = done.complaints.find((view) => view.complaint?.complaintId === id)?.complaint?.status;
        ctx.check(status === "ANSWERED" || status === "CLOSED" || sentKind(done, "HANDOFF_NOTICE").length > 0, `the skipped answer ended ${status ?? "nowhere"} without the obligation`);
      },
    },
  ],
  async cleanup(ctx) {
    const eventId = ctx.state["poisonEvent"];
    if (typeof eventId === "string") await ctx.qa("dlq.delete", { eventId });
    await ctx.qa("caps.prime", { bucket: "GLOBALCAP_QA", value: 0, window: "DAY" });
    const killed = ctx.state["world:d"];
    if (killed !== undefined) await ctx.qa("kill.setWorld", { worldId: worldOf(ctx, "d").worldId, on: false });
  },
});
