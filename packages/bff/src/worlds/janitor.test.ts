import { describe, expect, it } from "vitest";
import { createWorldJanitorHandler } from "../handlers/world-janitor";
import { createWorld } from "./create";
import { UNLIMITED } from "./deps";
import { runJanitor } from "./janitor";
import { INVITED_GUEST_WORLDS } from "./passes";
import { requestWorldReset } from "./reset";
import { fakeAccounts, worldsRig } from "./testing";

describe("WorldJanitor: what it accepts [FL-099][FL-100]", () => {
  it("[FL-099] refuses any input but a ticketed request or a scheduled pass, and trusts nothing else in the payload", async () => {
    const rig = worldsRig();
    for (const raw of [
      {},
      { kind: "WORLD_RESET", worldId: "g01" },
      { kind: "WORLD_RESET", worldId: "g01", requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1", fromEpoch: 7 },
      { kind: "WORLD_RESET", worldId: "otro-mundo", requestId: "01K7AAAAAAAAAAAAAAAAAAAAA1" },
      { kind: "DESTROY_EVERYTHING" },
    ]) {
      expect(await runJanitor(rig.deps, raw, UNLIMITED)).toEqual({ kind: "INVALID" });
    }
    expect(rig.logs.filter((line) => line.includes("janitor.invalid_event"))).toHaveLength(5);
  });

  it("[FL-100] runs a ticketed reset through the Lambda entry with the invocation's remaining time", async () => {
    const rig = worldsRig();
    await rig.mc.connector.worlds.register({ worldId: "g01", kind: "GUEST", template: "guest", epoch: 1, status: "REGISTERED" });
    await createWorld(rig.deps, { worldId: "g01", budget: UNLIMITED });
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    const handler = createWorldJanitorHandler(() => rig.deps, () => rig.deps.log);
    const result = await handler({ kind: "WORLD_RESET", worldId: "g01", requestId }, { getRemainingTimeInMillis: () => 900_000, invokedFunctionArn: "arn:aws:lambda:us-east-1:000000000000:function:janitor" });
    expect(result).toMatchObject({ kind: "WORLD_RESET", result: { status: "READY" } });
  });

  it("[FL-100] the nightly pass resets an invited guest world idle for 24 h and leaves a pristine one alone", async () => {
    const rig = worldsRig();
    for (const worldId of ["g01", "g02"]) {
      await rig.mc.connector.worlds.register({ worldId, kind: "GUEST", template: "guest", epoch: 1, status: "REGISTERED", origin: "INVITED" });
      await createWorld(rig.deps, { worldId, budget: UNLIMITED });
    }
    rig.advance(60_000);
    const clock = await rig.mc.connector.runtime.getClock("g01");
    if (!clock) throw new Error("g01 has no clock");
    const { version, createdAt: _created, updatedAt: _updated, ...rest } = clock;
    await rig.mc.connector.runtime.putClock({ ...rest, lastSession: { sessionId: "s-1", lastActiveAtReal: rig.now().toISOString() } }, version);
    rig.advance(25 * 3_600_000);
    const result = await runJanitor(rig.deps, { kind: "NIGHTLY_PASS" }, UNLIMITED);
    expect(result).toMatchObject({ kind: "NIGHTLY_PASS", counts: { reset: 1 } });
    expect((await rig.mc.connector.worlds.getMeta("g01", { consistent: true }))?.status).toBe("RESETTING");
    expect((await rig.mc.connector.worlds.getMeta("g02", { consistent: true }))?.status).toBe("READY");
    expect(rig.invoked).toEqual([expect.objectContaining({ kind: "WORLD_RESET", worldId: "g01" })]);
    expect(INVITED_GUEST_WORLDS).toHaveLength(100);
  });

  it("[FL-099] the hourly pass destroys a scenario world and its user left for more than 6 hours, and their orphan schedules", async () => {
    const accounts = fakeAccounts();
    const rig = worldsRig({ accounts });
    const worldId = "qa-123-1-sc05";
    await rig.mc.connector.worlds.register({ worldId, kind: "QA", template: "guest", epoch: 1, status: "REGISTERED" });
    await rig.mc.connector.worlds.putStaff({ worldId, staffId: "stf-qa-operator", role: "OPERATOR", displayName: "QA", cognitoSubKey: "SUB#sub-qa", active: true });
    await createWorld(rig.deps, { worldId, template: "guest", budget: UNLIMITED });
    accounts.accounts.push({ username: `${worldId}-operator`, status: "CONFIRMED", createdAt: rig.now(), worldId });
    rig.memory.add(`w-${worldId}-cus-0001-e1`);
    const listed = ["tm-qa-123-1-sc05-e1-abcdefghijklmnop", "tm-qa-999-1-sc01-e1-abcdefghijklmnop"];
    const deps = { ...rig.deps, schedules: { ...rig.deps.schedules, list: async () => listed } };

    expect(await runJanitor(deps, { kind: "HOURLY_PASS" }, UNLIMITED)).toMatchObject({ counts: { qaWorlds: 0, qaUsers: 0, schedules: 1 } });
    rig.advance(7 * 3_600_000);
    expect(await runJanitor(deps, { kind: "HOURLY_PASS" }, UNLIMITED)).toMatchObject({ counts: { qaWorlds: 1, qaUsers: 1, schedules: 2 } });
    expect(await rig.mc.connector.worlds.getMeta(worldId)).toBeUndefined();
    expect(await rig.mc.connector.worlds.listStaff(worldId)).toEqual([]);
    expect((await rig.mc.connector.worldItems.listKeys("Core", worldId)).keys).toEqual([]);
    expect(rig.memory.actors.get(`w-${worldId}-cus-0001-e1`)?.records.size).toBe(0);
    expect(accounts.deleted).toEqual([`${worldId}-operator`]);
    expect(rig.deletedSchedules).toContain("tm-qa-123-1-sc05-e1-abcdefghijklmnop");
  });
});
