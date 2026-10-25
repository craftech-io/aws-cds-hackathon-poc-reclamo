// SC-03/10 · the scan's result before the message (docs/test-plan.md §4.5, FL-101; demo-critical cut). In
// a world of the `guest` template, as a visitor of the phone simulator: `console.simulator.presignReceipt`
// for C04, the image up by the presigned POST to `Media` (where GuardDuty scans it), a real wait longer
// than the scan, then `console.simulator.attachReceipt` with the key: the case gets its `RECEIPT_IMAGE`
// and the reading lands within 12 s of the send, with no scan left unfinished or timed out, and the scan
// registry resolved `RESULT_FIRST` (the snapshot's `scan` of the inbound image).
import { caseOf, consoleCall, evidenceDetails, itemsOf, timelineOf } from "./console";
import { scriptMessage } from "./personas";
import { latestComplaint } from "./snapshot";
import { type ScenarioContext, ensure } from "./steps";
import { postUpload, uniqueReceipt } from "./upload";
import { createWorld } from "./world";

/** Real seconds the runner lets the scan finish before the tap: the measured `ScanLatency` cap (p99 × 1.5 after the first run) + 10 s. */
export const SCAN_WAIT_SEC = 60 + 10;
/** docs/test-plan.md §7: the reading within 12 s once the scan closed. */
export const READ_WITHIN_MS = 12_000;
/** Scan states that mean the image was never read (media-intake/intake.ts). */
const UNFINISHED = new Set(["TIMEOUT", "FAILED", "ACCESS_DENIED", "UNSUPPORTED", "NOT_COMPLETED"]);

export async function receiptStep(ctx: ScenarioContext): Promise<void> {
  const world = await createWorld(ctx, { suffix: "up", template: "guest" });
  const asGuest = { worldId: world.worldId, role: "GUEST" as const };
  const bytes = uniqueReceipt("legible", "C04", ctx.runId);
  const post = await consoleCall(ctx, "simulator", "presignReceipt", { persona: "C04", contentType: "image/png", sizeBytes: bytes.length }, asGuest);
  const status = await postUpload(post, bytes, "image/png");
  ctx.check(status >= 200 && status < 300, `the presigned POST to Media answered ${status}`);
  ctx.note("uploadKey", post.key);

  const uploaded = ctx.now();
  await ctx.eventually("the scan's head start", async () => ctx.now() - uploaded >= SCAN_WAIT_SEC * 1_000, SCAN_WAIT_SEC + 5, 5);

  const sentAt = ctx.now();
  await consoleCall(ctx, "simulator", "attachReceipt", { persona: "C04", source: { kind: "UPLOAD", key: post.key }, caption: scriptMessage("C04").text }, asGuest);
  const customerId = "cus-0004";
  const found = await ctx.eventually(
    "RECEIPT_READING of the uploaded image",
    async () => {
      const view = latestComplaint(await ctx.snapshot(world.worldId, customerId), "PAYMENT_NOT_REFLECTED");
      if (view === undefined) return undefined;
      const reading = evidenceDetails(await caseOf(ctx, world.worldId, view.complaint.complaintId), "RECEIPT_READING").at(-1);
      return reading === undefined ? undefined : { complaintId: view.complaint.complaintId, reading };
    },
    READ_WITHIN_MS / 1_000 + 20,
    1,
  );
  const readAt = Date.parse(String(found.reading["readAtReal"]));
  ctx.measure("readAfterSendMs", readAt - sentAt);
  ctx.check(Number.isFinite(readAt) && readAt - sentAt <= READ_WITHIN_MS, `the reading landed ${readAt - sentAt} ms after the send, expected within ${READ_WITHIN_MS} ms`);

  const view = await caseOf(ctx, world.worldId, found.complaintId);
  ctx.check(view.evidence.some((item) => item.kind === "RECEIPT_IMAGE"), "the case has no RECEIPT_IMAGE of the upload");
  const timeline = await timelineOf(ctx, world.worldId, found.complaintId);
  const image = itemsOf(timeline, "MESSAGE").find((item) => item.direction === "IN" && item.media !== null);
  ensure(image !== undefined, "the inbound image is not in the timeline");
  ctx.check(image.media?.scan !== null && !UNFINISHED.has(String(image.media?.scan)), `the scan of the upload is ${String(image.media?.scan)}`);
  // The result was there before the tap: the registry resolved it RESULT_FIRST, after its result.
  const thread = await ctx.snapshot(world.worldId, customerId);
  const scan = thread.messages.find((message) => message.direction === "IN" && message.scan !== null)?.scan ?? null;
  ensure(scan !== null, "the snapshot carries no scan registry of the upload (it lives one hour past its last change)");
  ctx.check(scan.resolution === "RESULT_FIRST", `the scan resolved ${scan.resolution ?? "never"}, expected RESULT_FIRST`);
  ctx.check(scan.resultAtReal !== null && Date.parse(scan.resultAtReal) <= sentAt, "the scan's result came after the send");
}
