// What stands before every call of the classifier's model (docs/architecture.md §13 "Rate limit y
// topes", ADR-0017, docs/architecture-guests.md §7 "Orden de la cadena de costo"): the agent's kill
// switch (`KILL#AGENT`, `W#<w>#KILL`), the world's turn caps (`W#<w>#TURNCAP#<realHour|realDay>` and, for
// a self-signup world, `W#<w>#TURNCAPEPOCH#e<epoch>`) and the global cap of the world's pool
// (`GLOBALCAP#<PUBLIC|SIGNUP|QA>#…`), all on the real clock. The classifier only LOOKS at the buckets
// (it never spends a unit: the units are the turns the worker counts); with the switch on, a world
// without its settings or a bucket at its cap the model is not called and the message is `UNCLEAR`,
// while the number and the acknowledgement still go out by rules.
import { isConflict } from "../connector/errors";
import type { Connector } from "../connector/port";
import { cond } from "../connector/store";
import { CAP_COUNTER_TTL_SECONDS, type CapBucket, poolBuckets, worldBuckets } from "../worker/caps";
import { agentKillScope } from "../worker/kill";

export type ModelBlock = "KILLED" | "TURN_CAP" | "GLOBAL_CAP";

/** The world the message belongs to: its epoch names the self-signup world's epoch bucket. */
export interface ModelWorld {
  readonly worldId: string;
  readonly epoch: number;
}

/**
 * True while the bucket is below its cap. A conditional write that adds nothing: DynamoDB evaluates
 * the cap atomically and a missing counter starts at 0 (the worker's `ADD` continues from there).
 */
async function belowCap(data: Pick<Connector, "write">, bucket: CapBucket, at: Date): Promise<boolean> {
  if (!Number.isInteger(bucket.limit) || bucket.limit <= 0) return false;
  try {
    await data.write({
      kind: "update",
      table: "Runtime",
      key: bucket.key,
      condition: cond.or(cond.notExists("count"), cond.lt("count", bucket.limit)),
      update: { setIfNotExists: { count: 0, entity: "CapCounter", expiresAt: Math.floor(at.getTime() / 1000) + CAP_COUNTER_TTL_SECONDS[bucket.window] } },
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

async function allBelowCap(data: Pick<Connector, "write">, buckets: readonly CapBucket[], at: Date): Promise<boolean> {
  for (const bucket of buckets) {
    if (!(await belowCap(data, bucket, at))) return false;
  }
  return true;
}

/** Why the model may not be called for the world now, or `undefined` when it may. */
export async function modelBlock(data: Pick<Connector, "runtime" | "write" | "worlds">, world: ModelWorld, realNow: Date): Promise<ModelBlock | undefined> {
  if ((await agentKillScope(data, world.worldId)) !== undefined) return "KILLED";
  const settings = await data.worlds.getSettings(world.worldId);
  if (settings === undefined || !(await allBelowCap(data, worldBuckets(world.worldId, world.epoch, settings, realNow), realNow))) return "TURN_CAP";
  if (!(await allBelowCap(data, poolBuckets(world.worldId, realNow), realNow))) return "GLOBAL_CAP";
  return undefined;
}
