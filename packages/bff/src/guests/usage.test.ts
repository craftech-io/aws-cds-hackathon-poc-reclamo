// The usage limits of a self-signup world (docs/architecture-guests.md §7 "Orden de la cadena de
// costo", FL-125): the world's caps (`TURNCAP#`, `TURNCAPEPOCH#`) and the SIGNUP pool's
// (`GLOBALCAP#SIGNUP#`, `GLOBALCAP#SIGNUPIMG#`) are looked at BEFORE every call that costs: the
// classifier's model in InboundWhatsApp, G1 and the Harness in the worker, Bedrock in the receipt
// reader. Every costly dependency here is a double that fails the test if it is called. The console
// learns that the day's limit is reached from `guest.status`, on the real clock.
import { describe, expect, it } from "vitest";
import { ToolError } from "@reclamo/shared";
import { complaint, evidence, testConnector, worldMeta, worldSettings } from "../connector/testing";
import { keys } from "../connector/keys";
import { realDayStamp } from "../connector/repos/caps";
import { signupImagePool } from "../agent-tools/investigation/ports";
import { classifyIntake } from "../intake/classifier";
import type { IntakeModel } from "../intake/model";
import { sha256Hex } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { IMAGE_READ_CAPS, connectorReadBudget } from "../receipts/budget";
import { type ReadReceiptRequest, readReceiptEvidence } from "../receipts/service";
import { SUR_FIELDS, receiptPng } from "../receipts/testing";
import type { BedrockReceiptReader } from "../receipts/bedrock-reader";
import { SIGNUP_TURNS_PER_EPOCH, poolBuckets, worldBuckets } from "../worker/caps";
import { TEST_NOW, eventOf, recordOf, workerKit, type WorkerKit } from "../worker/testing";
import { processRecord } from "../worker/worker";
import { createSignupHarness } from "./testing/harness";

const WORLD = "gs-abcdefgh23";
const HOUR_MS = 3_600_000;
const silent = createLogger({ sink: () => undefined });

/** A model that must never be asked. */
const forbiddenModel: IntakeModel = {
  classify: async () => {
    throw new Error("the classifier's model was called above a cap");
  },
};

/** A Bedrock reader that must never be asked. */
const forbiddenBedrock: BedrockReceiptReader = {
  read: async () => {
    throw new Error("Bedrock was called above a cap");
  },
} as unknown as BedrockReceiptReader;

async function prime(connector: { write: WorkerKit["connector"]["write"] }, key: { pk: string; sk: string }, count: number): Promise<void> {
  await connector.write({ kind: "update", table: "Runtime", key, update: { add: { count }, set: { entity: "CapCounter" } } });
}

async function intakeWorld(at: Date) {
  const mc = testConnector({ now: () => at });
  await mc.connector.worlds.register(worldMeta(WORLD, { status: "READY" }));
  await mc.connector.worlds.putSettings({ ...worldSettings(WORLD), turnCaps: { perHour: 200, perDay: 60 } });
  return mc;
}

// A text no deterministic rule decides, so only the model could classify it.
const AMBIGUOUS = { text: "che, te quería comentar algo de la otra vez", hasImage: false, openComplaints: [], worldId: WORLD, epoch: 1 } as const;

describe("[FL-125] the classifier of InboundWhatsApp looks at the caps before its model", () => {
  it("[FL-125] at the world's day cap the model is not called: UNCLEAR by fallback TURN_CAP", async () => {
    const mc = await intakeWorld(TEST_NOW);
    const [, day] = worldBuckets(WORLD, 1, { turnCaps: { perHour: 200, perDay: 60 } }, TEST_NOW);
    if (!day) throw new Error("no day bucket");
    await prime(mc.connector, day.key, 60);
    const result = await classifyIntake({ data: mc.connector, model: forbiddenModel, realNow: () => TEST_NOW, log: silent }, AMBIGUOUS);
    expect(result).toMatchObject({ kind: "UNCLEAR", source: "FALLBACK", fallback: "TURN_CAP" });
  });

  it("[FL-125] at the epoch's 150 turns the model is not called, even on a new real day", async () => {
    const later = new Date(TEST_NOW.getTime() + 24 * HOUR_MS);
    const mc = await intakeWorld(later);
    await prime(mc.connector, keys.runtime(WORLD, "TURNCAPEPOCH", keys.epochPart(1)), SIGNUP_TURNS_PER_EPOCH);
    const result = await classifyIntake({ data: mc.connector, model: forbiddenModel, realNow: () => later, log: silent }, AMBIGUOUS);
    expect(result.fallback).toBe("TURN_CAP");
  });

  it("[FL-125] with the SIGNUP pool's minute spent the model is not called: GLOBAL_CAP", async () => {
    const mc = await intakeWorld(TEST_NOW);
    const [minute] = poolBuckets(WORLD, TEST_NOW);
    if (!minute) throw new Error("no minute bucket");
    expect(minute.key.pk.startsWith("GLOBALCAP#SIGNUP#")).toBe(true);
    await prime(mc.connector, minute.key, 5);
    const result = await classifyIntake({ data: mc.connector, model: forbiddenModel, realNow: () => TEST_NOW, log: silent }, AMBIGUOUS);
    expect(result.fallback).toBe("GLOBAL_CAP");
  });
});

describe("[FL-125] the self-signup worker counts the caps before G1 and the Harness", () => {
  async function turn(kit: WorkerKit, eventId: string) {
    await kit.addInbound(`msg-${eventId}`, "¿Cómo va mi reclamo?");
    return processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: `msg-${eventId}`, messageAtSim: "2026-10-07T10:10:00-03:00", complaintIds: [] }, { worldId: kit.worldId, eventId }), { queue: "SignupCustomerEvents" }));
  }

  it("[FL-125] at the world's day cap: TURN_CAP, the fixed handoff notice, no G1 and no Harness", async () => {
    const kit = await workerKit({ worldId: WORLD });
    const settings = await kit.connector.worlds.getSettings(WORLD);
    if (!settings) throw new Error("no settings");
    const day = worldBuckets(WORLD, 1, settings, TEST_NOW).find((bucket) => bucket.window === "DAY");
    if (!day) throw new Error("no day bucket");
    await prime(kit.connector, day.key, day.limit);
    await turn(kit, "evt-day-cap");
    expect(kit.g1.texts).toEqual([]);
    expect(kit.harness.requests).toEqual([]);
    expect(kit.gate.requests.map((request) => request.kind)).toEqual(["HANDOFF_NOTICE"]);
    expect((await kit.audited("TURN_CAP"))[0]?.detail).toMatchObject({ window: "DAY" });
  });

  it("[FL-125] with the SIGNUP pool's day spent: GLOBAL_CAP, no G1 and no Harness, the PUBLIC pool untouched", async () => {
    const kit = await workerKit({ worldId: WORLD });
    const day = poolBuckets(WORLD, TEST_NOW).find((bucket) => bucket.window === "DAY");
    if (!day) throw new Error("no pool day bucket");
    await prime(kit.connector, day.key, 400);
    await turn(kit, "evt-pool-cap");
    expect(kit.g1.texts).toEqual([]);
    expect(kit.harness.requests).toEqual([]);
    expect((await kit.audited("GLOBAL_CAP"))[0]?.detail).toMatchObject({ pool: "SIGNUP", window: "DAY", cap: 400 });
    for (const bucket of poolBuckets("demo", TEST_NOW)) expect(await kit.counter(bucket.key)).toBe(0);
  });
});

describe("[FL-125] the receipt reader asks the budget before Bedrock", () => {
  async function readAt(prepare: (mc: ReturnType<typeof testConnector>) => Promise<void>) {
    const bytes = receiptPng(SUR_FIELDS);
    const mc = testConnector();
    await mc.connector.write(mc.connector.complaints.createOp(complaint(WORLD, { complaintId: "cmp-0004", customerId: "cus-0004", complaintNumber: "R-2026-000124" })));
    await mc.connector.caseItems.putEvidence(
      evidence(WORLD, {
        complaintId: "cmp-0004",
        evidenceId: "evd-img-wa-in-7",
        kind: "RECEIPT_IMAGE",
        actor: "SYSTEM",
        details: { s3Key: `up/${WORLD}/wa-in-7/0.png`, sha256: sha256Hex(bytes), contentType: "image/png", sizeBytes: bytes.length, scan: "NO_THREATS_FOUND", messageId: "wa-in-7" },
      }),
    );
    await prepare(mc);
    const now = () => TEST_NOW;
    const budget = connectorReadBudget({ connector: mc.connector, now, signupImagePool: signupImagePool(mc.connector), log: silent });
    const request: ReadReceiptRequest = { worldId: WORLD, epoch: 1, complaintId: "cmp-0004", customerId: "cus-0004", evidenceId: "evd-img-wa-in-7", simNow: new Date("2026-10-07T10:10:00-03:00") };
    return readReceiptEvidence({ connector: mc.connector, images: { get: async () => bytes }, budget, bedrock: forbiddenBedrock, log: silent, now }, request);
  }

  it("[FL-125] at the world's 20 image reads of the day: TURN_CAP and no Bedrock", async () => {
    const reading = readAt(async (mc) => prime(mc.connector, keys.runtime(WORLD, "IMGCAP", `ALL#${realDayStamp(TEST_NOW)}`), IMAGE_READ_CAPS.signupWorldPerDay));
    await expect(reading).rejects.toBeInstanceOf(ToolError);
    await expect(reading).rejects.toMatchObject({ code: "TURN_CAP" });
  });

  it("[FL-125] at the SIGNUP pool's 200 image reads of the day (GLOBALCAP#SIGNUPIMG#): TURN_CAP and no Bedrock", async () => {
    const reading = readAt(async (mc) => prime(mc.connector, keys.global("GLOBALCAP", "SIGNUPIMG", realDayStamp(TEST_NOW)), 200));
    await expect(reading).rejects.toMatchObject({ code: "TURN_CAP" });
  });
});

describe("[FL-125] guest.status tells the console that the day's limit is reached", () => {
  async function readyWorld() {
    const harness = await createSignupHarness({ start: TEST_NOW }).ready();
    await harness.connector.worlds.register(worldMeta(WORLD, { status: "READY", readyAtReal: TEST_NOW.toISOString() }));
    await harness.connector.worlds.putSettings({ ...worldSettings(WORLD), turnCaps: { perHour: 200, perDay: 60 } });
    return harness;
  }
  const caller = { sub: "3b7c1d2e-0000-4000-8000-00000000c001", worldId: WORLD, sessionId: "0d1c2b3a-0000-4000-8000-00000000a001" };

  it("[FL-125] reports the turns of today against the day cap, and the limit once a cap is reached", async () => {
    const harness = await readyWorld();
    expect((await harness.guestWorld.status(caller)).usage).toEqual({ turnsToday: 0, turnsPerDay: 60, limitReached: false });
    await prime(harness.connector, keys.runtime(WORLD, "TURNCAP", realDayStamp(TEST_NOW)), 60);
    expect((await harness.guestWorld.status(caller)).usage).toEqual({ turnsToday: 60, turnsPerDay: 60, limitReached: true });
  });

  it("[FL-125] counts on the real clock: a new real day opens the limit again, the epoch cap does not", async () => {
    const harness = await readyWorld();
    await prime(harness.connector, keys.runtime(WORLD, "TURNCAP", realDayStamp(TEST_NOW)), 60);
    harness.advance(24 * HOUR_MS);
    expect((await harness.guestWorld.status(caller)).usage).toMatchObject({ turnsToday: 0, limitReached: false });
    await prime(harness.connector, keys.runtime(WORLD, "TURNCAPEPOCH", keys.epochPart(1)), SIGNUP_TURNS_PER_EPOCH);
    expect((await harness.guestWorld.status(caller)).usage).toMatchObject({ limitReached: true });
  });

  it("[FL-125] says nothing about usage while the world is not READY", async () => {
    const harness = await createSignupHarness({ start: TEST_NOW }).ready();
    await harness.connector.worlds.register(worldMeta(WORLD, { status: "REGISTERED" }));
    expect(await harness.guestWorld.status(caller)).toEqual({ worldStatus: "REGISTERED", queuePosition: 0 });
  });
});
