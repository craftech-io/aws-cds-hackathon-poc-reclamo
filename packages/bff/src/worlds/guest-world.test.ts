import { describe, expect, it } from "vitest";
import { createWorld } from "./create";
import { assertGuestWorldFactory, createGuestWorld } from "./guest-world";
import { budgetOf, worldsRig } from "./testing";

const staff = (n: string, sub = `sub-guest-${n}`) => ({ staffId: `stf-guest-${n}`, sub, displayName: `Guest ${n}` });

describe("guest-world: pre-registration and creation of an invited guest world [FL-094]", () => {
  it("[FL-094] pre-registers the world with the account's staff row and leaves it READY before anyone signs in", async () => {
    const rig = worldsRig();
    expect(await createGuestWorld({ worldId: "g03", staff: staff("03"), resume: false }, rig.deps)).toEqual({ worldId: "g03", status: "READY" });
    expect(await rig.mc.connector.worlds.getMeta("g03", { consistent: true })).toMatchObject({ kind: "GUEST", origin: "INVITED", template: "guest", status: "READY", epoch: 1 });
    expect(await rig.mc.connector.worlds.listStaff("g03")).toEqual([expect.objectContaining({ staffId: "stf-guest-03", role: "GUEST", cognitoSubKey: "SUB#sub-guest-03", active: true })]);
    expect((await rig.mc.connector.worlds.getSettings("g03"))?.channelModes.whatsapp).toBe("simulated");
  });

  it("[FL-094] is idempotent: a second run finds the world READY and the same staff row", async () => {
    const rig = worldsRig();
    await createGuestWorld({ worldId: "g04", staff: staff("04"), resume: false }, rig.deps);
    const audits = (await rig.mc.connector.audit.listByAction("g04", "WORLD_CREATED")).length;
    expect(await createGuestWorld({ worldId: "g04", staff: staff("04"), resume: true }, rig.deps)).toEqual({ worldId: "g04", status: "READY" });
    expect((await rig.mc.connector.audit.listByAction("g04", "WORLD_CREATED")).length).toBe(audits);
  });

  it("[FL-094] finishes a world an interrupted run left CREATING only with resume", async () => {
    const rig = worldsRig();
    await rig.mc.connector.worlds.register({ worldId: "g05", kind: "GUEST", template: "guest", epoch: 1, status: "REGISTERED", origin: "INVITED" });
    await rig.mc.connector.worlds.putStaff({ worldId: "g05", staffId: "stf-guest-05", role: "GUEST", displayName: "Guest 05", cognitoSubKey: "SUB#sub-guest-05", active: true });
    expect((await createWorld(rig.deps, { worldId: "g05", budget: budgetOf(3) })).status).toBe("CREATING");

    await expect(createGuestWorld({ worldId: "g05", staff: staff("05"), resume: false }, rig.deps)).rejects.toMatchObject({ code: "CONFLICT", reason: "WORLD_CREATING" });
    expect(await createGuestWorld({ worldId: "g05", staff: staff("05"), resume: true }, rig.deps)).toEqual({ worldId: "g05", status: "READY" });
  });

  it("[FL-094] refuses a staff row of the world that belongs to another account", async () => {
    const rig = worldsRig();
    await createGuestWorld({ worldId: "g06", staff: staff("06"), resume: false }, rig.deps);
    await expect(createGuestWorld({ worldId: "g06", staff: staff("06", "someone-else"), resume: true }, rig.deps)).rejects.toMatchObject({ code: "CONFLICT", reason: "STAFF_MISMATCH" });
  });

  it("[FL-094] never creates the probe world, a self-signup world or the demo world for an invited account", async () => {
    const rig = worldsRig();
    for (const worldId of ["gprobe", "gs-abcdefghij", "demo"]) {
      await expect(createGuestWorld({ worldId, staff: staff("07"), resume: false }, rig.deps)).rejects.toMatchObject({ code: "FORBIDDEN", reason: "WORLD_NOT_INVITABLE" });
      expect(await rig.mc.connector.worlds.getMeta(worldId)).toBeUndefined();
    }
  });

  it("[FL-094] fails closed with UNAVAILABLE where the factory is not linked, before any side effect", () => {
    expect(() => assertGuestWorldFactory()).toThrow(expect.objectContaining({ name: "ToolError", code: "UNAVAILABLE" }));
  });
});
