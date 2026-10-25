// SC-21 · the guest's guided tour (docs/test-plan.md §4.5; the 5-minute block is the demo-critical cut,
// docs/build-plan.md §3). A world `qa-<runId>-sc21` of the `guest` template, a GUEST session of
// `auth.session` in `sessionStorage` and Playwright against https://reclamo.demo.craftech.io, following
// packages/web/src/views/tour/steps.ts literally: each button of the tour panel (or of the view a step
// opens) is tapped as soon as it is enabled, and the step's state is asserted on persisted state within
// the step's own budget. Before every step the session is re-issued when it is under 3 minutes from its
// `exp`, and always before steps 8 and 10 (approving and answering need a recent sign-in), injected
// without a reload; the request after it must carry the new token, and the recent-login prompt never
// opens. Steps 1 to 6 (the quick block) must take at most 5 minutes. Tour step 11 (the live clock, 30 real
// minutes of real schedules) is optional and not walked; SC-15/7 proves the Scheduler.
import type { Page } from "@playwright/test";
import { REROUTE_LABEL } from "@reclamo/bff/copy/block-reasons";
import { approvalsCopy } from "../../packages/web/src/views/approvals/copy";
import { complaintCopy } from "../../packages/web/src/views/complaint/copy";
import { customerCopy } from "../../packages/web/src/views/customer/copy";
import { TOUR_TEXTS } from "../../packages/web/src/views/tour/copy";
import { HUMAN_CASE, OPERATOR_COLLECTION_TEXT, TOUR_BLOCKS, TOUR_STEPS, type TourStepId, stepById } from "../../packages/web/src/views/tour/steps";
import { caseOf, consoleCall, evidenceDetails, itemsOf, latestResult, timelineOf } from "./lib/console";
import { cspViolations } from "./lib/edge";
import { mailOutcome } from "./lib/flows";
import { localDateAr, scriptMessage } from "./lib/personas";
import { SITE } from "./lib/site";
import { complaintById, latestComplaint, messages, SENT } from "./lib/snapshot";
import { type ScenarioContext, type StepDef, defineScenario, ensure } from "./lib/steps";
import { uniqueReceipt } from "./lib/upload";
import { createWorld, milestoneOf, worldOf } from "./lib/world";
import { tapeAll } from "./sc-14-channel-policy";
import { type ConsoleTab, browserOf, expectFreshToken, inPage, noInterruptions, openConsole, reissue } from "./sc-22-guest-world";

const es = TOUR_TEXTS.es;
/** SC-21's step → the tour step it walks (step 12 is the upload, which the tour leaves to the simulator). */
const WALK: Readonly<Record<number, TourStepId | undefined>> = { 1: "1", 2: "2", 3: "2b", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9", 11: "10", 12: undefined, 13: "12" };
const CUSTOMER = { C01: "cus-0001", C02: "cus-0002", C03: "cus-0003", C04: "cus-0004", C07: "cus-0007", C09: "cus-0009" } as const;
const QUICK_MS = TOUR_BLOCKS.QUICK.budgetSeconds * 1_000;
/** Real seconds the scan of an upload gets before the tap (lib/receipt-upload.ts SCAN_WAIT_SEC). */
const SCAN_HEAD_START_SEC = 70;

const tab = (ctx: ScenarioContext): ConsoleTab => {
  const found = ctx.state["tab"] as ConsoleTab | undefined;
  ensure(found !== undefined, "step 1 opened no console");
  return found;
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const card = (page: Page, id: TourStepId) => page.getByRole("article", { name: new RegExp(`^${escape(es.step(id))} · `) });
const budgetOf = (n: number): number => stepById(WALK[n] ?? "12").budgetSeconds;

/** The tour's panel, open; each step starts there. */
async function onTour(ctx: ScenarioContext): Promise<Page> {
  const { page } = tab(ctx);
  if (!page.url().endsWith("/app/tour")) await page.goto(`${SITE}/app/tour`, { waitUntil: "domcontentloaded" });
  await card(page, "1").waitFor({ timeout: 60_000 });
  return page;
}

/** Taps move `index` of the step's card as soon as it is enabled. */
async function tap(ctx: ScenarioContext, id: TourStepId, index: number): Promise<void> {
  const page = await onTour(ctx);
  const label = stepById(id).moves[index]?.label.es;
  ensure(label !== undefined, `tour step ${id} has no move ${index}`);
  const button = card(page, id).getByRole("button", { name: label, exact: true });
  await ctx.eventually(`"${label}" enabled`, () => button.isEnabled(), 300, 1);
  await button.click();
}

/** Re-issues the session when needed (always for `force`) and checks the next request carries it. */
async function session(ctx: ScenarioContext, force = false): Promise<() => Promise<void>> {
  const reissued = await reissue(ctx, tab(ctx), force);
  return async () => {
    if (reissued) await expectFreshToken(ctx, tab(ctx));
    await noInterruptions(ctx, tab(ctx));
  };
}

/** Polls the driver until `holds` answers something, within the step's budget (seconds). */
function within<T>(ctx: ScenarioContext, what: string, seconds: number, holds: () => Promise<T | undefined | false>): Promise<T> {
  return ctx.eventually(what, holds, seconds + 5, 1);
}

const worldId = (ctx: ScenarioContext) => worldOf(ctx).worldId;
const snap = (ctx: ScenarioContext, persona: keyof typeof CUSTOMER) => ctx.snapshot(worldId(ctx), CUSTOMER[persona]);
const latestOf = async (ctx: ScenarioContext, persona: keyof typeof CUSTOMER) => latestComplaint(await snap(ctx, persona));

/** The challenge's answer is tapped only once the challenge was asked (the move sends the text as is). */
async function answerChallenge(ctx: ScenarioContext, id: TourStepId, index: number, persona: keyof typeof CUSTOMER): Promise<void> {
  await ctx.eventually(`${persona}'s identity challenge`, async () => messages(await snap(ctx, persona), { direction: "OUT", kind: "IDENTITY_CHALLENGE", status: SENT }).length > 0, 180, 2);
  await tap(ctx, id, index);
}

/** A tour step: the session re-issued first (always before 8 and 10), the interruptions checked after. */
function guarded(def: StepDef): StepDef {
  return {
    ...def,
    async run(ctx) {
      const settle = await session(ctx, def.n === 8 || def.n === 10);
      await def.run(ctx);
      await settle();
    },
  };
}

export default defineScenario({
  id: "SC-21",
  slug: "sc21",
  title: "Guest tour in the browser: the 5-minute block, the deep tour, upload and image evidence",
  suites: ["full"],
  lane: "guest",
  laneOrder: 2,
  steps: [
    {
      n: 1,
      title: "the console opens in the guest's own world, pristine",
      flows: ["FL-094"],
      async run(ctx) {
        ctx.check(TOUR_STEPS.every((tourStep) => tourStep.optional === true || Object.values(WALK).includes(tourStep.id)), "a mandatory tour step is not walked");
        const world = await createWorld(ctx, { template: "guest" });
        ctx.state["quickStarted"] = ctx.now();
        ctx.state["tab"] = await openConsole(ctx, await browserOf(ctx), world.worldId, "sc21-guest", "GUEST", "/app/tour");
        const page = await onTour(ctx);
        await page.getByText(es.pristineOk("mié 07/10 10:10")).waitFor({ timeout: 30_000 });
        await tap(ctx, "1", 0);
        await page.waitForURL("**/app/clock", { timeout: 15_000 });
        await noInterruptions(ctx, tab(ctx));
      },
    },
    guarded({
      n: 2,
      title: "C01's script message and receipt → number, deadline and the automated-assistant line within 10 s",
      flows: ["FL-001", "FL-010", "FL-101"],
      async run(ctx) {
        const sent = ctx.now();
        await tap(ctx, "2", 0);
        const view = await within(ctx, "C01's acknowledgement", budgetOf(2), async () => {
          const snapshot = await snap(ctx, "C01");
          return messages(snapshot, { direction: "OUT", kind: "COMPLAINT_ACK", status: SENT }).length > 0 ? latestComplaint(snapshot) : undefined;
        });
        ctx.measure("ackLatencyMs", ctx.now() - sent);
        ctx.state["mainStory"] = view.complaint.complaintId;
        const first = itemsOf(await timelineOf(ctx, worldId(ctx), view.complaint.complaintId), "MESSAGE").find((item) => item.direction === "OUT");
        ctx.check(first?.disclosure === true, "the first outbound message has no automated-assistant line");
        await card(await onTour(ctx), "2").getByText(view.complaint.complaintNumber, { exact: false }).first().waitFor({ timeout: 15_000 });
      },
    }),
    guarded({
      n: 3,
      title: "C09's file: \"Recordatorio de mora\" by WhatsApp → BLOCKED in red → the formal email → ALLOWED at Wed 07/10 10:1x",
      flows: ["FL-064", "FL-065"],
      async run(ctx) {
        await tap(ctx, "2b", 0);
        const { page } = tab(ctx);
        const composer = page.getByRole("region", { name: customerCopy.sections.composer });
        await composer.getByLabel(customerCopy.composer.kind).selectOption("COLLECTION_REMINDER");
        await composer.getByLabel(customerCopy.composer.channel).selectOption("WHATSAPP");
        await composer.getByRole("button", { name: customerCopy.composer.send }).click();
        const trail = page.getByRole("region", { name: customerCopy.trail.title });
        const toEmail = trail.getByRole("button", { name: new RegExp(`^${escape(REROUTE_LABEL.FORMAL_EMAIL)}`) });
        await toEmail.waitFor({ timeout: budgetOf(3) * 1_000 });
        await toEmail.click();
        const child = await within(ctx, "the formal email ALLOWED", budgetOf(3), async () => {
          const all = await tapeAll(ctx, worldId(ctx));
          const blocked = all.find((entry) => entry.kind === "COLLECTION_REMINDER" && entry.decision === "BLOCKED" && entry.ruleIds.includes("CH-WA-NO-COLLECTION"));
          return blocked && all.find((entry) => entry.rerouteOf === blocked.tapeId && entry.decision === "ALLOWED");
        });
        ctx.check(child.kind === "COLLECTION_NOTICE_EMAIL", `the reroute's child is ${child.kind}`);
        const clock = await consoleCall(ctx, "clock", "get", undefined, { worldId: worldId(ctx), role: "GUEST" });
        ctx.check(localDateAr(clock.simNow) === "2026-10-07", `the clock is at ${clock.simNow}, expected Wed 07/10`);
      },
    }),
    guarded({
      n: 4,
      title: "accept the email and answer the challenge → acknowledgement and formal notice DELIVERED, the reading on the case, the batch pending",
      flows: ["FL-003"],
      async run(ctx) {
        await tap(ctx, "3", 0);
        await answerChallenge(ctx, "3", 1, "C01");
        const id = String(ctx.state["mainStory"]);
        await within(ctx, "C01 AWAITING_SETTLEMENT with its reading", budgetOf(4), async () => complaintById(await snap(ctx, "C01"), id)?.complaint.status === "AWAITING_SETTLEMENT");
        const view = await caseOf(ctx, worldId(ctx), id);
        ctx.check(evidenceDetails(view, "RECEIPT_READING").length > 0 && latestResult(view, "SETTLEMENT_MATCH") === "PENDING_BATCH", "no reading or no pending batch on the case");
        const mails = (await ctx.snapshot(worldId(ctx))).emails.filter((mail) => mail.kind === "ACK_EMAIL" || mail.kind === "COLLECTION_NOTICE_EMAIL");
        ctx.check(mails.length >= 2, `${mails.length} of the two mails were written`);
        for (const mail of mails) await mailOutcome(ctx, worldId(ctx), mail.mailId);
        await tap(ctx, "3", 2);
      },
    }),
    guarded({
      n: 5,
      title: "ONE \"Avanzar al próximo evento\" → settlement, payment applied, written answer with its proof",
      flows: ["FL-017"],
      async run(ctx) {
        await tap(ctx, "4", 0);
        const id = String(ctx.state["mainStory"]);
        await within(ctx, "C01 ANSWERED", budgetOf(5), async () => ["ANSWERED", "CLOSED"].includes(complaintById(await snap(ctx, "C01"), id)?.complaint.status ?? ""));
        const view = await caseOf(ctx, worldId(ctx), id);
        ctx.check(view.actions.filter((action) => action.kind === "APPLY_PAYMENT" && action.status === "EXECUTED").length === 1, "the payment was not applied exactly once");
        const mailId = view.complaint.answer?.mailId;
        ensure(mailId !== undefined, "the answer has no mail");
        await mailOutcome(ctx, worldId(ctx), mailId);
      },
    }),
    guarded({
      n: 6,
      title: "Metrics; the quick block within 5 minutes",
      flows: ["FL-098"],
      async run(ctx) {
        await tap(ctx, "5", 0);
        await tab(ctx).page.waitForURL("**/app/metrics", { timeout: 15_000 });
        const metrics = (await ctx.qa("metrics.get", { worldId: worldId(ctx) })) as { n: number };
        ctx.check(metrics.n >= 1, "the metrics measure none of the guest's complaints");
        const elapsed = ctx.now() - Number(ctx.state["quickStarted"]);
        ctx.measure("quickBlockMs", elapsed);
        ctx.check(elapsed <= QUICK_MS, `the 5-minute block took ${Math.round(elapsed / 1_000)} s`);
      },
    }),
    guarded({
      n: 7,
      title: "C02 → the charge reversed with a credit note",
      flows: ["FL-033"],
      async run(ctx) {
        for (const index of [0, 1]) await tap(ctx, "6", index);
        await answerChallenge(ctx, "6", 2, "C02");
        const view = await within(ctx, "C02 ANSWERED", budgetOf(7), async () => {
          const latest = await latestOf(ctx, "C02");
          return latest !== undefined && ["ANSWERED", "CLOSED"].includes(latest.complaint.status) ? latest : undefined;
        });
        ctx.check(view.actions.some((action) => action.kind === "REVERSE_CHARGE" && action.status === "EXECUTED"), "the charge was not reversed");
        const attached = itemsOf(await timelineOf(ctx, worldId(ctx), view.complaint.complaintId), "EMAIL").flatMap((mail) => mail.attachments.map((item) => item.docKind));
        ctx.check(attached.includes("CREDIT_NOTE"), "the answer carries no credit note");
      },
    }),
    guarded({
      n: 8,
      title: "C03 → \"Aprobar\" in Approvals (recent sign-in, no prompt) → the refund executed once",
      flows: ["FL-038"],
      async run(ctx) {
        for (const index of [0, 1]) await tap(ctx, "7", index);
        await answerChallenge(ctx, "7", 2, "C03");
        const pending = await within(ctx, "C03 AWAITING_APPROVAL", budgetOf(8), async () => {
          const latest = await latestOf(ctx, "C03");
          return latest?.complaint.status === "AWAITING_APPROVAL" ? latest : undefined;
        });
        await tap(ctx, "7", 3);
        const row = tab(ctx).page.getByRole("table", { name: approvalsCopy.caption }).getByRole("row").filter({ hasText: pending.complaint.complaintNumber });
        await row.getByRole("button", { name: approvalsCopy.approve }).click();
        await within(ctx, "the refund executed", budgetOf(8), async () => (await latestOf(ctx, "C03"))?.actions.some((action) => action.kind === "REFUND_DUPLICATE" && action.status === "EXECUTED"));
        const view = await ctx.quietRead(worldId(ctx), () => caseOf(ctx, worldId(ctx), pending.complaint.complaintId));
        ctx.exactly(view, 1, "refunds executed", view.actions.filter((action) => action.kind === "REFUND_DUPLICATE" && action.status === "EXECUTED"));
      },
    }),
    guarded({
      n: 9,
      title: "C09 taken: the operator's collection text → BLOCKED by the lexicon",
      flows: ["FL-067"],
      async run(ctx) {
        await tap(ctx, "8", 0);
        const taken = await inPage(tab(ctx), "conversation.take", { customerId: CUSTOMER.C09 }, "POST");
        ctx.check(taken.status === 200, `taking C09's conversation answered ${taken.status}`);
        ctx.warn("the customer file has no take-over button (views/customer): the take goes through the same /api/conversation.take");
        const composer = tab(ctx).page.getByRole("region", { name: customerCopy.sections.composer });
        await composer.getByLabel(customerCopy.composer.kind).selectOption("OPERATOR_MESSAGE");
        await composer.getByLabel(customerCopy.composer.channel).selectOption("WHATSAPP");
        await composer.getByRole("textbox", { name: customerCopy.composer.text, exact: true }).fill(OPERATOR_COLLECTION_TEXT);
        await composer.getByRole("button", { name: customerCopy.composer.send }).click();
        const blocked = await within(ctx, "the collection text BLOCKED", budgetOf(9), async () => (await tapeAll(ctx, worldId(ctx))).find((entry) => entry.kind === "OPERATOR_MESSAGE" && entry.decision === "BLOCKED"));
        ctx.check(blocked.ruleIds.includes("CH-WA-NO-COLLECTION") && (blocked.collectionCategories ?? []).length > 0, `the text was blocked by ${blocked.ruleIds.join(", ")}`);
      },
    }),
    guarded({
      n: 10,
      title: "C07 → a human case on 08/10; two \"next milestone\" moves → 16/10 and 21/10; the operator's written answer cancels the rest",
      flows: ["FL-089"],
      async run(ctx) {
        for (const index of [0, 1]) await tap(ctx, "9", index);
        await answerChallenge(ctx, "9", 2, "C07");
        const human = await within(ctx, "C07 HUMAN_REVIEW", budgetOf(10), async () => {
          const latest = await latestOf(ctx, "C07");
          return latest?.complaint.status === "HUMAN_REVIEW" ? latest : undefined;
        });
        const id = human.complaint.complaintId;
        ctx.check(localDateAr(human.complaint.filedAtSim) === localDateAr(HUMAN_CASE.filedSim), `the human case was filed ${human.complaint.filedAtSim}`);
        for (const [index, milestone, at] of [[3, "OPERATOR_REMINDER", HUMAN_CASE.reminderSim], [4, "SUPERVISOR_ESCALATION", HUMAN_CASE.escalationSim]] as const) {
          await tap(ctx, "9", index);
          const fired = await within(ctx, `${milestone} fired`, budgetOf(10), async () => {
            const item = await milestoneOf(ctx, worldId(ctx), id, milestone);
            return item?.status === "FIRED" ? item : undefined;
          });
          ctx.check(Date.parse(fired.atSim) === Date.parse(at), `${milestone} was due ${fired.atSim}, expected ${at}`);
        }
        await tap(ctx, "9", 5);
        const answer = tab(ctx).page.getByRole("region", { name: complaintCopy.sections.answer });
        const draft = answer.getByRole("textbox", { name: new RegExp(complaintCopy.answer.draft) });
        if ((await draft.inputValue()).trim() === "") await draft.fill("Revisamos tu reclamo con el comprobante que mandaste: no figura en la rendición de la red, así que no podemos imputarlo. Si tenés el comprobante original, respondé este mensaje.");
        await answer.getByRole("button", { name: complaintCopy.answer.open }).click();
        await within(ctx, "C07 ANSWERED, the deadline cancelled", budgetOf(10), async () => (await milestoneOf(ctx, worldId(ctx), id, "DEADLINE"))?.status === "CANCELLED");
      },
    }),
    guarded({
      n: 11,
      title: "Register → Export → the chain verified",
      flows: ["FL-096"],
      async run(ctx) {
        await tap(ctx, "10", 0);
        await tap(ctx, "10", 1);
        const verified = await consoleCall(ctx, "register", "verify", undefined, { worldId: worldId(ctx), role: "GUEST" });
        ctx.check(verified.result === "ok", `the register verifies ${verified.result}`);
      },
    }),
    guarded({
      n: 12,
      title: "the receipt image on the case without CSP violations; a PNG uploaded by presigned POST on the real domain becomes RECEIPT_IMAGE and is read in time",
      flows: ["FL-101"],
      async run(ctx) {
        const { page } = tab(ctx);
        const violations = await cspViolations(page, async () => {
          await page.goto(`${SITE}/app/complaints/${String(ctx.state["mainStory"])}`, { waitUntil: "domcontentloaded" });
          const image = page.getByRole("img", { name: complaintCopy.evidence.imageAlt }).first();
          await image.waitFor({ timeout: 30_000 });
          await ctx.eventually("the receipt image loaded", () => image.evaluate((node) => (node as unknown as { naturalWidth: number }).naturalWidth > 0), 30, 1);
        });
        ctx.check(violations.length === 0, `CSP violations on the case: ${violations.join(" | ")}`);
        const bytes = uniqueReceipt("legible", "C04", ctx.runId);
        const presigned = await inPage(tab(ctx), "simulator.presignReceipt", { persona: "C04", contentType: "image/png", sizeBytes: bytes.length }, "POST");
        const post = (JSON.parse(presigned.body) as { result: { data: { url: string; fields: Record<string, string>; key: string } } }).result.data;
        const uploaded = await page.evaluate(async ({ url, fields, data }) => {
          const form = new FormData();
          for (const [name, value] of Object.entries(fields)) form.append(name, value);
          form.append("file", new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], { type: "image/png" }), "receipt.png");
          return (await fetch(url, { method: "POST", body: form })).status;
        }, { url: post.url, fields: post.fields, data: bytes.toString("base64") });
        ctx.check(uploaded >= 200 && uploaded < 300, `the presigned POST from the page answered ${uploaded}`);
        const since = ctx.now();
        await ctx.eventually("the scan's head start", async () => ctx.now() - since >= SCAN_HEAD_START_SEC * 1_000, SCAN_HEAD_START_SEC + 5, 5);
        const sentAt = ctx.now();
        await inPage(tab(ctx), "simulator.attachReceipt", { persona: "C04", source: { kind: "UPLOAD", key: post.key }, caption: scriptMessage("C04").text }, "POST");
        const read = await ctx.eventually("RECEIPT_READING of the upload", async () => {
          const latest = await latestOf(ctx, "C04");
          return latest === undefined ? undefined : evidenceDetails(await caseOf(ctx, worldId(ctx), latest.complaint.complaintId), "RECEIPT_READING").at(-1);
        }, 32, 1);
        const readAt = Date.parse(String(read["readAtReal"]));
        ctx.measure("readAfterSendMs", readAt - sentAt);
        ctx.check(readAt - sentAt <= 12_000, `the reading landed ${readAt - sentAt} ms after the send (cap 12 s)`);
      },
    }),
    guarded({
      n: 13,
      title: "Metrics: every KPI with its N, source and label",
      flows: ["FL-098"],
      async run(ctx) {
        await tap(ctx, "12", 0);
        await tab(ctx).page.waitForURL("**/app/metrics", { timeout: 15_000 });
        const metrics = (await ctx.qa("metrics.get", { worldId: worldId(ctx) })) as { n: number; kpis: ReadonlyArray<{ label?: string; source?: string }> };
        ctx.check(metrics.n >= 4 && metrics.kpis.every((kpi) => kpi.label !== undefined && kpi.source !== undefined), `metrics with N ${metrics.n} and ${metrics.kpis.length} KPI(s) without label or source`);
      },
    }),
  ],
  async cleanup(ctx) {
    const found = ctx.state["tab"] as ConsoleTab | undefined;
    await found?.context.browser()?.close();
  },
});
