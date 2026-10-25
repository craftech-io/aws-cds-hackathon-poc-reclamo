// The world's turn caps (docs/architecture.md §9.1 and §13, ADR-0017, docs/architecture-guests.md §7):
// counted on the REAL clock before G1, the preloaded reads and the Harness; a refusal is `TURN_CAP`, the
// fixed handoff notice and a person, and spends nothing of the pool.
import { describe, expect, it } from "vitest";
import { realDayStamp, realHourStamp } from "../connector/repos/caps";
import { keys } from "../connector/keys";
import type { Key } from "../connector/store";
import { SIGNUP_TURNS_PER_EPOCH, countTurn, poolBuckets, worldBuckets } from "./caps";
import { CUSTOMER, TEST_NOW, eventOf, recordOf, workerKit, type WorkerKit } from "./testing";
import { processRecord } from "./worker";

const HOUR_MS = 60 * 60_000;

async function prime(kit: WorkerKit, key: Key, count: number): Promise<void> {
  await kit.connector.write({ kind: "update", table: "Runtime", key, update: { add: { count }, set: { entity: "CapCounter", updatedAt: TEST_NOW.toISOString() } } });
}

async function customerTurn(kit: WorkerKit, eventId: string, eventAtSim = "2026-10-07T10:10:00-03:00") {
  await kit.addInbound(`msg-${eventId}`, "¿Y mi pago?", { atSim: eventAtSim });
  return processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: `msg-${eventId}`, messageAtSim: eventAtSim, complaintIds: [] }, { worldId: kit.worldId, eventId, eventAtSim }), { queue: kit.worldId.startsWith("gs-") ? "SignupCustomerEvents" : "CustomerEvents" }));
}

describe("[FL-105] the world's turn cap", () => {
  it("[FL-105] refuses the turn at the hour cap: TURN_CAP, handoff notice, a person; no G1 and no Harness", async () => {
    const kit = await workerKit();
    const complaint = await kit.addComplaint({ status: "INVESTIGATING" });
    await prime(kit, keys.runtime("demo", "TURNCAP", realHourStamp(TEST_NOW)), 200);
    await customerTurn(kit, "evt-capped");
    expect(kit.harness.requests).toHaveLength(0);
    expect(kit.g1.texts).toHaveLength(0);
    const audit = await kit.audited("TURN_CAP");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ window: "HOUR", cap: 200 });
    expect(kit.gate.requests.map((request) => request.kind)).toEqual(["HANDOFF_NOTICE"]);
    expect((await kit.connector.complaints.get("demo", complaint.complaintId))?.status).toBe("HUMAN_REVIEW");
    expect(kit.lines.some((line) => line.metric === "TurnCapHits")).toBe(true);
  });

  it("[FL-105] counts on the real clock: '+1 h' of the simulated clock opens no new bucket, a real hour does", async () => {
    const kit = await workerKit();
    await prime(kit, keys.runtime("demo", "TURNCAP", realHourStamp(TEST_NOW)), 200);
    await customerTurn(kit, "evt-sim-later", "2026-10-07T11:10:00-03:00");
    expect(kit.harness.requests).toHaveLength(0);
    kit.advanceReal(HOUR_MS);
    await customerTurn(kit, "evt-real-later", "2026-10-07T11:20:00-03:00");
    expect(kit.harness.requests).toHaveLength(1);
  });

  it("[FL-105] refuses at the day cap, and a refused turn spends nothing of the pool", async () => {
    const kit = await workerKit();
    await prime(kit, keys.runtime("demo", "TURNCAP", realDayStamp(TEST_NOW)), 1_000);
    await customerTurn(kit, "evt-day");
    expect((await kit.audited("TURN_CAP"))[0]?.detail).toMatchObject({ window: "DAY", cap: 1_000 });
    for (const bucket of poolBuckets("demo", TEST_NOW)) expect(await kit.counter(bucket.key)).toBe(0);
  });

  it("never lets a counter pass its cap however many turns race for it", async () => {
    const kit = await workerKit();
    const [bucket] = worldBuckets("demo", 1, { turnCaps: { perHour: 3, perDay: 10 } }, TEST_NOW);
    if (bucket === undefined) throw new Error("no bucket");
    const results = await Promise.all(Array.from({ length: 8 }, () => countTurn(kit.connector, bucket, TEST_NOW)));
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});

describe("[FL-125] the turn caps of a self-signup world", () => {
  it("[FL-125] counts the epoch's turns apart from the day: at 150 the epoch refuses even on a new real day", async () => {
    const kit = await workerKit({ worldId: "gs-abcdefghij" });
    expect(worldBuckets("gs-abcdefghij", 1, { turnCaps: { perHour: 200, perDay: 60 } }, TEST_NOW).map((bucket) => bucket.window)).toEqual(["HOUR", "DAY", "EPOCH"]);
    expect(worldBuckets("g01", 1, { turnCaps: { perHour: 200, perDay: 150 } }, TEST_NOW).map((bucket) => bucket.window)).toEqual(["HOUR", "DAY"]);
    await prime(kit, keys.runtime("gs-abcdefghij", "TURNCAPEPOCH", keys.epochPart(1)), SIGNUP_TURNS_PER_EPOCH);
    kit.advanceReal(24 * HOUR_MS);
    await customerTurn(kit, "evt-epoch");
    expect(kit.harness.requests).toHaveLength(0);
    expect((await kit.connector.audit.listByAction("gs-abcdefghij", "TURN_CAP"))[0]?.detail).toMatchObject({ window: "EPOCH", cap: 150 });
    expect(kit.gate.requests.map((request) => request.kind)).toEqual(["HANDOFF_NOTICE"]);
    expect(kit.gate.requests[0]?.customerId).toBe(CUSTOMER);
  });
});
