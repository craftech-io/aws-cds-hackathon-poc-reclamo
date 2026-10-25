// The pool caps (docs/architecture.md §9.1 and §13, docs/architecture-guests.md §7): every turn of a world
// also counts in its pool, PUBLIC (demo, gNN, gtest, gprobe), SIGNUP (gs-*) or QA, on the real clock,
// after the world's own caps and before G1 and the Harness. A saturated SIGNUP pool never touches the
// PUBLIC one.
import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { realHourStamp } from "../connector/repos/caps";
import { GLOBAL_TURN_CAPS, poolBuckets, poolOf } from "./caps";
import { CUSTOMER, TEST_NOW, eventOf, recordOf, workerKit, type WorkerKit } from "./testing";
import { processRecord } from "./worker";

const MINUTE_MS = 60_000;

async function customerTurn(kit: WorkerKit, eventId: string) {
  await kit.addInbound(`msg-${eventId}`, "¿Cómo va mi reclamo?");
  const queue = kit.worldId.startsWith("gs-") ? "SignupCustomerEvents" : kit.worldId.startsWith("qa") ? "QaCustomerEvents" : "CustomerEvents";
  return processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: `msg-${eventId}`, messageAtSim: "2026-10-07T10:10:00-03:00", complaintIds: [] }, { worldId: kit.worldId, eventId }), { queue }));
}

describe("[FL-105] [FL-125] the pool of a world", () => {
  it.each([
    ["demo", "PUBLIC"],
    ["g07", "PUBLIC"],
    ["gtest", "PUBLIC"],
    ["gprobe", "PUBLIC"],
    ["gs-abcdefghij", "SIGNUP"],
    ["qa-run1-sc19", "QA"],
    ["qamin", "QA"],
    ["sim-batch1", "QA"],
  ])("[FL-125] %s counts in the %s pool", (worldId, pool) => {
    expect(poolOf(worldId)).toBe(pool);
  });

  it("[FL-125] keys the SIGNUP pool under GLOBALCAP#SIGNUP# (the self-signup worker's only global write) with a 5-per-minute window", () => {
    const buckets = poolBuckets("gs-abcdefghij", TEST_NOW);
    expect(buckets.map((bucket) => [bucket.window, bucket.limit])).toEqual([
      ["MINUTE", 5],
      ["HOUR", 60],
      ["DAY", 400],
    ]);
    for (const bucket of buckets) expect(bucket.key.pk.startsWith("GLOBALCAP#SIGNUP#")).toBe(true);
    expect(GLOBAL_TURN_CAPS.PUBLIC).toEqual({ HOUR: 300, DAY: 1_500 });
  });
});

describe("[FL-105] the PUBLIC pool", () => {
  it("[FL-105] refuses a turn when the pool's hour is spent: GLOBAL_CAP, handoff, no G1 and no Harness", async () => {
    const kit = await workerKit();
    await kit.connector.write({ kind: "update", table: "Runtime", key: keys.global("GLOBALCAP", "PUBLIC", realHourStamp(TEST_NOW)), update: { add: { count: 300 }, set: { entity: "CapCounter" } } });
    await customerTurn(kit, "evt-public");
    expect(kit.harness.requests).toHaveLength(0);
    expect(kit.g1.texts).toHaveLength(0);
    expect((await kit.audited("GLOBAL_CAP"))[0]?.detail).toMatchObject({ pool: "PUBLIC", window: "HOUR", cap: 300 });
    expect(kit.gate.requests.map((request) => request.kind)).toEqual(["HANDOFF_NOTICE"]);
    expect(kit.lines.some((line) => line.metric === "GlobalCapHits")).toBe(true);
  });
});

describe("[FL-125] the SIGNUP pool", () => {
  it("[FL-125] lets 5 turns of the self-signup worlds through per real minute and refuses the sixth", async () => {
    const kit = await workerKit({ worldId: "gs-abcdefghij" });
    for (let turn = 1; turn <= 6; turn += 1) await customerTurn(kit, `evt-burst-${turn}`);
    expect(kit.harness.requests).toHaveLength(5);
    const refused = await kit.connector.audit.listByAction("gs-abcdefghij", "GLOBAL_CAP");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.detail).toMatchObject({ pool: "SIGNUP", window: "MINUTE", cap: 5 });
    expect(refused[0]?.refs).toMatchObject({ customerId: CUSTOMER, eventId: "evt-burst-6" });
    kit.advanceReal(MINUTE_MS);
    await customerTurn(kit, "evt-next-minute");
    expect(kit.harness.requests).toHaveLength(6);
  });

  it("[FL-125] a saturated SIGNUP pool leaves the PUBLIC pool and its worlds untouched", async () => {
    const signup = await workerKit({ worldId: "gs-abcdefghij" });
    for (const bucket of poolBuckets("gs-abcdefghij", TEST_NOW)) await signup.connector.write({ kind: "update", table: "Runtime", key: bucket.key, update: { add: { count: bucket.limit }, set: { entity: "CapCounter" } } });
    await customerTurn(signup, "evt-saturated");
    expect(signup.harness.requests).toHaveLength(0);
    // The same table, a guest world of the PUBLIC pool: its turn runs and counts only in PUBLIC.
    const guest = await workerKit({ worldId: "g07" });
    await guest.connector.write({ kind: "update", table: "Runtime", key: poolBuckets("gs-abcdefghij", TEST_NOW)[0]?.key ?? keys.global("GLOBALCAP", "SIGNUP", "x"), update: { add: { count: 5 }, set: { entity: "CapCounter" } } });
    await customerTurn(guest, "evt-guest");
    expect(guest.harness.requests).toHaveLength(1);
    for (const bucket of poolBuckets("g07", TEST_NOW)) expect(await guest.counter(bucket.key)).toBe(1);
  });
});
