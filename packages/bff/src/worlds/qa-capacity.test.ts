import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { QA_GUEST_WORLD_LIMITS } from "../leads/limits";
import { UNLIMITED } from "./deps";
import { destroyWorld } from "./destroy";
import { expiryPass } from "./guest-expiry";
import { handleWorldCreate, provisionPass, provisionTicketOp } from "./guest-provision";
import { runJanitor } from "./janitor";
import { activeLimitFor, guestQueueAttributes, metaUpdateOp, primeQaCapacityOp, readCapacity } from "./meta";
import { runWorldReset } from "./reset-work";
import { budgetOf, fakeAccounts, worldsRig } from "./testing";

type Rig = ReturnType<typeof worldsRig>;
const HOUR = 3_600_000;
const RUN_1 = "111-1";
const RUN_2 = "222-1";

/** What the post-confirmation trigger leaves for one of the runner's sign-ups: world, staff row, ticket. */
async function signedUp(rig: Rig, worldId: string, requestId: string): Promise<void> {
  const at = rig.now().toISOString();
  await rig.mc.store.write({
    kind: "put",
    table: "Worlds",
    item: { ...keys.worldMeta(worldId), entity: "World", worldId, kind: "QA", template: "guest", epoch: 1, status: "REGISTERED", origin: "SIGNUP", requestedAtReal: at, version: 1, ...guestQueueAttributes(worldId, "REGISTERED", at) },
  });
  await rig.mc.connector.worlds.putStaff({ worldId, staffId: `stf-${worldId}`, role: "GUEST", displayName: "Invitado", cognitoSubKey: `SUB#sub-${worldId}`, active: true });
  await rig.mc.connector.write(provisionTicketOp(rig.deps, worldId, requestId));
}

async function readyQa(rig: Rig, worldId: string, requestId: string): Promise<void> {
  await signedUp(rig, worldId, requestId);
  expect(await handleWorldCreate(rig.deps, { worldId, requestId }, UNLIMITED)).toEqual({ status: "READY" });
}

describe("The runner's sign-up capacity: a prime scoped to its run, places that come back [FL-117]", () => {
  it("[FL-117] a primed limit binds only the worlds of the run that primed it, and lapses after an hour", async () => {
    const rig = worldsRig();
    await readyQa(rig, `qa-${RUN_1}-su1`, "01K7CCCCCCCCCCCCCCCCCCCCC1");
    await rig.mc.store.write(primeQaCapacityOp(rig.deps, 1, RUN_1));
    await signedUp(rig, `qa-${RUN_1}-su2`, "01K7CCCCCCCCCCCCCCCCCCCCC2");
    expect(await handleWorldCreate(rig.deps, { worldId: `qa-${RUN_1}-su2`, requestId: "01K7CCCCCCCCCCCCCCCCCCCCC2" }, UNLIMITED)).toEqual({ status: "QUEUED" });

    // Another run (in parallel, or the next one) never sees the prime.
    await readyQa(rig, `qa-${RUN_2}-su1`, "01K7CCCCCCCCCCCCCCCCCCCCC3");
    expect(await readCapacity(rig.deps, "QA")).toMatchObject({ active: 2, activeLimit: QA_GUEST_WORLD_LIMITS.activeWorlds, prime: { limit: 1, runId: RUN_1 } });

    rig.advance(QA_GUEST_WORLD_LIMITS.primeMinutes * 60_000 + 1);
    const lapsed = await readCapacity(rig.deps, "QA");
    expect(activeLimitFor(lapsed, `qa-${RUN_1}-su2`, rig.now())).toBe(QA_GUEST_WORLD_LIMITS.activeWorlds);
    expect(await provisionPass(rig.deps)).toMatchObject({ started: 1 });
    const [started] = rig.invoked.filter((event) => event.kind === "WORLD_CREATE");
    expect(await handleWorldCreate(rig.deps, { worldId: `qa-${RUN_1}-su2`, requestId: started?.requestId ?? "" }, UNLIMITED)).toEqual({ status: "READY" });
    expect(await readCapacity(rig.deps)).toMatchObject({ active: 0 });
  });

  it("[FL-117] after a run primed to 1 and left su2 READY, the next run's su1 is READY at once, without waiting for the heal", async () => {
    const rig = worldsRig();
    await readyQa(rig, `qa-${RUN_1}-su1`, "01K7DDDDDDDDDDDDDDDDDDDDD1");
    await rig.mc.store.write(primeQaCapacityOp(rig.deps, 1, RUN_1));
    await signedUp(rig, `qa-${RUN_1}-su2`, "01K7DDDDDDDDDDDDDDDDDDDDD2");
    // SC-24/5: su1 expired, the pass builds su2; the run ends with su2 READY and the prime still live.
    await destroyWorld(rig.deps, `qa-${RUN_1}-su1`, UNLIMITED);
    expect(await handleWorldCreate(rig.deps, { worldId: `qa-${RUN_1}-su2`, requestId: "01K7DDDDDDDDDDDDDDDDDDDDD2" }, UNLIMITED)).toEqual({ status: "READY" });
    expect(await readCapacity(rig.deps, "QA")).toMatchObject({ active: 1, creating: 0 });

    rig.advance(60_000);
    await readyQa(rig, `qa-${RUN_2}-su1`, "01K7DDDDDDDDDDDDDDDDDDDDD3");
    // Teardown of the first run: the place comes back in the same transaction that deletes META.
    expect(await destroyWorld(rig.deps, `qa-${RUN_1}-su2`, UNLIMITED)).toBe("DESTROYED");
    expect(await rig.mc.connector.worlds.getMeta(`qa-${RUN_1}-su2`)).toBeUndefined();
    expect(await readCapacity(rig.deps, "QA")).toMatchObject({ active: 1, creating: 0 });
  });

  it("[FL-117] destroying a sign-up world mid-build gives back its place and its creation slot", async () => {
    const rig = worldsRig();
    await signedUp(rig, `qa-${RUN_1}-su1`, "01K7EEEEEEEEEEEEEEEEEEEEE1");
    expect(await handleWorldCreate(rig.deps, { worldId: `qa-${RUN_1}-su1`, requestId: "01K7EEEEEEEEEEEEEEEEEEEEE1" }, budgetOf(3))).toEqual({ status: "CONTINUED" });
    expect(await readCapacity(rig.deps, "QA")).toMatchObject({ active: 1, creating: 1 });
    expect(await destroyWorld(rig.deps, `qa-${RUN_1}-su1`, UNLIMITED)).toBe("DESTROYED");
    expect(await readCapacity(rig.deps, "QA")).toMatchObject({ active: 0, creating: 0 });
    // A second destroy finds nothing to give back.
    expect(await destroyWorld(rig.deps, `qa-${RUN_1}-su1`, UNLIMITED)).toBe("ABSENT");
    expect(await readCapacity(rig.deps, "QA")).toMatchObject({ active: 0, creating: 0 });
  });

  it("[FL-124] a run's READY sign-up world expires 6 h after READY even while in use, and frees its place", async () => {
    const rig = worldsRig();
    const worldId = `qa-${RUN_1}-su1`;
    await readyQa(rig, worldId, "01K7FFFFFFFFFFFFFFFFFFFFF1");
    rig.advance(5 * HOUR);
    await rig.mc.connector.write(metaUpdateOp(rig.deps, { worldId, from: "READY", set: { lastActivityAtReal: rig.now().toISOString() } }));
    expect(await expiryPass(rig.deps)).toMatchObject({ expiring: 0 });
    rig.advance(HOUR + 60_000);
    expect(await expiryPass(rig.deps)).toMatchObject({ expiring: 1 });
    const [expiry] = rig.invoked.filter((event) => event.kind === "WORLD_RESET");
    expect(await runWorldReset(rig.deps, { worldId, requestId: expiry?.requestId ?? "" }, UNLIMITED)).toMatchObject({ status: "EXPIRED" });
    expect(await readCapacity(rig.deps, "QA")).toMatchObject({ active: 0, creating: 0 });
  });

  it("[FL-099] the hourly pass destroys a runner's sign-up world and account left for 6 h, freeing its place; never another account", async () => {
    const created = new Date("2026-10-07T09:00:00.000Z");
    const accounts = fakeAccounts([
      { username: `success+qa-${RUN_1}-su1@simulator.amazonses.com`, status: "CONFIRMED", createdAt: created },
      { username: "success+qa-otro@simulator.amazonses.com", status: "CONFIRMED", createdAt: created },
      { username: "qa-otro@simulator.amazonses.com", status: "CONFIRMED", createdAt: created },
    ]);
    const rig = worldsRig({ accounts });
    await readyQa(rig, `qa-${RUN_1}-su1`, "01K7GGGGGGGGGGGGGGGGGGGGG1");
    rig.advance(7 * HOUR);
    expect(await runJanitor(rig.deps, { kind: "HOURLY_PASS" }, UNLIMITED)).toMatchObject({ counts: { qaWorlds: 1, qaUsers: 1 } });
    expect(accounts.deleted).toEqual([`success+qa-${RUN_1}-su1@simulator.amazonses.com`]);
    expect(await rig.mc.connector.worlds.getMeta(`qa-${RUN_1}-su1`)).toBeUndefined();
    expect(await readCapacity(rig.deps, "QA")).toMatchObject({ active: 0, creating: 0 });
  });
});
