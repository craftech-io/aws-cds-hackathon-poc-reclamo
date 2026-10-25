// SC-01 · the main story (docs/test-plan.md §4.5; demo-critical cut, docs/build-plan.md §3). A clone of
// C01 paid instalment 4 at the Red de cobro Norte on Tue 06/10 18:40, after the cut-off: the batch
// `NORTE 2026-10-07` is published on Thu 08/10 08:30. Wed 07/10 10:10: the number on the spot, the
// acknowledgement by email, the identity challenge, the receipt read by Bedrock and reconciled
// `PENDING_BATCH`, ONE "advance to the next event" that publishes the batch and reconciles in the same
// move, the payment applied once and the written answer delivered. Model-dependent steps follow the
// oracles of §4.3; everything is asserted on persisted state.
import { expectDeliveryProof, expectMilestones, expectNoMaxTokens, expectRegister, expectWrittenAnswer } from "./lib/answers";
import { type AutopilotProgress, newProgress } from "./lib/autopilot";
import { caseOf, consoleCall, evidenceDetails, itemsOf, latestResult, timelineOf } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { type Persona, fileByScript, mailOutcome, mailsOf, noCollectionOnWhatsApp, personaIn, say, sendReceipt, sentKind, until, untilStatus } from "./lib/flows";
import { localDateAr } from "./lib/personas";
import { complaintOwner, timersOf } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const FIRST_NUMBER = "R-2026-000001";
const DEADLINE_DATE = "2026-10-22";
const NORTE_BATCH = "BATCH#NORTE#2026-10-07";
const PUBLICATION = "2026-10-08T08:30:00-03:00";
/** Instalment 4 of L-0001 (docs/seed-spec.md §8). */
const INSTALMENT_CENTS = 11_864_000;

const persona = (ctx: ScenarioContext): Persona => personaIn(ctx, worldOf(ctx), "a");
const complaintId = (ctx: ScenarioContext): string => {
  const id = ctx.state["complaintId"];
  ensure(typeof id === "string", "step 2 filed no complaint");
  return id;
};
const progress = (ctx: ScenarioContext): AutopilotProgress => (ctx.state["autopilot"] ??= newProgress()) as AutopilotProgress;

export default defineScenario({
  id: "SC-01",
  slug: "sc01",
  title: "Main story: payment not reflected, batch pending",
  suites: ["full"],
  steps: [
    {
      n: 1,
      title: "world.create: a clone of C01, clock paused on Wed 07/10 10:10",
      flows: [],
      async run(ctx) {
        ctx.state["startedAt"] = ctx.now();
        const world = await createWorld(ctx, { personas: [{ key: "a", model: "C01" }] });
        const snapshot = await ctx.snapshot(world.worldId);
        ctx.check(snapshot.clock.mode === "PAUSED" && snapshot.clock.pausedSimNow !== null && Date.parse(snapshot.clock.pausedSimNow) === Date.parse("2026-10-07T10:10:00-03:00"), `the world starts at ${snapshot.clock.pausedSimNow}, expected Wed 07/10 10:10 paused`);
      },
    },
    {
      n: 2,
      title: "text and receipt: the number on the spot, deadline Thu 22/10, three milestones, the automation disclosure",
      flows: ["FL-010", "FL-076"],
      async run(ctx) {
        const filed = await fileByScript(ctx, persona(ctx), 0, "PAYMENT_NOT_REFLECTED");
        ctx.state["complaintId"] = filed.complaint.complaintId;
        ctx.check(filed.complaint.complaintNumber === FIRST_NUMBER, `the first complaint of the QA world is ${filed.complaint.complaintNumber}, expected ${FIRST_NUMBER}`);
        ctx.check(localDateAr(filed.complaint.deadlineSim) === DEADLINE_DATE, `deadline ${filed.complaint.deadlineSim}, expected Thu 22/10 (10 business days, 12/10 is a holiday)`);
        ctx.check(timersOf(filed.snapshot, "SLA", complaintOwner(filed.complaint.complaintId)).length === 3, "three milestones SCHEDULED at filing");
        const timeline = await timelineOf(ctx, persona(ctx).worldId, filed.complaint.complaintId);
        expectMilestones(ctx, timeline, "SCHEDULED");
        const firstOut = itemsOf(timeline, "MESSAGE").find((item) => item.direction === "OUT");
        ctx.check(firstOut?.kind === "COMPLAINT_ACK" && firstOut.disclosure, "the acknowledgement is the first outbound message and carries the automation disclosure");
        await sendReceipt(ctx, persona(ctx));
      },
    },
    {
      n: 3,
      title: "\"Sí, a ese email\": ACK_EMAIL with the acknowledgement PDF, DELIVERED by the SES mailbox simulator",
      flows: ["FL-011", "FL-090"],
      async run(ctx) {
        const who = persona(ctx);
        await say(ctx, who, { type: "button", action: "ACCEPT_EMAIL" });
        const snapshot = await ctx.eventually("ACK_EMAIL written", async () => {
          const fresh = await ctx.snapshot(who.worldId, who.customerId);
          return mailsOf(fresh, "ACK_EMAIL", who.customerId).length > 0 ? fresh : undefined;
        }, 60, 3);
        const mail = mailsOf(snapshot, "ACK_EMAIL", who.customerId)[0];
        ensure(mail !== undefined, "no ACK_EMAIL");
        const timeline = await timelineOf(ctx, who.worldId, complaintId(ctx));
        const item = itemsOf(timeline, "EMAIL").find((email) => email.mailId === mail.mailId);
        ctx.check(item?.attachments.some((attachment) => attachment.docKind === "ACK") === true, "ACK_EMAIL carries the acknowledgement PDF");
        ctx.check(itemsOf(timeline, "REGISTER").some((entry) => entry.eventType === "FILED"), "the PDF's FILED entry is in the register");
        await mailOutcome(ctx, who.worldId, mail.mailId);
        const view = await caseOf(ctx, who.worldId, complaintId(ctx));
        ctx.check(view.complaint.emailAnswerConsent.status === "ACCEPTED", `email consent ${view.complaint.emailAnswerConsent.status}`);
      },
    },
    {
      n: 4,
      title: "the identity challenge answered by the autopilot with the persona's truth: identified",
      flows: ["FL-003"],
      async run(ctx) {
        const who = persona(ctx);
        const snapshot = await until(ctx, who, "identified", (fresh) => {
          const until = (fresh.conversation as { identifiedUntilReal?: string } | null)?.identifiedUntilReal;
          return until !== undefined && Date.parse(until) > ctx.now();
        }, { progress: progress(ctx) });
        ctx.check(progress(ctx).answered.size >= 1, "the identification came with an answer of the autopilot");
        ctx.note("identified", String(snapshot.conversation !== null));
      },
    },
    {
      n: 5,
      title: "read_receipt (real Bedrock) reads it, reconcile_payment PENDING_BATCH: AWAITING_SETTLEMENT with its recheck",
      flows: ["FL-017"],
      async run(ctx) {
        const who = persona(ctx);
        const snapshot = await untilStatus(ctx, who, complaintId(ctx), ["AWAITING_SETTLEMENT"], { progress: progress(ctx), timeoutSec: WAITS.turnSec * 2 });
        const view = await caseOf(ctx, who.worldId, complaintId(ctx));
        const reading = evidenceDetails(view, "RECEIPT_READING").at(-1);
        ctx.check(reading?.["result"] === "READ" && reading["disagreement"] === undefined, `the receipt reading is ${String(reading?.["result"])}, expected READ with both readers agreeing`);
        ctx.check(reading?.["source"] === "BEDROCK", `the receipt was read by ${String(reading?.["source"])}, expected BEDROCK`);
        ctx.check(latestResult(view, "SETTLEMENT_MATCH") === "PENDING_BATCH", `reconciliation ${latestResult(view, "SETTLEMENT_MATCH")}, expected PENDING_BATCH`);
        const recheck = timersOf(snapshot, "SETTLEMENT_RECHECK", NORTE_BATCH);
        ctx.check(recheck.length >= 1, `no SETTLEMENT_RECHECK owned by ${NORTE_BATCH}`);
        ctx.state["recheck"] = recheck.map((timer) => timer.timerId);
      },
    },
    {
      n: 6,
      title: "ONE clock.advanceToNext → Thu 08/10 08:30: the batch is published, the recheck fires by PUBLICATION, MATCHED, the payment applied once",
      flows: ["FL-017"],
      async run(ctx) {
        const who = persona(ctx);
        await ctx.settled(who.worldId);
        const moved = (await ctx.qa("clock.advanceToNext", { worldId: who.worldId })) as { simNow: string; fired: ReadonlyArray<{ kind: string; timerId: string }> };
        ctx.check(Date.parse(moved.simNow) === Date.parse(PUBLICATION), `the next event is at ${moved.simNow}, expected the NORTE publication on Thu 08/10 08:30`);
        const rechecks = (ctx.state["recheck"] as string[] | undefined) ?? [];
        ctx.check(!moved.fired.some((timer) => timer.kind === "SETTLEMENT_RECHECK" && rechecks.includes(timer.timerId)), "the recheck was fired by the clock, expected by the publication in the same move");
        await untilStatus(ctx, who, complaintId(ctx), ["RESOLVED", "ANSWERED", "CLOSED"], { progress: progress(ctx), timeoutSec: WAITS.turnSec * 2 });
        const after = await ctx.settled(who.worldId, who.customerId);
        ctx.none(after, "pending rechecks of the published batch", timersOf(after, "SETTLEMENT_RECHECK", NORTE_BATCH));
        const view = await caseOf(ctx, who.worldId, complaintId(ctx));
        ctx.check(latestResult(view, "SETTLEMENT_MATCH") === "MATCHED", `reconciliation ${latestResult(view, "SETTLEMENT_MATCH")}, expected MATCHED`);
        const applied = view.actions.filter((action) => action.kind === "APPLY_PAYMENT");
        ctx.exactly(after, 1, "payments applied", applied.filter((action) => action.status === "EXECUTED"));
        ctx.check(applied[0]?.amountCents === INSTALMENT_CENTS, `applied ${applied[0]?.amountCents} cents, expected the batch line's ${INSTALMENT_CENTS}`);
        ctx.check(applied[0]?.claimKey?.startsWith("OPC#") === true, "the payment took its OPC# claim in the core");
      },
    },
    {
      n: 7,
      title: "RESOLUTION_NOTICE and the written answer with STATEMENT, DELIVERED: ANSWERED, milestones CANCELLED, no max_tokens",
      flows: ["FL-017", "FL-080"],
      async run(ctx) {
        const who = persona(ctx);
        const answered = await expectWrittenAnswer(ctx, who, complaintId(ctx), { attachments: ["STATEMENT"], progress: progress(ctx) });
        const snapshot = await ctx.settled(who.worldId, who.customerId);
        ctx.check(sentKind(snapshot, ["RESOLUTION_NOTICE", "COMPLAINT_UPDATE"], "WHATSAPP").length >= 1, "no RESOLUTION_NOTICE on WhatsApp");
        noCollectionOnWhatsApp(ctx, snapshot);
        const timeline = await expectDeliveryProof(ctx, who, complaintId(ctx));
        expectMilestones(ctx, timeline, "CANCELLED");
        ctx.check(answered.view.complaint.outcome === "IN_FAVOUR", `outcome ${answered.view.complaint.outcome}, expected IN_FAVOUR`);
        await expectNoMaxTokens(ctx, (ctx.state["startedAt"] as number | undefined) ?? ctx.now() - 3_600_000);
      },
    },
    {
      n: 8,
      title: "the console's view: complaints.get, complaints.timeline and inbox.list by createCaller agree; the register verifies",
      flows: ["FL-097"],
      async run(ctx) {
        const who = persona(ctx);
        const id = complaintId(ctx);
        const view = await caseOf(ctx, who.worldId, id);
        const timeline = await timelineOf(ctx, who.worldId, id);
        const inbox = await consoleCall(ctx, "inbox", "list", { includeClosed: true }, { worldId: who.worldId });
        const row = inbox.items.find((item) => item.complaintId === id);
        ctx.check(row !== undefined && row.status === view.complaint.status, `inbox.list shows ${row?.status ?? "nothing"} for ${view.complaint.complaintNumber}, the case says ${view.complaint.status}`);
        ctx.check(timeline.complaintNumber === view.complaint.complaintNumber, "the timeline belongs to the same complaint");
        expectRegister(ctx, timeline, ["FILED", "STATUS", "FINAL_ANSWER", "DELIVERY_PROOF"]);
        const verified = await consoleCall(ctx, "register", "verify", undefined, { worldId: who.worldId, role: "COMPLIANCE" });
        ctx.check(verified.result === "ok", `register.verify answered ${verified.result}`);
      },
    },
    {
      n: 9,
      title: "policy audit of the world: 0 violations",
      flows: ["FL-075"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        await ctx.settled(worldId);
        const audit = (await ctx.qa("policyAudit.run", { worldId })) as { violations: readonly unknown[] };
        ctx.check(audit.violations.length === 0, `${audit.violations.length} policy violation(s)`);
      },
    },
  ],
});
