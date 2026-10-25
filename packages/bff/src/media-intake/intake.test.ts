import { describe, expect, it } from "vitest";
import { createMediaIntakeHandler } from "../handlers/media-intake";
import { sha256Hex } from "../lib/crypto";
import { SEED_RECEIPT_HASH_REFERENCE } from "../receipts/seed-hash";
import { jpeg, png } from "../receipts/testing";
import { receiptImageEvidence } from "./intake";
import { announceKeyOf, mediaEventId, scanTargetOf, worldOfObjectKey } from "./keys";
import { bindScanMessage, recordScanResult } from "./resolve";
import { CUSTOMER, WORLD, cleanReceipt, intakeKit } from "./testing";

const UP = `up/${WORLD}/wa-in-7/0.png`;

async function cleanResult(bytes: Uint8Array, key = UP) {
  const kit = await intakeKit();
  await kit.announce({ announceKey: key, s3Key: key, source: "SIMULATOR", bytes });
  await kit.storeMessage("wa-in-7");
  await bindScanMessage(kit.deps, { worldId: WORLD, announceKey: key, messageId: "wa-in-7", customerId: CUSTOMER });
  const outcome = await recordScanResult(kit.deps, { objectKey: key, status: "NO_THREATS_FOUND" });
  return { kit, outcome };
}

describe("an image validated after its scan [FL-029]", () => {
  it("[FL-029] a clean JPEG or PNG within limits becomes RECEIPT_RECEIVED with the facts of its bytes", async () => {
    const bytes = cleanReceipt();
    const { kit, outcome } = await cleanResult(bytes);
    expect(outcome).toBe("RESOLVED");
    expect(kit.events).toEqual([
      {
        type: "RECEIPT_RECEIVED",
        eventId: mediaEventId(UP),
        worldId: WORLD,
        customerId: CUSTOMER,
        epoch: 1,
        eventAtSim: "2026-10-07T13:10:00.000Z",
        payload: { messageId: "wa-in-7", messageAtSim: "2026-10-07T10:10:00-03:00", image: { s3Key: UP, sha256: sha256Hex(bytes), contentType: "image/png", sizeBytes: bytes.length, width: 900, height: 1400, scan: "NO_THREATS_FOUND", messageId: "wa-in-7", source: "SIMULATOR" } },
      },
    ]);
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toEqual([]);
    const stored = await kit.mc.connector.conversations.findMessage(WORLD, CUSTOMER, "wa-in-7");
    expect(stored?.media).toMatchObject({ scan: "NO_THREATS_FOUND", s3Key: UP, announceKey: UP });
    expect((await kit.mc.connector.audit.listByAction(WORLD, "MEDIA_ACCEPTED")).length).toBe(1);
  });

  it("[FL-029] the worker files the image as RECEIPT_IMAGE evidence of the complaint, once per message", async () => {
    const { kit } = await cleanResult(jpeg());
    const event = kit.events[0];
    if (event?.type !== "RECEIPT_RECEIVED") throw new Error("expected RECEIPT_RECEIVED");
    const evidence = receiptImageEvidence({ worldId: WORLD, complaintId: "cmp-0004", payload: event.payload, atSim: event.eventAtSim });
    expect(evidence).toMatchObject({ evidenceId: "evd-img-wa-in-7", kind: "RECEIPT_IMAGE", actor: "SYSTEM", details: { contentType: "image/jpeg", width: 1200, height: 1600 } });
    await kit.mc.connector.caseItems.putEvidence(evidence);
    await expect(kit.mc.connector.caseItems.putEvidence(evidence)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("[FL-029] over 3.75 MB: the object is deleted and the customer asked for a lighter photo, without Bedrock", async () => {
    const { kit } = await cleanResult(png({ dataBytes: 3_932_161 }));
    expect(kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { reason: "TOO_LARGE", reply: "MEDIA_TOO_LARGE" } }]);
    expect(kit.objects.objects.has(UP)).toBe(false);
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toEqual([]);
  });

  it("[FL-029] more than 8,000 px per side is too large too; a wrong magic number is not an image", async () => {
    const huge = await cleanResult(png({ width: 8_001, height: 1_000 }));
    expect(huge.kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { reason: "TOO_MANY_PIXELS", reply: "MEDIA_TOO_LARGE" } }]);
    const pdf = await cleanResult(new TextEncoder().encode("%PDF-1.7 not an image"));
    expect(pdf.kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { reason: "BAD_MAGIC", reply: "MEDIA_UNSUPPORTED" } }]);
    expect(pdf.kit.objects.removed).toEqual([UP]);
    const broken = await cleanResult(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
    expect(broken.kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { reason: "UNREADABLE_HEADER", reply: "IMAGE_NOT_PROCESSED" } }]);
  });

  it("[FL-029] an object gone after the scan is not processed", async () => {
    const kit = await intakeKit();
    await kit.announce({ announceKey: UP, s3Key: UP, source: "SIMULATOR" });
    await kit.storeMessage("wa-in-7");
    await bindScanMessage(kit.deps, { worldId: WORLD, announceKey: UP, messageId: "wa-in-7", customerId: CUSTOMER });
    await recordScanResult(kit.deps, { objectKey: UP, status: "NO_THREATS_FOUND" });
    expect(kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { reason: "GONE", reply: "IMAGE_NOT_PROCESSED" } }]);
  });

  it("[FL-029] THREATS_FOUND → quarantine, MALWARE, MalwareFindings and the neutral fixed reply", async () => {
    const kit = await intakeKit();
    await kit.announce({ announceKey: UP, s3Key: UP, source: "SIMULATOR", bytes: cleanReceipt() });
    await kit.storeMessage("wa-in-7");
    await bindScanMessage(kit.deps, { worldId: WORLD, announceKey: UP, messageId: "wa-in-7", customerId: CUSTOMER });
    await recordScanResult(kit.deps, { objectKey: UP, status: "THREATS_FOUND" });
    expect(kit.objects.objects.has(UP)).toBe(false);
    expect(kit.objects.objects.has(`quarantine/${UP}`)).toBe(true);
    expect(kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { reason: "THREATS_FOUND", reply: "IMAGE_NOT_PROCESSED" } }]);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "MALWARE")).toHaveLength(1);
    expect(kit.lines().some((line) => line.metric === "MalwareFindings")).toBe(true);
    // The image is never read for a model: only the quarantine touched it.
    expect(kit.objects.reads).toEqual([]);
  });

  it.each(["ACCESS_DENIED", "FAILED", "UNSUPPORTED"] as const)("[FL-029] %s → SCAN_NOT_COMPLETED, ScanFailures and IMAGE_NOT_PROCESSED, without reading the image", async (status) => {
    const kit = await intakeKit();
    await kit.announce({ announceKey: UP, s3Key: UP, source: "SIMULATOR", bytes: cleanReceipt() });
    await kit.storeMessage("wa-in-7");
    await bindScanMessage(kit.deps, { worldId: WORLD, announceKey: UP, messageId: "wa-in-7", customerId: CUSTOMER });
    await recordScanResult(kit.deps, { objectKey: UP, status });
    expect(kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { reason: status, reply: "IMAGE_NOT_PROCESSED" } }]);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_NOT_COMPLETED")).toMatchObject([{ outcome: status }]);
    expect(kit.lines().some((line) => line.metric === "ScanFailures" && line.status === status)).toBe(true);
    expect(kit.objects.reads).toEqual([]);
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toEqual([]);
  });
});

describe("seed copies [FL-029] [FL-101]", () => {
  const SIM = `W/${WORLD}/sim/wa-in-8/0.png`;

  it("[FL-101] a server-side copy of a seed receipt with a known hash does not wait for its scan", async () => {
    const kit = await intakeKit();
    const bytes = cleanReceipt();
    await kit.mc.store.write({ kind: "put", table: "Reference", item: { pk: `REF#${SEED_RECEIPT_HASH_REFERENCE.type}#${SEED_RECEIPT_HASH_REFERENCE.scope}`, sk: sha256Hex(bytes), sha256: sha256Hex(bytes), seedKey: "receipts/legible/c04-1.png" } });
    await kit.announce({ announceKey: SIM, s3Key: SIM, source: "SEED_COPY", bytes });
    await kit.storeMessage("wa-in-8");
    expect(await bindScanMessage(kit.deps, { worldId: WORLD, announceKey: SIM, messageId: "wa-in-8", customerId: CUSTOMER })).toBe("SEED_SKIPPED");
    expect(kit.deadlines).toEqual([]);
    expect(kit.events).toMatchObject([{ type: "RECEIPT_RECEIVED", payload: { image: { scan: "SEED_SKIPPED", source: "SEED_COPY" } } }]);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_WAIT_SKIPPED_SEED")).toHaveLength(1);
    // The scan still runs on its registry: a later threat quarantines the copy, nothing is re-sent.
    expect(await recordScanResult(kit.deps, { objectKey: SIM, status: "THREATS_FOUND" })).toBe("LATE");
    expect(kit.objects.objects.has(`quarantine/${SIM}`)).toBe(true);
    expect(kit.events).toHaveLength(1);
    // A clean late result changes nothing either.
    const clean = await intakeKit();
    await clean.mc.store.write({ kind: "put", table: "Reference", item: { pk: `REF#${SEED_RECEIPT_HASH_REFERENCE.type}#${SEED_RECEIPT_HASH_REFERENCE.scope}`, sk: sha256Hex(bytes), sha256: sha256Hex(bytes), seedKey: "receipts/legible/c04-1.png" } });
    await clean.announce({ announceKey: SIM, s3Key: SIM, source: "SEED_COPY", bytes });
    await bindScanMessage(clean.deps, { worldId: WORLD, announceKey: SIM, messageId: "wa-in-8", customerId: CUSTOMER });
    expect(await recordScanResult(clean.deps, { objectKey: SIM, status: "NO_THREATS_FOUND" })).toBe("LATE");
    expect(clean.events).toHaveLength(1);
  });

  it("[FL-029] any other image waits for its scan, even a seed copy whose hash is unknown", async () => {
    const kit = await intakeKit();
    await kit.announce({ announceKey: SIM, s3Key: SIM, source: "SEED_COPY", bytes: cleanReceipt() });
    await kit.storeMessage("wa-in-8");
    expect(await bindScanMessage(kit.deps, { worldId: WORLD, announceKey: SIM, messageId: "wa-in-8", customerId: CUSTOMER })).toBe("WAITING");
    expect(kit.deadlines).toMatchObject([{ kind: "SCAN_DEADLINE", worldId: WORLD, announceKey: SIM, messageId: "wa-in-8" }]);
    expect(kit.events).toEqual([]);
  });
});

describe("keys and the Lambda entry [FL-029] [FL-103]", () => {
  it("[FL-103] maps an object key to its world and announce key, never by the media id's shape", () => {
    expect(announceKeyOf("wa/demo/wamid.ABC==/1555666777888999")).toBe("wa/demo/wamid.ABC==/");
    expect(announceKeyOf("wa/demo/wamid.ABC==/a/b")).toBe("wa/demo/wamid.ABC==/");
    expect(announceKeyOf(UP)).toBe(UP);
    expect(worldOfObjectKey("qa/r1/qa-r1-sc03/up/m/0.png")).toBe("qa-r1-sc03");
    expect(worldOfObjectKey("qa/qamin/sim/m/0.png")).toBe("qamin");
    expect(worldOfObjectKey("W/g07/sim/m/0.png")).toBe("g07");
    expect(scanTargetOf("malware-protection-resource-validation-object")).toBeUndefined();
    expect(scanTargetOf(`quarantine/${UP}`)).toBeUndefined();
    expect(scanTargetOf("up/not a world/x.png")).toBeUndefined();
  });

  it("[FL-029] the entry validates its input: another bucket or a malformed event changes nothing", async () => {
    const kit = await intakeKit();
    const handler = createMediaIntakeHandler(() => ({ ...kit.deps, enqueue: () => kit.deps.enqueue, mediaBucket: "reclamo-poc-media", logSink: () => undefined }));
    const ctx = { awsRequestId: "req-0001-abcdef" };
    const event = (bucketName: string) => ({ source: "aws.guardduty", "detail-type": "GuardDuty Malware Protection Object Scan Result", detail: { s3ObjectDetails: { bucketName, objectKey: UP }, scanResultDetails: { scanResultStatus: "NO_THREATS_FOUND" } } });
    expect(await handler(event("other-bucket"), ctx)).toEqual({ kind: "SCAN_RESULT", outcome: "WRONG_BUCKET" });
    expect(await handler({ hello: "world" }, ctx)).toEqual({ kind: "INVALID" });
    expect(await handler(event("reclamo-poc-media"), ctx)).toEqual({ kind: "SCAN_RESULT", outcome: "ORPHAN" });
    expect(await handler({ Records: [{ messageId: "m1", eventSource: "aws:sqs", body: "{not json" }] }, ctx)).toEqual({ kind: "DEADLINES", outcomes: ["INVALID"] });
  });
});
