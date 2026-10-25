// SC-03 · receipts (docs/test-plan.md §4.5). A receipt is hostile content: it is read by Bedrock with a
// forced schema and a deterministic fallback, and its reading never suffices to apply a payment (the
// settlement line does). Clones of C07 (invalid check digit), C16 (two blurry photos), C17 (a receipt
// already used in its open complaint), C18 (a valid-looking code missing from the published batch), C19
// (instructions printed on the image), C20 (not a receipt, plus server-built oversize and bad-magic
// variants), C04 (the fallback reader), C41 (another payer's valid receipt) and C01 (an eval image with a
// tampered chunk: the two readings disagree); step 10 runs in a world
// of the `guest` template, where the phone simulator uploads a new image and the scan resolves before
// the message is sent (`RESULT_FIRST`, demo-critical cut).
import { caseOf, consoleAttempt, evidenceDetails, latestResult } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { complaintIdOf, fileByScript, fileWithReceipt, keepComplaint, personaIn, progressOf, say, sendReceipt, sentKind, untilStatus, viewOf } from "./lib/flows";
import { scriptMessage } from "./lib/personas";
import { receiptStep } from "./lib/receipt-upload";
import { complaintsOf } from "./lib/snapshot";
import { type ScenarioContext, defineScenario } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const PERSONAS = [
  { key: "a", model: "C07" },
  { key: "b", model: "C16" },
  { key: "c", model: "C17" },
  { key: "d", model: "C18" },
  { key: "e", model: "C19" },
  { key: "f", model: "C20" },
  { key: "g", model: "C41" },
  { key: "h", model: "C04" },
  { key: "i", model: "C01" },
] as const;

/** An eval image whose code chunk was altered: Bedrock reads it CLEAR and the fallback parser disagrees. */
const TAMPERED = "receipts/tampered-chunk/ev-tampered-chunk-01.png";

/** `MAX_MEDIA_BYTES` of the simulator (routers/simulator.ts): 3,75 MiB. */
const MAX_UPLOAD_BYTES = 3_932_160;

const who = (ctx: ScenarioContext, key: string) => personaIn(ctx, worldOf(ctx), key);

const readingResults = (view: Awaited<ReturnType<typeof caseOf>>) => evidenceDetails(view, "RECEIPT_READING").map((reading) => reading["result"]);
const paymentsOf = (view: Awaited<ReturnType<typeof caseOf>>) => view.actions.filter((action) => action.kind === "APPLY_PAYMENT" && action.status === "EXECUTED");

/** Files the script complaint with its receipt and waits for HUMAN_REVIEW (or another status). */
async function toReview(ctx: ScenarioContext, key: string, statuses: Parameters<typeof untilStatus>[3] = ["HUMAN_REVIEW"]) {
  const persona = who(ctx, key);
  const id = keepComplaint(ctx, key, await fileWithReceipt(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
  await untilStatus(ctx, persona, id, statuses, { progress: progressOf(ctx, key), timeoutSec: WAITS.turnSec * 2 });
  return { persona, id, view: await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id)) };
}

export default defineScenario({
  id: "SC-03",
  slug: "sc03",
  title: "Receipts: invalid, blurry, duplicate, not found, injection, not a receipt, fallback, another payer, result first",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: clones of C07, C16, C17, C18, C19, C20, C41, C04 and C01",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: PERSONAS });
      },
    },
    {
      n: 1,
      title: "C07: invalid check digit → INVALID_RECEIPT → HUMAN_REVIEW",
      flows: ["FL-020"],
      async run(ctx) {
        const { view } = await toReview(ctx, "a");
        ctx.check(readingResults(view).includes("INVALID_RECEIPT"), `readings ${readingResults(view).join(", ")}, expected INVALID_RECEIPT`);
        ctx.none(view, "payments applied", paymentsOf(view));
      },
    },
    {
      n: 2,
      title: "C16: blurry → Bedrock ILLEGIBLE → UNREADABLE (source BEDROCK) → RECEIPT_REQUEST",
      flows: ["FL-019"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = keepComplaint(ctx, "b", await fileWithReceipt(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
        await ctx.eventually("a RECEIPT_REQUEST after the blurry photo", async () => {
          const snapshot = await ctx.snapshot(persona.worldId, persona.customerId);
          return sentKind(snapshot, "RECEIPT_REQUEST").length > 0 ? snapshot : undefined;
        }, WAITS.turnSec, 5);
        const reading = evidenceDetails(await caseOf(ctx, persona.worldId, id), "RECEIPT_READING").at(-1);
        ctx.check(reading?.["result"] === "UNREADABLE" && reading["source"] === "BEDROCK", `reading ${String(reading?.["result"])} by ${String(reading?.["source"])}, expected UNREADABLE by BEDROCK`);
      },
    },
    {
      n: 3,
      title: "C16: the second blurry photo → HUMAN_REVIEW",
      flows: ["FL-019"],
      async run(ctx) {
        const persona = who(ctx, "b");
        const id = complaintIdOf(ctx, "b");
        await untilStatus(ctx, persona, id, ["HUMAN_REVIEW"], { plan: { receipts: [{ type: "receipt", variant: "blurry", personaModel: "C16", seq: 2 }] }, progress: progressOf(ctx, "b"), timeoutSec: WAITS.turnSec * 2 });
        const view = await caseOf(ctx, persona.worldId, id);
        ctx.check(readingResults(view).filter((result) => result === "UNREADABLE").length === 2, `readings ${readingResults(view).join(", ")}, expected two UNREADABLE`);
      },
    },
    {
      n: 4,
      title: "C17: the receipt of its open complaint → DUPLICATE_OF, no second payment",
      flows: ["FL-021"],
      async run(ctx) {
        const persona = who(ctx, "c");
        await say(ctx, persona, { type: "text", text: scriptMessage("C17").text });
        await sendReceipt(ctx, persona);
        const duplicate = await ctx.eventually("a DUPLICATE_OF reading", async () => {
          const snapshot = await ctx.snapshot(persona.worldId, persona.customerId);
          for (const view of complaintsOf(snapshot)) {
            const found = readingResults(await caseOf(ctx, persona.worldId, view.complaint.complaintId)).includes("DUPLICATE_OF");
            if (found) return view.complaint.complaintId;
          }
          return undefined;
        }, WAITS.turnSec, 10);
        const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, duplicate));
        ctx.none(view, "payments applied on the duplicate", paymentsOf(view));
      },
    },
    {
      n: 5,
      title: "C18: a code missing from the published batch → NOT_FOUND → HUMAN_REVIEW, never \"found\"",
      flows: ["FL-018"],
      async run(ctx) {
        const { view } = await toReview(ctx, "d");
        ctx.check(latestResult(view, "SETTLEMENT_MATCH") === "NOT_FOUND", `reconciliation ${latestResult(view, "SETTLEMENT_MATCH")}, expected NOT_FOUND`);
        ctx.none(view, "payments applied", paymentsOf(view));
      },
    },
    {
      n: 6,
      title: "C19: instructions printed on the image → suspiciousText, no action for the image's amount",
      flows: ["FL-028"],
      async run(ctx) {
        const { view } = await toReview(ctx, "e", ["HUMAN_REVIEW", "RESOLVED", "ANSWERED", "AWAITING_SETTLEMENT"]);
        const reading = evidenceDetails(view, "RECEIPT_READING").at(-1);
        ctx.check(reading?.["suspiciousText"] === true, "the reading did not flag the printed instructions (suspiciousText)");
        ctx.blocked("MODEL_REFUSAL", "SUSPICIOUS_RECEIPT_TEXT: the reading carries suspiciousText; no action follows from the image");
        // Only the settlement line may move money: C19's real SUR payment of $ 52.935,00, never another amount.
        ctx.none(view, "payments with an amount other than the batch line's", paymentsOf(view).filter((action) => action.amountCents !== 5_293_500));
      },
    },
    {
      n: 7,
      title: "C20: not a receipt; oversize images refused without Bedrock; a PDF gets the fixed reply; a presign over 3,75 MiB refused",
      flows: ["FL-029"],
      async run(ctx) {
        const persona = who(ctx, "f");
        const id = keepComplaint(ctx, "f", await fileWithReceipt(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
        await ctx.eventually("NOT_A_RECEIPT", async () => readingResults(await caseOf(ctx, persona.worldId, id)).includes("NOT_A_RECEIPT"), WAITS.turnSec, 5);
        await ctx.settled(persona.worldId, persona.customerId);
        const readsBefore = readingResults(await caseOf(ctx, persona.worldId, id)).length;
        const lighter = await say(ctx, persona, { type: "serverImage", variant: "oversize-4.5mb" });
        ctx.note("oversize-4.5mb", `${lighter.accepted} ${lighter.outcomes.join(",")}`);
        const heavy = await say(ctx, persona, { type: "serverImage", variant: "oversize-7mb" });
        ctx.note("oversize-7mb", `${heavy.accepted} ${heavy.reason ?? ""} ${heavy.outcomes.join(",")}`);
        const after = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id), persona.customerId);
        ctx.exactly(after, readsBefore, "receipt readings (no Bedrock call for an oversize image)", readingResults(after));
        const snapshot = await ctx.snapshot(persona.worldId, persona.customerId);
        ctx.check(viewOf(snapshot, id).complaint.status !== "RESOLVED", "an oversize image resolved the complaint");
        const presign = await consoleAttempt(ctx, "simulator", "presignReceipt", { persona: "C20", contentType: "image/png", sizeBytes: MAX_UPLOAD_BYTES + 1 }, { worldId: persona.worldId, role: "GUEST" });
        ctx.check(!presign.ok && presign.error.code === "INVALID", `presignReceipt of ${MAX_UPLOAD_BYTES + 1} bytes answered ${presign.ok ? "a URL" : presign.error.code}`);
        const readsNow = readingResults(await caseOf(ctx, persona.worldId, id)).length;
        const pdf = await say(ctx, persona, { type: "document" });
        ctx.check(pdf.outcomes.includes("MEDIA_REJECTED"), `a PDF answered ${pdf.outcomes.join(",") || pdf.reason || "nothing"}, expected MEDIA_REJECTED (the fixed reply)`);
        const afterPdf = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, id), persona.customerId);
        ctx.exactly(afterPdf, readsNow, "receipt readings after the PDF", readingResults(afterPdf));
      },
    },
    {
      n: 8,
      title: "receipt.forceFallback → the deterministic reader (source FALLBACK); a tampered chunk → DISAGREE → HUMAN_REVIEW",
      flows: ["FL-027"],
      async run(ctx) {
        const persona = who(ctx, "h");
        await ctx.qa("receipt.forceFallback", { worldId: persona.worldId, on: true });
        try {
          const id = keepComplaint(ctx, "h", await fileWithReceipt(ctx, persona, 0, "PAYMENT_NOT_REFLECTED"));
          await ctx.eventually("a FALLBACK reading", async () => evidenceDetails(await caseOf(ctx, persona.worldId, id), "RECEIPT_READING").some((reading) => reading["source"] === "FALLBACK"), WAITS.turnSec, 5);
        } finally {
          await ctx.qa("receipt.forceFallback", { worldId: persona.worldId, on: false });
        }
        // The other branch: a CLEAR reading the fallback disagrees with is never chosen; a person decides.
        const tampered = who(ctx, "i");
        const tamperedId = keepComplaint(ctx, "i", await fileByScript(ctx, tampered, 0, "PAYMENT_NOT_REFLECTED"));
        await say(ctx, tampered, { type: "seedFile", file: TAMPERED });
        await untilStatus(ctx, tampered, tamperedId, ["HUMAN_REVIEW"], { progress: progressOf(ctx, "i"), timeoutSec: WAITS.turnSec * 2 });
        const view = await ctx.quietRead(tampered.worldId, () => caseOf(ctx, tampered.worldId, tamperedId));
        ctx.check(readingResults(view).includes("DISAGREE"), `readings ${readingResults(view).join(",") || "none"}, expected a DISAGREE`);
        ctx.check(view.complaint.handoff?.reason === "RECEIPT_DOUBT", `handoff ${view.complaint.handoff?.reason ?? "none"}, expected RECEIPT_DOUBT`);
        ctx.none(view, "payments applied from a disagreeing reading", paymentsOf(view));
      },
    },
    {
      n: 9,
      title: "C41: another payer's valid receipt → PAYER_MISMATCH → HUMAN_REVIEW RECEIPT_DOUBT, nothing of the other payer goes out",
      flows: ["FL-111"],
      async run(ctx) {
        const { persona, view } = await toReview(ctx, "g");
        ctx.check(latestResult(view, "SETTLEMENT_MATCH") === "PAYER_MISMATCH", `reconciliation ${latestResult(view, "SETTLEMENT_MATCH")}, expected PAYER_MISMATCH`);
        ctx.check(view.complaint.handoff?.reason === "RECEIPT_DOUBT", `handoff ${view.complaint.handoff?.reason ?? "none"}, expected RECEIPT_DOUBT`);
        ctx.none(view, "payments applied", paymentsOf(view));
        const snapshot = await ctx.settled(persona.worldId, persona.customerId);
        ctx.none(snapshot, "outbound messages naming the other payer", snapshot.messages.filter((message) => message.direction === "OUT" && /cus-1017|L-1017/.test(message.body)));
      },
    },
    {
      n: 10,
      title: "result before the message: an image uploaded by presigned POST, scanned, then attached; read within 12 s",
      flows: ["FL-101"],
      run: receiptStep,
    },
  ],
});

