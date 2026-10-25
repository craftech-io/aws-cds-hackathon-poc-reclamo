// Worlds, settings and staff over the memory connector: pre-registration once, status changes only
// from the status they leave, staff rows as the only source of a console user's world.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@reclamo/shared";
import { staff, testConnector, worldMeta, worldSettings } from "../testing";

describe("worlds", () => {
  it("pre-registers a world once and walks REGISTERED → CREATING → READY conditionally", async () => {
    const { connector } = testConnector();
    await connector.worlds.register(worldMeta("g01"));
    await expect(connector.worlds.register(worldMeta("g01"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.worlds.status("g01")).toBe("REGISTERED");

    const creating = await connector.worlds.changeMeta({ worldId: "g01", from: "REGISTERED", to: "CREATING" });
    expect(creating).toMatchObject({ status: "CREATING", version: 2 });
    await expect(connector.worlds.changeMeta({ worldId: "g01", from: "REGISTERED", to: "CREATING" })).rejects.toMatchObject({ code: "CONFLICT" });

    await connector.worlds.changeMeta({ worldId: "g01", from: "CREATING", set: { buildCursor: { phase: "CORE", block: 3 } } });
    const ready = await connector.worlds.changeMeta({ worldId: "g01", from: "CREATING", to: "READY", remove: ["buildCursor"] });
    expect(ready.status).toBe("READY");
    expect(ready.buildCursor).toBeUndefined();
  });

  it("leaves RESETTING only with the reset request that started it", async () => {
    const { connector } = testConnector();
    await connector.worlds.register(worldMeta("demo", { status: "READY" }));
    const reset = { requestId: "req-1", fromEpoch: 1, toEpoch: 2, phase: "WIPE" as const, requestedAtReal: "2026-10-07T13:10:00Z", heartbeatAtReal: "2026-10-07T13:10:00Z", attempts: 0 };
    await connector.worlds.changeMeta({ worldId: "demo", from: "READY", to: "RESETTING", set: { reset } });
    await expect(connector.worlds.changeMeta({ worldId: "demo", from: "READY", to: "RESETTING", set: { reset } })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(connector.worlds.changeMeta({ worldId: "demo", from: "RESETTING", to: "READY", resetRequestId: "req-other", remove: ["reset"] })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const done = await connector.worlds.changeMeta({ worldId: "demo", from: "RESETTING", to: "READY", resetRequestId: "req-1", set: { epoch: 2, lastResetAtReal: "2026-10-07T13:30:00Z" }, remove: ["reset"] });
    expect(done).toMatchObject({ status: "READY", epoch: 2 });
    expect(done.reset).toBeUndefined();
  });

  it("refuses a world whose kind is not the class of its id, and an unknown world id", async () => {
    const { connector } = testConnector();
    await expect(connector.worlds.register(worldMeta("g01", { kind: "QA" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(connector.worlds.getMeta("Demo#x")).rejects.toBeInstanceOf(ConnectorError);
    expect(await connector.worlds.getMeta("g02")).toBeUndefined();
  });

  it("keys every row of a world under W#<worldId>#WORLD", async () => {
    const { connector, store } = testConnector();
    await connector.worlds.register(worldMeta("g07"));
    await connector.worlds.putSettings(worldSettings("g07"));
    await connector.worlds.putStaff(staff("g07", "stf-guest-07", "sub-07"));
    expect(store.dump("Worlds").map((row) => `${row.pk}|${row.sk}`)).toEqual(["W#g07#WORLD|META", "W#g07#WORLD|SETTINGS", "W#g07#WORLD|STAFF#stf-guest-07"]);
    expect(store.dump("Worlds").every((row) => row.worldId === "g07" && row.version === 1 && row.createdAt === "2026-10-07T13:10:00.000Z")).toBe(true);
    // A guest world's rows expire, but long after a trial (90 days).
    expect(store.dump("Worlds")[0]?.expiresAt).toBe(Math.floor(Date.parse("2026-10-07T13:10:00Z") / 1000) + 90 * 86_400);
  });

  it("changes settings only over the version it read", async () => {
    const { connector } = testConnector();
    await connector.worlds.putSettings(worldSettings("demo"));
    await expect(connector.worlds.putSettings(worldSettings("demo"))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.worlds.putSettings({ ...worldSettings("demo"), maxProactivePerDay: 2 }, 1);
    await expect(connector.worlds.putSettings(worldSettings("demo"), 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.worlds.getSettings("demo")).toMatchObject({ maxProactivePerDay: 2, version: 2, channelModes: { whatsapp: "simulated" } });
  });
});

describe("staff", () => {
  it("reads the row a token names and finds the rows of a Cognito sub", async () => {
    const { connector } = testConnector();
    await connector.worlds.putStaff(staff("qa-r1-sc21", "stf-qa-operator", "sub-qa"));
    await connector.worlds.putStaff(staff("demo", "stf-lucia", "sub-lucia"));
    expect(await connector.worlds.getStaff("qa-r1-sc21", "stf-qa-operator")).toMatchObject({ cognitoSubKey: "SUB#sub-qa", active: true, role: "OPERATOR" });
    expect(await connector.worlds.getStaff("demo", "stf-qa-operator")).toBeUndefined();
    const bySub = await connector.worlds.findStaffBySub("sub-lucia");
    expect(bySub.map((row) => [row.worldId, row.staffId])).toEqual([["demo", "stf-lucia"]]);
    expect(await connector.worlds.findStaffBySub("sub-nobody")).toEqual([]);
  });

  it("writes a staff row once unless replaced, lists a world's staff and deactivates one", async () => {
    const { connector } = testConnector();
    await connector.worlds.putStaff(staff("g01", "stf-guest-01", "sub-1"));
    await expect(connector.worlds.putStaff(staff("g01", "stf-guest-01", "sub-2"))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.worlds.putStaff(staff("g01", "stf-guest-01", "sub-2"), { replace: true });
    await connector.worlds.setStaffActive("g01", "stf-guest-01", false);
    const rows = await connector.worlds.listStaff("g01");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cognitoSubKey: "SUB#sub-2", active: false });
    await expect(connector.worlds.setStaffActive("g01", "stf-nobody", false)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("serves the shapes the BFF auth expects (StaffLookup, WorldStatusReader)", async () => {
    const { connector } = testConnector();
    await connector.worlds.register(worldMeta("demo", { status: "READY" }));
    await connector.worlds.putStaff(staff("demo"));
    const lookup: { get(worldId: string, staffId: string): Promise<{ worldId: string; staffId: string; cognitoSubKey: string; active: boolean } | undefined> } = {
      get: connector.worlds.getStaff,
    };
    const statusReader: { status(worldId: string): Promise<string | undefined> } = connector.worlds;
    expect(await lookup.get("demo", "stf-operator")).toMatchObject({ active: true });
    expect(await statusReader.status("demo")).toBe("READY");
  });
});
