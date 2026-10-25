// The scan registry resolved in any order (docs/architecture.md §6, docs/architecture-integrations.md
// §9): the result before or after the message, both at once, the 120 s deadline with and without
// GuardDuty's tag, a result after a TIMEOUT, orphans, a reset world, and redeliveries after a crash.
import { describe, expect, it } from "vitest";
import { message } from "../connector/testing";
import { sha256Hex } from "../lib/crypto";
import { mediaEventId } from "./keys";
import { type BindDeps, bindScanMessage, processScanDeadline, recordScanResult } from "./resolve";
import { CUSTOMER, WORLD, cleanReceipt, intakeKit } from "./testing";

const UP = `up/${WORLD}/wa-in-7/0.png`;
const WAMID = "wamid.HBgMNTQ5MTEwMDAwMTAwNBUCABIYFDNBRkY3RkE";
const MEDIA_ID = "1555666777888999";
const LIVE_PREFIX = `wa/demo/${WAMID}/`;
// The service appends the media id to the prefix: a key the code never predicts.
const LIVE_KEY = `${LIVE_PREFIX}${MEDIA_ID}${MEDIA_ID}`;

async function uploaded(worldId = WORLD) {
  const kit = await intakeKit(worldId);
  await kit.announce({ announceKey: UP, s3Key: UP, source: "SIMULATOR", bytes: cleanReceipt() });
  await kit.storeMessage("wa-in-7");
  return kit;
}

const bind = (deps: BindDeps, announceKey = UP, worldId = WORLD, messageId = "wa-in-7") => bindScanMessage(deps, { worldId, announceKey, messageId, customerId: CUSTOMER });

describe("live WhatsApp media resolved by its announced prefix [FL-103]", () => {
  it("[FL-103] a result for wa/<w>/<wamid>/<mediaId><mediaId> resolves the prefix's registry and reads the real key", async () => {
    const kit = await intakeKit("demo");
    const bytes = cleanReceipt();
    await kit.announce({ announceKey: LIVE_PREFIX, source: "WHATSAPP" });
    kit.objects.put(LIVE_KEY, bytes);
    // InboundWhatsApp found the real key with ListObjectsV2 and stored it.
    expect(await kit.mc.connector.scans.setS3Key("demo", LIVE_PREFIX, LIVE_KEY)).toBe(true);
    await kit.mc.connector.conversations.putMessage(message("demo", { customerId: CUSTOMER, messageId: "wa-in-9", body: "[imagen]", atSim: "2026-10-07T10:10:00-03:00", media: { contentType: "image/jpeg" } }));
    expect(await bind(kit.deps, LIVE_PREFIX, "demo", "wa-in-9")).toBe("WAITING");
    expect(await recordScanResult(kit.deps, { objectKey: LIVE_KEY, status: "NO_THREATS_FOUND" })).toBe("RESOLVED");
    expect(await kit.mc.connector.audit.listByAction("demo", "SCAN_RESULT_ORPHAN")).toEqual([]);
    expect(kit.events).toMatchObject([{ type: "RECEIPT_RECEIVED", eventId: mediaEventId(LIVE_PREFIX), payload: { image: { s3Key: LIVE_KEY, sha256: sha256Hex(bytes), source: "WHATSAPP" } } }]);
    // Every read named the real key, never the announced prefix.
    expect(kit.objects.reads).toEqual([LIVE_KEY]);
  });

  it("[FL-103] a result that arrives before ListObjectsV2 leaves the real key on the registry", async () => {
    const kit = await intakeKit("demo");
    await kit.announce({ announceKey: LIVE_PREFIX, source: "WHATSAPP" });
    kit.objects.put(LIVE_KEY, cleanReceipt());
    expect(await recordScanResult(kit.deps, { objectKey: LIVE_KEY, status: "NO_THREATS_FOUND" })).toBe("STORED");
    expect((await kit.mc.connector.scans.get("demo", LIVE_PREFIX))?.s3Key).toBe(LIVE_KEY);
    // The same key found later is accepted; another one under the prefix is not.
    expect(await kit.mc.connector.scans.setS3Key("demo", LIVE_PREFIX, LIVE_KEY)).toBe(true);
    expect(await kit.mc.connector.scans.setS3Key("demo", LIVE_PREFIX, `${LIVE_PREFIX}other`)).toBe(false);
    await kit.mc.connector.conversations.putMessage(message("demo", { customerId: CUSTOMER, messageId: "wa-in-9", body: "[imagen]", atSim: "2026-10-07T10:10:00-03:00" }));
    expect(await bind(kit.deps, LIVE_PREFIX, "demo", "wa-in-9")).toBe("RESOLVED");
    expect(kit.objects.reads).toEqual([LIVE_KEY]);
  });
});

describe("the result and the message meet in any order [FL-101] [FL-029]", () => {
  it("[FL-101] result before the binding: stored, then resolved at the binding without a deadline (RESULT_FIRST)", async () => {
    const kit = await uploaded();
    expect(await recordScanResult(kit.deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).toBe("STORED");
    expect(kit.events).toEqual([]);
    expect(await bind(kit.deps)).toBe("RESOLVED");
    expect(kit.deadlines).toEqual([]);
    expect(kit.events).toMatchObject([{ type: "RECEIPT_RECEIVED", payload: { messageId: "wa-in-7", image: { s3Key: UP, scan: "NO_THREATS_FOUND" } } }]);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_RESOLVED")).toMatchObject([{ outcome: "NO_THREATS_FOUND", detail: { order: "RESULT_FIRST" } }]);
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toEqual([]);
  });

  it("[FL-101] binding before the result: the deadline is queued, the result resolves it (BIND_FIRST)", async () => {
    const kit = await uploaded();
    expect(await bind(kit.deps)).toBe("WAITING");
    expect(kit.deadlines).toMatchObject([{ kind: "SCAN_DEADLINE", worldId: WORLD, announceKey: UP, messageId: "wa-in-7" }]);
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toMatchObject([{ kind: "SCAN", ref: "wa-in-7" }]);
    kit.tick(4_000);
    expect(await recordScanResult(kit.deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).toBe("RESOLVED");
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_RESOLVED")).toMatchObject([{ detail: { order: "BIND_FIRST" } }]);
    expect(kit.lines().find((line) => line.metric === "ScanLatency")).toMatchObject({ scanLatencyMs: 4_000 });
    // The deadline that arrives afterwards finds it settled.
    expect(await processScanDeadline(kit.deps, kit.deadlines[0] ?? (undefined as never))).toBe("ALREADY_RESOLVED");
    expect(kit.events).toHaveLength(1);
  });

  it("[FL-101] both at once, each seeing both halves: a single resolution, a single event", async () => {
    const kit = await uploaded();
    const scans = kit.mc.connector.scans;
    let bound!: () => void;
    const bindDone = new Promise<void>((done) => (bound = done));
    // The result's write lands, then waits until the binding committed: both re-reads see both halves.
    const racing = {
      ...scans,
      recordResult: async (...args: Parameters<typeof scans.recordResult>) => {
        const after = await scans.recordResult(...args);
        await bindDone;
        return after === undefined ? undefined : scans.get(args[0], args[1]);
      },
      bind: async (...args: Parameters<typeof scans.bind>) => {
        const after = await scans.bind(...args);
        bound();
        return after;
      },
    };
    const deps = { ...kit.deps, connector: { ...kit.mc.connector, scans: racing } };
    const outcomes = await Promise.all([recordScanResult(deps, { objectKey: UP, status: "NO_THREATS_FOUND" }), bind(deps)]);
    expect([...outcomes].sort()).toEqual(["ALREADY_RESOLVED", "RESOLVED"]);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_RESOLVED")).toHaveLength(1);
    expect(kit.events).toHaveLength(1);
  });

  it("[FL-101] both at once without coordination: whatever the interleaving, the image is resolved once", async () => {
    const kit = await uploaded();
    await Promise.all([recordScanResult(kit.deps, { objectKey: UP, status: "NO_THREATS_FOUND" }), bind(kit.deps)]);
    expect(kit.events).toHaveLength(1);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_RESOLVED")).toHaveLength(1);
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toEqual([]);
  });
});

describe("the 120 s deadline [FL-029] [FL-101]", () => {
  it("[FL-029] with GuardDuty's tag on the object it resolves by the tag (a lost EventBridge event)", async () => {
    const kit = await uploaded();
    await bind(kit.deps);
    kit.objects.tags.set(UP, "NO_THREATS_FOUND");
    kit.tick(120_000);
    expect(await processScanDeadline(kit.deps, kit.deadlines[0] ?? (undefined as never))).toBe("RESOLVED");
    expect(kit.objects.reads[0]).toBe(`tag:${UP}`);
    expect(kit.events).toMatchObject([{ type: "RECEIPT_RECEIVED" }]);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_NOT_COMPLETED")).toEqual([]);
  });

  it("[FL-029] a THREATS_FOUND tag quarantines the object and answers the neutral fixed reply", async () => {
    const kit = await uploaded();
    await bind(kit.deps);
    kit.objects.tags.set(UP, "THREATS_FOUND");
    expect(await processScanDeadline(kit.deps, kit.deadlines[0] ?? (undefined as never))).toBe("RESOLVED");
    expect(kit.objects.objects.has(`quarantine/${UP}`)).toBe(true);
    expect(kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { reason: "THREATS_FOUND", reply: "IMAGE_NOT_PROCESSED" } }]);
  });

  it("[FL-029] no result and no tag: TIMEOUT, SCAN_NOT_COMPLETED, ScanFailures and IMAGE_NOT_PROCESSED, the image unread", async () => {
    const kit = await uploaded();
    await bind(kit.deps);
    expect(await processScanDeadline(kit.deps, kit.deadlines[0] ?? (undefined as never))).toBe("RESOLVED");
    expect(kit.events).toMatchObject([{ type: "MEDIA_REJECTED", payload: { messageId: "wa-in-7", reason: "TIMEOUT", reply: "IMAGE_NOT_PROCESSED" } }]);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_NOT_COMPLETED")).toMatchObject([{ outcome: "TIMEOUT" }]);
    expect(kit.lines().some((line) => line.metric === "ScanFailures" && line.status === "TIMEOUT")).toBe(true);
    expect(kit.objects.reads).toEqual([`tag:${UP}`]);
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toEqual([]);
  });

  it("[FL-029] a result after the TIMEOUT is audited SCAN_RESULT_LATE and reopens nothing; a late threat is still quarantined", async () => {
    const kit = await uploaded();
    await bind(kit.deps);
    await processScanDeadline(kit.deps, kit.deadlines[0] ?? (undefined as never));
    expect(await recordScanResult(kit.deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).toBe("LATE");
    expect(kit.events).toHaveLength(1);
    kit.tick(1);
    expect(await recordScanResult(kit.deps, { objectKey: UP, status: "THREATS_FOUND" })).toBe("LATE");
    expect(kit.objects.objects.has(`quarantine/${UP}`)).toBe(true);
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_RESULT_LATE")).toHaveLength(2);
    expect(kit.events).toHaveLength(1);
  });

  it("[FL-103] a live registry without its real key is not asked for a tag", async () => {
    const kit = await intakeKit("demo");
    await kit.announce({ announceKey: LIVE_PREFIX, source: "WHATSAPP" });
    // A registry bound by hand without `s3Key`: the deadline has no object to read.
    await kit.mc.connector.scans.bind("demo", LIVE_PREFIX, { messageId: "wa-in-9", customerId: CUSTOMER, pending: { worldId: "demo", kind: "SCAN", pendingId: "00000000", openedAtReal: "2026-10-07T13:10:00.000Z", customerId: CUSTOMER, ref: "wa-in-9" } });
    await processScanDeadline(kit.deps, { kind: "SCAN_DEADLINE", worldId: "demo", announceKey: LIVE_PREFIX, messageId: "wa-in-9", boundAtReal: "2026-10-07T13:10:00.000Z" });
    expect(kit.objects.reads).toEqual([]);
  });
});

describe("results nobody announced, reset worlds and redeliveries [FL-029] [FL-103]", () => {
  it("[FL-103] a result without a registry is an audited orphan; a key of no world is only logged", async () => {
    const kit = await intakeKit();
    expect(await recordScanResult(kit.deps, { objectKey: `up/${WORLD}/wa-in-404/0.png`, status: "NO_THREATS_FOUND" })).toBe("ORPHAN");
    expect(await kit.mc.connector.audit.listByAction(WORLD, "SCAN_RESULT_ORPHAN")).toMatchObject([{ outcome: "NO_THREATS_FOUND" }]);
    expect(await recordScanResult(kit.deps, { objectKey: "malware-protection-resource-validation-object", status: "NO_THREATS_FOUND" })).toBe("ORPHAN");
    expect(kit.lines().some((line) => line.message === "media_intake.unattributed_result")).toBe(true);
    expect(kit.events).toEqual([]);
  });

  it("[FL-029] a result of a world with a tombstone is discarded with an audit", async () => {
    const kit = await uploaded();
    await kit.mc.connector.write(kit.mc.connector.runtime.putTombstoneOp({ worldId: WORLD, epoch: 1, reason: "RESET", atReal: "2026-10-07T13:00:00.000Z" }));
    expect(await recordScanResult(kit.deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).toBe("TOMBSTONED");
    expect(await kit.mc.connector.audit.listByAction(WORLD, "TOMBSTONED_EVENT")).toHaveLength(1);
    expect(kit.events).toEqual([]);
  });

  it("[FL-029] a result redelivered after a crash between its write and the resolution resolves it", async () => {
    const kit = await uploaded();
    await bind(kit.deps);
    const scans = kit.mc.connector.scans;
    let crashed = false;
    const crashing = {
      ...scans,
      markResolved: async (...args: Parameters<typeof scans.markResolved>) => {
        if (!crashed) {
          crashed = true;
          throw new Error("Lambda timed out");
        }
        return scans.markResolved(...args);
      },
    };
    const deps = { ...kit.deps, connector: { ...kit.mc.connector, scans: crashing } };
    await expect(recordScanResult(deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).rejects.toThrow();
    expect(await recordScanResult(deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).toBe("RESOLVED");
    expect(kit.events).toHaveLength(1);
  });

  it("[FL-029] an enqueue that failed after the resolution is completed by the redelivery, once", async () => {
    const kit = await uploaded();
    await bind(kit.deps);
    let failures = 1;
    const deps = {
      ...kit.deps,
      enqueue: async (event: (typeof kit.events)[number]) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("SendMessage failed");
        }
        kit.events.push(event);
      },
    };
    await expect(recordScanResult(deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).rejects.toThrow();
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toHaveLength(1);
    expect(await recordScanResult(deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).toBe("RESOLVED");
    expect(kit.events).toHaveLength(1);
    expect(await kit.mc.connector.runtime.listPending(WORLD)).toEqual([]);
    expect(await recordScanResult(deps, { objectKey: UP, status: "NO_THREATS_FOUND" })).toBe("ALREADY_RESOLVED");
  });

  it("[FL-101] a binding redelivered after a crash before its deadline queues the deadline again", async () => {
    const kit = await uploaded();
    const deps = { ...kit.deps, enqueueDeadline: async () => Promise.reject(new Error("SendMessage failed")) };
    await expect(bind(deps)).rejects.toThrow();
    expect(await bind(kit.deps)).toBe("WAITING");
    expect(kit.deadlines).toHaveLength(1);
    // Another message for the same object is a duplicate, never a second binding.
    expect(await bind(kit.deps, UP, WORLD, "wa-in-8")).toBe("DUPLICATE");
  });
});
