// SC-15 · the regulatory clock (docs/test-plan.md §4.5). Three clones of C07 (a fake receipt: a human case),
// one per world since a model is cloned once per world, filed on Wed 07/10 10:10: the deadline of ten
// business days (Mon 12/10 a holiday) is Thu 22/10 and three milestones are scheduled at filing. The
// reminder (business day 5) is a note for the operator, never a message to the customer; the escalation
// (day 8) flags the case at risk; the operator's written answer cancels what is left, and a late fire of
// a cancelled milestone is discarded; the third clone proves the real Scheduler with the clock compressed.
import { MILESTONES, expectMilestones } from "./lib/answers";
import { caseOf, consoleCall, timelineOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { type Persona, complaintIdOf, fileByScript, keepComplaint, personaIn, sendReceipt, untilStatus } from "./lib/flows";
import { localDateAr } from "./lib/personas";
import { complaintById, complaintOwner, messages, timerKeyOf, timersOf } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { advanceTo, createWorld, milestoneOf, schedulerProbe, worldOf } from "./lib/world";

const DEADLINE_DATE = "2026-10-22";
const REMINDER_SIM = "2026-10-15T10:00:00-03:00";
const ESCALATION_SIM = "2026-10-20T10:00:00-03:00";
const DEADLINE_END = "2026-10-22T23:59:59-03:00";
const ANSWER_DRAFT = "Revisamos tu reclamo con el comprobante que nos mandaste y no encontramos el pago en la rendición de la red. Te pedimos que nos acerques el comprobante original para revisarlo de nuevo.";

const who = (ctx: ScenarioContext, suffix = "main"): Persona => personaIn(ctx, worldOf(ctx, suffix), "a");

/** C07 files with its receipt and the case goes to a person (FL-020). */
async function fileHumanCase(ctx: ScenarioContext, suffix: string): Promise<string> {
  const persona = who(ctx, suffix);
  const id = keepComplaint(ctx, suffix, await fileByScript(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
  await sendReceipt(ctx, persona);
  await untilStatus(ctx, persona, id, ["HUMAN_REVIEW"], { timeoutSec: WAITS.turnSec * 2 });
  return id;
}

/** The world quiet, then the clock to the milestone's own due instant; the milestone fired by the clock. */
async function toMilestone(ctx: ScenarioContext, persona: Persona, complaintId: string, milestone: string, expectedSim: string): Promise<void> {
  const before = await milestoneOf(ctx, persona.worldId, complaintId, milestone);
  ensure(before?.status === "SCHEDULED", `${milestone} is ${before?.status ?? "missing"}, expected SCHEDULED`);
  ctx.check(Date.parse(before.atSim) === Date.parse(expectedSim), `${milestone} is due ${before.atSim}, expected ${expectedSim}`);
  await advanceTo(ctx, persona.worldId, before.atSim);
  const fired = await ctx.eventually(`${milestone} FIRED`, async () => {
    const item = await milestoneOf(ctx, persona.worldId, complaintId, milestone);
    return item?.status === "FIRED" ? item : undefined;
  }, 60, 3);
  ctx.check(fired.firedBy === "CLOCK", `${milestone} fired by ${fired.firedBy ?? "nobody"}, expected the clock`);
}

export default defineScenario({
  id: "SC-15",
  slug: "sc15",
  title: "Regulatory clock: deadline with holidays, reminder, escalation, answer, late fire, overdue, Scheduler, closure",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: three worlds with a clone of C07 each, clock paused on Wed 07/10 10:10",
      flows: [],
      async run(ctx) {
        for (const suffix of [undefined, "b", "c"]) await createWorld(ctx, { ...(suffix === undefined ? {} : { suffix }), personas: [{ key: "a", model: "C07" }] });
      },
    },
    {
      n: 1,
      title: "filing → deadline Thu 22/10 and three milestones SCHEDULED",
      flows: ["FL-076"],
      async run(ctx) {
        const persona = who(ctx);
        const id = await fileHumanCase(ctx, "main");
        const view = await caseOf(ctx, persona.worldId, id);
        ctx.check(localDateAr(view.complaint.deadlineSim) === DEADLINE_DATE, `deadline ${view.complaint.deadlineSim}, expected Thu 22/10`);
        const snapshot = await ctx.snapshot(persona.worldId);
        ctx.check(timersOf(snapshot, "SLA", complaintOwner(id)).length === MILESTONES.length, "three milestones SCHEDULED at filing");
        expectMilestones(ctx, await timelineOf(ctx, persona.worldId, id), "SCHEDULED");
      },
    },
    {
      n: 2,
      title: "advance → OPERATOR_REMINDER on Thu 15/10 10:00: a note for the operator, no message to the customer",
      flows: ["FL-077"],
      async run(ctx) {
        const persona = who(ctx);
        const id = complaintIdOf(ctx, "main");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        await toMilestone(ctx, persona, id, "OPERATOR_REMINDER", REMINDER_SIM);
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.exactly(after, messages(before, { direction: "OUT" }).length, "messages to the customer after the reminder", messages(after, { direction: "OUT" }));
        const inbox = await consoleCall(ctx, "inbox", "list", { includeClosed: true }, { worldId: persona.worldId });
        ctx.check(inbox.items.some((item) => item.complaintId === id), "the case is not in the operator's inbox");
      },
    },
    {
      n: 3,
      title: "advance → SUPERVISOR_ESCALATION on Tue 20/10 10:00 → AT_RISK",
      flows: ["FL-078"],
      async run(ctx) {
        const persona = who(ctx);
        const id = complaintIdOf(ctx, "main");
        await toMilestone(ctx, persona, id, "SUPERVISOR_ESCALATION", ESCALATION_SIM);
        const view = await ctx.eventually("AT_RISK", async () => {
          const fresh = await caseOf(ctx, persona.worldId, id);
          return fresh.complaint.slaState === "AT_RISK" ? fresh : undefined;
        }, 60, 3);
        ctx.note("slaState", view.complaint.slaState);
      },
    },
    {
      n: 4,
      title: "the OPERATOR answers in writing (recent sign-in) → ANSWERED, the milestones left CANCELLED",
      flows: ["FL-080", "FL-089"],
      async run(ctx) {
        const persona = who(ctx);
        const id = complaintIdOf(ctx, "main");
        await ctx.settled(persona.worldId);
        await consoleCall(ctx, "complaints", "answer", { complaintId: id, outcome: "NOT_IN_FAVOUR", draftBody: ANSWER_DRAFT }, { worldId: persona.worldId, signedInSecAgo: 0 });
        await untilStatus(ctx, persona, id, ["ANSWERED", "CLOSED"], { timeoutSec: WAITS.turnSec });
        const deadline = await ctx.eventually("DEADLINE CANCELLED", async () => {
          const item = await milestoneOf(ctx, persona.worldId, id, "DEADLINE");
          return item?.status === "CANCELLED" ? item : undefined;
        }, 60, 3);
        ctx.state["deadlineTimer"] = deadline.timerId;
      },
    },
    {
      n: 5,
      title: "schedule.fireStale(DEADLINE) → LATE_FIRE_DISCARDED (CANCELLED), no effect",
      flows: ["FL-081"],
      async run(ctx) {
        const persona = who(ctx);
        const id = complaintIdOf(ctx, "main");
        const timerId = ctx.state["deadlineTimer"];
        ensure(typeof timerId === "string", "step 4 found no DEADLINE milestone");
        const before = await ctx.settled(persona.worldId, persona.customerId);
        const fired = (await ctx.qa("schedule.fireStale", { worldId: persona.worldId, timerKey: timerKeyOf(persona.worldId, "SLA", timerId), version: 1, epoch: before.epoch })) as { status: string; reason?: string };
        ctx.check(fired.status === "LATE_FIRE_DISCARDED", `the stale fire answered ${fired.status} ${fired.reason ?? ""}`);
        ctx.note("discardReason", fired.reason ?? "");
        ctx.check((await milestoneOf(ctx, persona.worldId, id, "DEADLINE"))?.status === "CANCELLED", "the stale fire moved the DEADLINE");
        const after = await ctx.settled(persona.worldId, persona.customerId);
        ctx.exactly(after, before.messages.length, "messages after a discarded fire", after.messages);
      },
    },
    {
      n: 6,
      title: "the second clone unanswered → advance to Thu 22/10 23:59:59 → OVERDUE, counted in the metrics",
      flows: ["FL-079"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = await fileHumanCase(ctx, "b");
        await advanceTo(ctx, persona.worldId, DEADLINE_END);
        const view = await ctx.eventually("OVERDUE", async () => {
          const fresh = await caseOf(ctx, persona.worldId, id);
          return fresh.complaint.slaState === "OVERDUE" ? fresh : undefined;
        }, 90, 3);
        ctx.check((await milestoneOf(ctx, persona.worldId, id, "DEADLINE"))?.status === "FIRED", "the DEADLINE milestone did not fire");
        ctx.note("complaint-b", view.complaint.complaintNumber);
        const metrics = JSON.stringify(await ctx.qa("metrics.get", { worldId: persona.worldId }));
        if (!/overdue/i.test(metrics)) ctx.warn("metrics.get names no overdue measure");
      },
    },
    {
      n: 7,
      title: "the third clone: clock.unfreeze(OPERATOR_REMINDER, leadSec 120, rate 1440) → fired by the real SCHEDULER at its due instant → freeze",
      flows: ["FL-082"],
      async run(ctx) {
        const persona = who(ctx, "c");
        const id = await fileHumanCase(ctx, "c");
        await schedulerProbe(ctx, persona.worldId, id, "OPERATOR_REMINDER", 1440);
      },
    },
    {
      n: 8,
      title: "five business days after ANSWERED → CLOSED",
      flows: ["FL-083"],
      async run(ctx) {
        const persona = who(ctx);
        const id = complaintIdOf(ctx, "main");
        for (let day = 0; day < 5; day += 1) {
          await ctx.settled(persona.worldId);
          await ctx.qa("clock.advanceBusinessDay", { worldId: persona.worldId });
        }
        const closed = await ctx.eventually("CLOSED", async () => {
          const view = complaintById(await ctx.snapshot(persona.worldId, persona.customerId), id);
          return view?.complaint.status === "CLOSED" ? view : undefined;
        }, 60, 3);
        ctx.check(closed.complaint.statusHistory.at(-1)?.from === "ANSWERED", "the complaint was not closed from ANSWERED");
      },
    },
  ],
});
