import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { GUEST_WORLD_LIMITS } from "../leads/limits";
import { handleWorldCreate, provisionPass, provisionTicketOp } from "./guest-provision";
import { GUEST_CAP_KEY, guestQueueAttributes, readCapacity } from "./meta";
import { UNLIMITED } from "./deps";
import { budgetOf, worldsRig } from "./testing";

type Rig = ReturnType<typeof worldsRig>;

const W1 = "gs-aaaaaaaaaa";
const W2 = "gs-bbbbbbbbbb";
const W3 = "gs-cccccccccc";

/** What the post-confirmation trigger leaves (docs/architecture-guests.md §3, §5): world, staff row, ticket. */
async function signedUp(rig: Rig, worldId: string, requestId: string, requestedAt = rig.now()): Promise<void> {
  const at = requestedAt.toISOString();
  await rig.mc.store.write({
    kind: "put",
    table: "Worlds",
    item: { ...keys.worldMeta(worldId), entity: "World", worldId, kind: "GUEST", template: "guest", epoch: 1, status: "REGISTERED", origin: "SIGNUP", requestedAtReal: at, version: 1, ...guestQueueAttributes(worldId, "REGISTERED", at) },
  });
  await rig.mc.connector.worlds.putStaff({ worldId, staffId: `stf-${worldId}`, role: "GUEST", displayName: "Invitado", cognitoSubKey: `SUB#sub-${worldId}`, active: true });
  await rig.mc.connector.write(provisionTicketOp(rig.deps, worldId, requestId));
}

const ticket = (rig: Rig, worldId: string, requestId: string) => rig.mc.store.get("Runtime", keys.runtime(worldId, "PROVISIONREQ", requestId));

describe("Self-signup worlds: preparing and ready [FL-120]", () => {
  it("[FL-120] builds the world of a confirmed sign-up from its ticket: guest template, SIGNUP caps, WhatsApp simulated, READY last", async () => {
    const rig = worldsRig();
    await signedUp(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1");
    const result = await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }, UNLIMITED);
    expect(result).toEqual({ status: "READY" });
    const meta = await rig.mc.store.get("Worlds", keys.worldMeta(W1));
    expect(meta).toMatchObject({ status: "READY", epoch: 1, guestIndexKey: "GUEST#READY", provisionRequestId: "01K7AAAAAAAAAAAAAAAAAAAAA1", readyAtReal: rig.now().toISOString() });
    const settings = await rig.mc.connector.worlds.getSettings(W1);
    expect(settings).toMatchObject({ channelModes: { whatsapp: "simulated" }, imageReadsPerDay: GUEST_WORLD_LIMITS.imageReadsPerDay, turnCaps: { perDay: GUEST_WORLD_LIMITS.turnsPerDay } });
    expect(await readCapacity(rig.deps)).toMatchObject({ active: 1, creating: 0 });
    expect(await ticket(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1")).toMatchObject({ status: "DONE" });
    expect(await rig.mc.connector.audit.listByAction(W1, "GUEST_WORLD_READY")).toHaveLength(1);
    expect(rig.logs.some((line) => line.includes("WorldCreateDuration"))).toBe(true);
  });

  it("[FL-120] refuses without a ticket in the world's partition (PROVISION_REQUEST_MISSING) and builds nothing", async () => {
    const rig = worldsRig();
    await signedUp(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1");
    expect(await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA9" }, UNLIMITED)).toEqual({ status: "MISSING" });
    expect(await rig.mc.connector.audit.listByAction(W1, "PROVISION_REQUEST_MISSING")).toHaveLength(1);
    expect((await rig.mc.connector.worlds.getMeta(W1, { consistent: true }))?.status).toBe("REGISTERED");
  });

  it("[FL-120] continues a creation cut by the budget with the same ticket, never READY half-built", async () => {
    const rig = worldsRig();
    await signedUp(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1");
    expect(await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }, budgetOf(3))).toEqual({ status: "CONTINUED" });
    expect((await rig.mc.connector.worlds.getMeta(W1, { consistent: true }))?.status).toBe("CREATING");
    expect(rig.invoked).toEqual([{ kind: "WORLD_CREATE", worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }]);
    expect(await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }, UNLIMITED)).toEqual({ status: "READY" });
    expect(await readCapacity(rig.deps)).toMatchObject({ active: 1, creating: 0 });
  });

  it("[FL-120] lets only the request that started the build finish it; another one ends superseded", async () => {
    const rig = worldsRig();
    await signedUp(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1");
    await rig.mc.connector.write(provisionTicketOp(rig.deps, W1, "01K7AAAAAAAAAAAAAAAAAAAAA2"));
    await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }, budgetOf(3));
    expect(await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA2" }, UNLIMITED)).toEqual({ status: "SUPERSEDED" });
    expect((await rig.mc.connector.worlds.getMeta(W1, { consistent: true }))?.status).toBe("CREATING");
  });
});

describe("Self-signup worlds: the queue and its capacity [FL-117]", () => {
  it("[FL-117] with 40 active worlds a confirmed sign-up waits REGISTERED with its ticket open, never a 41st", async () => {
    const rig = worldsRig();
    await rig.mc.store.write({ kind: "put", table: "Runtime", item: { ...GUEST_CAP_KEY, entity: "GuestCapacity", active: GUEST_WORLD_LIMITS.activeWorlds, creating: 0, version: 1 } });
    await signedUp(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1");
    expect(await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }, UNLIMITED)).toEqual({ status: "QUEUED" });
    expect(await rig.mc.connector.worlds.getMeta(W1, { consistent: true })).toMatchObject({ status: "REGISTERED" });
    expect(await ticket(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1")).toMatchObject({ status: "OPEN" });
    expect(await readCapacity(rig.deps)).toMatchObject({ active: 40, creating: 0 });
    expect(await rig.mc.connector.audit.listByAction(W1, "GUEST_WORLD_QUEUED")).toHaveLength(1);
  });

  it("[FL-117] with 3 creations in progress the fourth waits", async () => {
    const rig = worldsRig();
    await rig.mc.store.write({ kind: "put", table: "Runtime", item: { ...GUEST_CAP_KEY, entity: "GuestCapacity", active: 3, creating: GUEST_WORLD_LIMITS.simultaneousCreations, version: 1 } });
    await signedUp(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1");
    expect(await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }, UNLIMITED)).toEqual({ status: "QUEUED" });
  });

  it("[FL-117] the pass numbers the queue, starts one world per free place (oldest first) and expires a request older than 7 days", async () => {
    const rig = worldsRig();
    const start = rig.now().getTime();
    await signedUp(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1", new Date(start - 8 * 24 * 3_600_000));
    await signedUp(rig, W2, "01K7AAAAAAAAAAAAAAAAAAAAA2", new Date(start - 60_000));
    await signedUp(rig, W3, "01K7AAAAAAAAAAAAAAAAAAAAA3", new Date(start - 30_000));
    await rig.mc.store.write({ kind: "put", table: "Runtime", item: { ...GUEST_CAP_KEY, entity: "GuestCapacity", active: GUEST_WORLD_LIMITS.activeWorlds - 1, creating: 0, version: 1 } });

    const result = await provisionPass(rig.deps);
    expect(result).toMatchObject({ queued: 2, started: 1 });
    expect(await rig.mc.connector.worlds.getMeta(W1, { consistent: true })).toMatchObject({ status: "EXPIRED" });
    expect(await rig.mc.connector.worlds.getMeta(W2, { consistent: true })).toMatchObject({ status: "REGISTERED", queuePosition: 0 });
    expect(await rig.mc.connector.worlds.getMeta(W3, { consistent: true })).toMatchObject({ status: "REGISTERED", queuePosition: 1 });
    expect(rig.invoked).toHaveLength(1);
    const [started] = rig.invoked;
    expect(started).toMatchObject({ kind: "WORLD_CREATE", worldId: W2 });
    expect(await handleWorldCreate(rig.deps, { worldId: W2, requestId: started?.requestId ?? "" }, UNLIMITED)).toEqual({ status: "READY" });
    expect(await readCapacity(rig.deps)).toMatchObject({ active: GUEST_WORLD_LIMITS.activeWorlds, creating: 0 });
    expect(await handleWorldCreate(rig.deps, { worldId: W3, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA3" }, UNLIMITED)).toEqual({ status: "QUEUED" });
  });

  it("[FL-117] resumes a creation without a heartbeat for 20 minutes and raises WorldCreateStuck after three attempts without progress", async () => {
    const rig = worldsRig();
    await signedUp(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1");
    await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }, budgetOf(3));
    rig.invoked.length = 0;
    const outcomes: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      rig.advance(21 * 60_000);
      outcomes.push((await provisionPass(rig.deps)).resumed);
    }
    expect(outcomes).toEqual([1, 1, 1]);
    expect(rig.invoked).toHaveLength(3);
    expect(rig.logs.some((line) => line.includes("WorldCreateStuck"))).toBe(true);
    expect(await ticket(rig, W1, "01K7AAAAAAAAAAAAAAAAAAAAA1")).toMatchObject({ status: "OPEN", attempts: 3 });
    expect(await handleWorldCreate(rig.deps, { worldId: W1, requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" }, UNLIMITED)).toEqual({ status: "READY" });
  });
});
