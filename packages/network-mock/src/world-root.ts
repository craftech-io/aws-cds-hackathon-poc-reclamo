// Root of a world's objects in the buckets (docs/architecture.md §6): `W/<worldId>/` for `demo`,
// guest and simulated-load worlds; `qa/<runId>/<worldId>/` for a scenario world
// `qa-<runId>-<scenario>` (runId = `<github run id>-<attempt>`, docs/test-plan.md); `qa/<worldId>/`
// for the other QA worlds (`qa/qamin/`). Everything under `qa/` lives 2 days (lifecycle rule).
import { type CollectionNetwork, SettlementKey } from "@reclamo/core-contract";
import { worldKindOf } from "@reclamo/shared";

const SCENARIO_WORLD = /^qa-(\d+-\d+)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function worldRoot(worldId: string): string {
  const kind = worldKindOf(worldId);
  if (kind === undefined) throw new RangeError("not a world id");
  if (kind !== "QA") return `W/${worldId}/`;
  const runId = SCENARIO_WORLD.exec(worldId)?.[1];
  return runId === undefined ? `qa/${worldId}/` : `qa/${runId}/${worldId}/`;
}

/** `<world root>/<network>/<businessDate>/batch-<seq>.csv` in `Settlements`. */
export function settlementKey(worldId: string, network: CollectionNetwork, businessDate: string, seq: number): string {
  return SettlementKey.parse(`${worldRoot(worldId)}${network}/${businessDate}/batch-${seq}.csv`);
}
