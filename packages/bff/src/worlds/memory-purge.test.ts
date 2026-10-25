import { describe, expect, it } from "vitest";
import { actorIdOf } from "../turns/identity";
import { createWorld } from "./create";
import { UNLIMITED } from "./deps";
import { PURGE_TIMING, actorEpochOf, handlePurgeRequest, purgePass, purgeableActors, requestPurge, runPurgePasses } from "./memory-purge";
import { requestWorldReset } from "./reset";
import { runWorldReset } from "./reset-work";
import { worldsRig } from "./testing";

async function rigWith(worlds: readonly string[]) {
  const rig = worldsRig();
  for (const worldId of worlds) {
    await rig.mc.connector.worlds.register({ worldId, kind: "GUEST", template: "guest", epoch: 1, status: "REGISTERED" });
    await createWorld(rig.deps, { worldId, budget: UNLIMITED });
  }
  return rig;
}

describe("Memory purge of a world [FL-099][FL-100]", () => {
  it("[FL-099] two worlds with the same customer and the same epoch: purging one leaves the other intact", async () => {
    const rig = await rigWith(["g01", "g02"]);
    const mine = actorIdOf("g01", "cus-0001", 1);
    const theirs = actorIdOf("g02", "cus-0001", 1);
    rig.memory.add(mine);
    rig.memory.add(theirs);
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    await runWorldReset(rig.deps, { worldId: "g01", requestId }, UNLIMITED);

    const sessionsOf = (actorId: string) => [...(rig.memory.actors.get(actorId)?.sessions.values() ?? [])].flatMap((events) => [...events]);
    expect(sessionsOf(mine)).toEqual([]);
    expect(rig.memory.actors.get(mine)?.records.size).toBe(0);
    expect(sessionsOf(theirs)).toHaveLength(2);
    expect(rig.memory.actors.get(theirs)?.records.size).toBe(2);
    // The next passes run in WorldJanitor with their own ticket.
    expect(rig.invoked.some((event) => event.kind === "MEMORY_PURGE" && event.worldId === "g01")).toBe(true);
  });

  it("[FL-100] never touches the current epoch of a live world: the epoch comes from COUNTER#EPOCH", async () => {
    const rig = await rigWith(["g01"]);
    const current = actorIdOf("g01", "cus-0001", 1);
    rig.memory.add(current);
    expect(await purgePass(rig.deps, "g01")).toBe(0);
    expect(rig.memory.actors.get(current)?.records.size).toBe(2);
  });

  it("[FL-099] takes only the exact world prefix with a customer after it, never a longer world id", () => {
    expect(actorEpochOf("qa-r1", "w-qa-r1-cus-0001-e3")).toBe(3);
    expect(actorEpochOf("qa-r1", "w-qa-r1-sc01-cus-0001-e3")).toBeUndefined();
    expect(actorEpochOf("g01", "w-g010-cus-0001-e1")).toBeUndefined();
    expect(purgeableActors("g01", ["w-g01-cus-0001-e1", "w-g01-cus-0001-e2", "w-g02-cus-0001-e1"], 2, false)).toEqual(["w-g01-cus-0001-e1"]);
    // A destroyed epoch (tombstone DESTROY of the current epoch) loses every actor of the world.
    expect(purgeableActors("g01", ["w-g01-cus-0001-e1", "w-g01-cus-0001-e2", "w-g02-cus-0001-e1"], 2, true)).toEqual(["w-g01-cus-0001-e1", "w-g01-cus-0001-e2"]);
  });

  it("[FL-099] refuses an asynchronous purge without its ticket (PURGE_REQUEST_MISSING)", async () => {
    const rig = await rigWith(["g01"]);
    rig.memory.add(actorIdOf("g01", "cus-0001", 1));
    const result = await handlePurgeRequest(rig.deps, { worldId: "g01", requestId: "01K7ZZZZZZZZZZZZZZZZZZZZZZ" }, UNLIMITED);
    expect(result).toEqual({ status: "MISSING" });
    expect(await rig.mc.connector.audit.listByAction("g01", "PURGE_REQUEST_MISSING")).toHaveLength(1);
  });

  it("[FL-100] runs the passes of a ticketed purge until two listings in a row are empty", async () => {
    const rig = await rigWith(["g01"]);
    const { requestId: resetId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    await runWorldReset(rig.deps, { worldId: "g01", requestId: resetId }, UNLIMITED);
    // A late extraction of the old epoch shows up after the first pass.
    const late = actorIdOf("g01", "cus-0003", 1);
    rig.memory.add(late);
    const requestId = await requestPurge(rig.deps, "g01");
    const result = await handlePurgeRequest(rig.deps, { worldId: "g01", requestId }, UNLIMITED);
    expect(result).toMatchObject({ status: "PURGED", complete: true, passes: 3, deleted: 4 });
    expect(rig.memory.actors.get(late)?.records.size).toBe(0);
    expect(await rig.mc.connector.counters.getTicket("g01", "PURGEREQ", requestId)).toMatchObject({ status: "DONE" });
    // A second run of the same ticket does nothing.
    expect(await handlePurgeRequest(rig.deps, { worldId: "g01", requestId }, UNLIMITED)).toEqual({ status: "DONE" });
  });

  it("[FL-100] gives up after 10 minutes of passes with MEMORY_PURGE_INCOMPLETE", async () => {
    const rig = await rigWith(["g01"]);
    const { requestId } = await requestWorldReset(rig.deps, { worldId: "g01", actor: "SYSTEM" });
    await runWorldReset(rig.deps, { worldId: "g01", requestId }, UNLIMITED);
    let round = 0;
    const listActorIds = rig.deps.memory.listActorIds;
    const deps = {
      ...rig.deps,
      memory: {
        ...rig.deps.memory,
        listActorIds: async () => {
          // Memory keeps extracting records of the old epoch on every listing.
          rig.memory.add(actorIdOf("g01", "cus-0005", 1), 0, 1);
          round += 1;
          return listActorIds();
        },
      },
    };
    const outcome = await runPurgePasses(deps, "g01", rig.now().toISOString(), UNLIMITED);
    expect(outcome.complete).toBe(false);
    expect(round).toBeGreaterThan(PURGE_TIMING.capMs / PURGE_TIMING.listingEveryMs - 5);
    expect(await rig.mc.connector.audit.listByAction("g01", "MEMORY_PURGE_INCOMPLETE")).toHaveLength(1);
    expect(rig.logs.some((line) => line.includes("MemoryPurgeIncomplete"))).toBe(true);
  });
});
