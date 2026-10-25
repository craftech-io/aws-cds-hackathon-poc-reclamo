import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { actorIdOf } from "../turns/identity";
import { UNLIMITED } from "./deps";
import { DORMANT_ACCOUNT_MS, deleteUnconfirmedAccounts, expiryPass, expiryReasonOf, retireDormantAccounts } from "./guest-expiry";
import { handleWorldCreate, provisionTicketOp } from "./guest-provision";
import { guestQueueAttributes, metaUpdateOp, readCapacity } from "./meta";
import { requestWorldReset } from "./reset";
import { runWorldReset } from "./reset-work";
import { fakeAccounts, worldsRig } from "./testing";

type Rig = ReturnType<typeof worldsRig>;
const HOUR = 3_600_000;
const GS = "gs-dddddddddd";

async function readyGuest(rig: Rig, worldId = GS): Promise<void> {
  const at = rig.now().toISOString();
  await rig.mc.store.write({
    kind: "put",
    table: "Worlds",
    item: { ...keys.worldMeta(worldId), entity: "World", worldId, kind: "GUEST", template: "guest", epoch: 1, status: "REGISTERED", origin: "SIGNUP", requestedAtReal: at, version: 1, ...guestQueueAttributes(worldId, "REGISTERED", at) },
  });
  await rig.mc.connector.worlds.putStaff({ worldId, staffId: `stf-${worldId}`, role: "GUEST", displayName: "Invitado", cognitoSubKey: "SUB#sub-guest-1", active: true });
  await rig.mc.connector.write(provisionTicketOp(rig.deps, worldId, "01K7BBBBBBBBBBBBBBBBBBBBB1"));
  await handleWorldCreate(rig.deps, { worldId, requestId: "01K7BBBBBBBBBBBBBBBBBBBBB1" }, UNLIMITED);
}

/** What `guest.requestWorld` does with an expired world (docs/architecture-guests.md §4). */
async function askAgain(rig: Rig, worldId: string, requestId: string): Promise<void> {
  await rig.mc.connector.transact([
    metaUpdateOp(rig.deps, { worldId, from: "EXPIRED", to: "REGISTERED", set: { requestedAtReal: rig.now().toISOString() } }),
    provisionTicketOp(rig.deps, worldId, requestId),
  ]);
}

describe("Expiry of a self-signup world and its recreation [FL-124]", () => {
  it("[FL-124] expires 6 h after READY without a sign-in, 72 h after the last activity, or 7 days after READY", () => {
    const ready = "2026-10-07T10:00:00.000Z";
    const at = (hours: number) => new Date(Date.parse(ready) + hours * HOUR);
    expect(expiryReasonOf({ readyAtReal: ready }, at(5.9))).toBeUndefined();
    expect(expiryReasonOf({ readyAtReal: ready }, at(6))).toBe("NO_SIGN_IN");
    expect(expiryReasonOf({ readyAtReal: ready, lastActivityAtReal: at(1).toISOString() }, at(72))).toBeUndefined();
    expect(expiryReasonOf({ readyAtReal: ready, lastActivityAtReal: at(1).toISOString() }, at(73))).toBe("INACTIVE");
    expect(expiryReasonOf({ readyAtReal: ready, lastActivityAtReal: at(160).toISOString() }, at(168))).toBe("MAX_AGE");
  });

  it("[FL-124] expiring keeps the account, META, SETTINGS, STAFF#, the register and the audit log; wipes the rest and frees the place", async () => {
    const rig = worldsRig();
    await readyGuest(rig);
    rig.memory.add(actorIdOf(GS, "cus-0001", 1));
    rig.advance(7 * HOUR);
    expect(await expiryPass(rig.deps)).toMatchObject({ expiring: 1 });
    const [invoked] = rig.invoked.filter((event) => event.kind === "WORLD_RESET");
    expect(await rig.mc.connector.worlds.getMeta(GS, { consistent: true })).toMatchObject({ status: "EXPIRING" });
    expect(await runWorldReset(rig.deps, { worldId: GS, requestId: invoked?.requestId ?? "" }, UNLIMITED)).toMatchObject({ status: "EXPIRED" });

    const meta = await rig.mc.store.get("Worlds", keys.worldMeta(GS));
    expect(meta).toMatchObject({ status: "EXPIRED", epoch: 2, guestIndexKey: "GUEST#EXPIRED" });
    expect(meta?.readyAtReal).toBeUndefined();
    expect(await rig.mc.connector.worlds.getSettings(GS)).toBeDefined();
    expect(await rig.mc.connector.worlds.listStaff(GS)).toHaveLength(1);
    expect((await rig.mc.connector.worldItems.listKeys("Core", GS)).keys).toHaveLength(0);
    expect((await rig.mc.connector.chains.readHead(GS, 1, "REG"))?.value).toBeGreaterThan(0);
    expect(rig.memory.actors.get(actorIdOf(GS, "cus-0001", 1))?.records.size).toBe(0);
    expect(await readCapacity(rig.deps)).toMatchObject({ active: 0, creating: 0 });
    expect(await rig.mc.connector.audit.listByAction(GS, "GUEST_WORLD_EXPIRED")).toHaveLength(1);
    expect(rig.logs.some((line) => line.includes("GuestWorldsExpired"))).toBe(true);
  });

  it("gives a world leads:delete left EXPIRING without a request the expiry it lacks, once", async () => {
    const rig = worldsRig();
    await readyGuest(rig);
    // What scripts/leads/delete.ts writes: the status alone, no request, no ticket.
    await rig.mc.connector.write(metaUpdateOp(rig.deps, { worldId: GS, from: "READY", to: "EXPIRING" }));
    expect(await expiryPass(rig.deps)).toMatchObject({ expiring: 1 });
    const [invoked] = rig.invoked.filter((event) => event.kind === "WORLD_RESET");
    expect(await rig.mc.connector.worlds.getMeta(GS, { consistent: true })).toMatchObject({ status: "EXPIRING", reset: { requestId: invoked?.requestId } });
    expect(await expiryPass(rig.deps)).toMatchObject({ expiring: 0 });
    expect(await runWorldReset(rig.deps, { worldId: GS, requestId: invoked?.requestId ?? "" }, UNLIMITED)).toMatchObject({ status: "EXPIRED" });
    expect(await readCapacity(rig.deps)).toMatchObject({ active: 0 });
  });

  it("[FL-124] a world asked for again comes back with the same id, a new epoch and the clean template", async () => {
    const rig = worldsRig();
    await readyGuest(rig);
    rig.advance(7 * HOUR);
    await expiryPass(rig.deps);
    const [expiry] = rig.invoked.filter((event) => event.kind === "WORLD_RESET");
    await runWorldReset(rig.deps, { worldId: GS, requestId: expiry?.requestId ?? "" }, UNLIMITED);

    await askAgain(rig, GS, "01K7BBBBBBBBBBBBBBBBBBBBB2");
    expect(await handleWorldCreate(rig.deps, { worldId: GS, requestId: "01K7BBBBBBBBBBBBBBBBBBBBB2" }, UNLIMITED)).toEqual({ status: "READY" });
    const meta = await rig.mc.connector.worlds.getMeta(GS, { consistent: true });
    expect(meta).toMatchObject({ status: "READY", epoch: 2 });
    expect(meta?.lastActivityAtReal).toBeUndefined();
    expect((await rig.mc.connector.runtime.getClock(GS))?.worldEpoch).toBe(2);
    expect((await rig.mc.connector.chains.readHead(GS, 2, "REG"))?.value).toBe((await rig.mc.connector.chains.readHead(GS, 1, "REG"))?.value);
    expect(await readCapacity(rig.deps)).toMatchObject({ active: 1, creating: 0 });
  });

  it("[FL-124] an invited guest world never expires", async () => {
    const rig = worldsRig();
    await expect(requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM", kind: "EXPIRE" })).rejects.toMatchObject({ code: "FORBIDDEN", reason: "NOT_EXPIRABLE" });
  });

  it("[FL-124] a scenario's QA world never expires; the runner's sign-up world does, like a gs-* (guest.expireNow)", async () => {
    const rig = worldsRig();
    await expect(requestWorldReset(rig.deps, { worldId: "qa-1234-1-sc18", actor: "SYSTEM", kind: "EXPIRE" })).rejects.toMatchObject({ code: "FORBIDDEN", reason: "NOT_EXPIRABLE" });
    await expect(requestWorldReset(rig.deps, { worldId: "qa-1234-1-su1", actor: "SYSTEM", kind: "EXPIRE" })).rejects.not.toMatchObject({ reason: "NOT_EXPIRABLE" });
  });

  it("[FL-124] deletes only self-signup accounts left unconfirmed for 48 h", async () => {
    const rig = worldsRig();
    const old = new Date(rig.now().getTime() - 49 * HOUR);
    const accounts = fakeAccounts([
      { username: "visitante@example.org", status: "UNCONFIRMED", createdAt: old },
      { username: "reciente@example.org", status: "UNCONFIRMED", createdAt: rig.now() },
      { username: "operator-01", status: "UNCONFIRMED", createdAt: old },
    ]);
    const withAccounts = worldsRig({ accounts });
    expect(await deleteUnconfirmedAccounts(withAccounts.deps)).toBe(1);
    expect(accounts.deleted).toEqual(["visitante@example.org"]);
  });

  it("[FL-124] retires a self-signup account whose world has been expired for 24 months", async () => {
    const accounts = fakeAccounts([{ username: "dormido@example.org", status: "CONFIRMED", createdAt: new Date("2026-01-01T00:00:00.000Z") }]);
    const rig = worldsRig({ accounts });
    await readyGuest(rig);
    rig.advance(7 * HOUR);
    await expiryPass(rig.deps);
    const [expiry] = rig.invoked.filter((event) => event.kind === "WORLD_RESET");
    await runWorldReset(rig.deps, { worldId: GS, requestId: expiry?.requestId ?? "" }, UNLIMITED);

    expect(await retireDormantAccounts(rig.deps)).toBe(0);
    rig.advance(DORMANT_ACCOUNT_MS + HOUR);
    expect(await retireDormantAccounts(rig.deps)).toBe(1);
    expect(accounts.deleted).toEqual(["dormido@example.org"]);
    expect((await rig.mc.connector.worlds.listStaff(GS))[0]).toMatchObject({ active: false });
    const meta = await rig.mc.store.get("Worlds", keys.worldMeta(GS));
    expect(meta?.guestIndexKey).toBeUndefined();
    expect(typeof meta?.expiresAt).toBe("number");
  });
});
