// Destruction of a scenario world (`qa-*`, docs/architecture.md §10): what a cancelled CI job leaves is
// removed by the hourly pass after 6 hours (the QA driver's own `world.destroy` uses the same steps).
// The current epoch is tombstoned first (every late event and fire is discarded and the Memory purge
// takes every actor of the world), then the schedules, the items, the objects and the runtime rows go,
// then the world's own rows. The append-only tables keep their entries until their TTL (2 days).
import { ToolError, signupWorldClassOf, worldKindOf } from "@reclamo/shared";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import { cond } from "../connector/store";
import { type Budget, type WorldsDeps } from "./deps";
import { COUNTED_STATUSES, rawMeta, releaseCapacityOp } from "./meta";
import { purgePass, requestPurge } from "./memory-purge";
import { deleteObjects, deleteSchedules, wipeTables } from "./wipe";

export type DestroyResult = "DESTROYED" | "ABSENT" | "OUT_OF_TIME";

/** Only scenario worlds are destroyed; `qamin` is reset, never destroyed. */
export function destroyable(worldId: string): boolean {
  return worldKindOf(worldId) === "QA" && worldId !== "qamin" && worldId.startsWith("qa-");
}

/**
 * `META` goes last. A runner's sign-up world that held a place of `GUESTCAP#QA` gives it back in the same
 * transaction, so the next run never waits for the count to be healed.
 */
async function deleteMeta(deps: WorldsDeps, worldId: string): Promise<void> {
  const key = keys.worldMeta(worldId);
  const worldClass = signupWorldClassOf(worldId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const meta = await rawMeta(deps, worldId);
    if (!meta) return;
    const status = typeof meta.status === "string" ? meta.status : "";
    if (worldClass === undefined || !COUNTED_STATUSES.includes(status)) {
      await deps.store.write({ kind: "delete", table: "Worlds", key });
      return;
    }
    try {
      await deps.store.transact([
        { kind: "delete", table: "Worlds", key, condition: meta.version === undefined ? cond.notExists("version") : cond.eq("version", meta.version) },
        releaseCapacityOp(deps, { active: true, creating: status === "CREATING" }, worldClass),
      ]);
      return;
    } catch (error) {
      // The world moved in between (a factory or an expiry finished): read it again.
      if (!isConflict(error)) throw error;
    }
  }
  throw new ToolError("CONFLICT", `${worldId} kept moving while it was destroyed`, "WORLD_BUSY");
}

export async function destroyWorld(deps: WorldsDeps, worldId: string, budget: Budget): Promise<DestroyResult> {
  if (!destroyable(worldId)) throw new ToolError("FORBIDDEN", `${worldId} is not a scenario world`, "NOT_DESTROYABLE");
  const { connector } = deps;
  const meta = await connector.worlds.getMeta(worldId, { consistent: true });
  if (!meta) return "ABSENT";
  const epoch = Math.max(await connector.counters.getEpoch(worldId), meta.epoch);
  const at = deps.now().toISOString();
  try {
    await connector.write(connector.runtime.putTombstoneOp({ worldId, epoch, reason: "DESTROY", atReal: at }));
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  const noBeat = async (): Promise<void> => undefined;
  if ((await deleteSchedules(deps, worldId, budget)) === "OUT_OF_TIME") return "OUT_OF_TIME";
  if ((await wipeTables(deps, worldId, budget, noBeat)) === "OUT_OF_TIME") return "OUT_OF_TIME";
  if ((await deleteObjects(deps, worldId, budget, noBeat)) === "OUT_OF_TIME") return "OUT_OF_TIME";
  await connector.worldItems.delete("Runtime", worldId, [keys.runtime(worldId, "CLOCK"), keys.runtime(worldId, "WORLDSTATE")]);
  await purgePass(deps, worldId);
  await requestPurge(deps, worldId);
  const staff = await connector.worlds.listStaff(worldId);
  for (const key of [...staff.map((row) => keys.staff(worldId, row.staffId)), keys.worldSettings(worldId)]) {
    await deps.store.write({ kind: "delete", table: "Worlds", key });
  }
  await deleteMeta(deps, worldId);
  await connector.audit.append({ worldId, epoch, auditId: `aud-${deps.newId().toLowerCase()}`, ts: at, action: "WORLD_DESTROYED", actor: "SYSTEM", refs: { worldId } });
  deps.log.info("worlds.destroyed", { worldId, epoch });
  return "DESTROYED";
}
