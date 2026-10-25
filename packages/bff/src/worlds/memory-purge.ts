// Purge of AgentCore Memory for a world (docs/architecture.md §9.3): the second layer after a new epoch
// gives the world new actors. Only actors `w-<worldId>-<customerId>-e<epoch>` of THIS world (the exact
// prefix with its final dash, and a customer id right after it) and of an epoch BEFORE the current
// one, read from `Runtime/W#<w>#COUNTER#EPOCH` and never from a request; a world whose current epoch
// is tombstoned as destroyed loses all of them. Never an actor of another world, never the current
// epoch of a live world.
//
// Memory extracts asynchronously, so the purge runs in passes: the first inside the work that resets,
// expires or destroys the world (never a `Bff` request); the second 60 s later in `WorldJanitor`,
// invoked asynchronously with a `PURGEREQ#` ticket (without the ticket it refuses and audits
// PURGE_REQUEST_MISSING); then listings every 15 s until two in a row are empty, at most 10 minutes
// (then MEMORY_PURGE_INCOMPLETE).
import { CustomerId } from "@reclamo/shared";
import { actorPrefixOf } from "../turns/identity";
import { type Budget, type WorldsDeps, leaseUntil, outOfTime } from "./deps";
import { actorNamespace } from "./memory-admin";

export const PURGE_TIMING = {
  secondPassAfterMs: 60_000,
  listingEveryMs: 15_000,
  emptyListingsToStop: 2,
  capMs: 10 * 60_000,
} as const;

type PurgeDeps = Pick<WorldsDeps, "connector" | "memory" | "invoker" | "log" | "now" | "sleep" | "newId">;

/** The epoch of an actor of `worldId`, or `undefined` when the actor belongs to anything else. */
export function actorEpochOf(worldId: string, actorId: string): number | undefined {
  const prefix = actorPrefixOf(worldId);
  if (!actorId.startsWith(prefix)) return undefined;
  const match = /^(.+)-e(\d+)$/.exec(actorId.slice(prefix.length));
  if (!match || !CustomerId.safeParse(match[1]).success) return undefined;
  return Number(match[2]);
}

/** The actors a purge of `worldId` may delete, given its current epoch and whether that epoch is destroyed. */
export function purgeableActors(worldId: string, actorIds: readonly string[], currentEpoch: number, destroyed: boolean): string[] {
  return actorIds.filter((actorId) => {
    const epoch = actorEpochOf(worldId, actorId);
    return epoch !== undefined && (destroyed || epoch < currentEpoch);
  });
}

/** One pass over the world's past actors: their events and records; how many items it deleted. */
export async function purgePass(deps: PurgeDeps, worldId: string): Promise<number> {
  const epoch = await deps.connector.counters.getEpoch(worldId);
  const tomb = epoch > 0 ? await deps.connector.runtime.getTombstone(worldId, epoch) : undefined;
  const actors = purgeableActors(worldId, await deps.memory.listActorIds(), epoch, tomb?.reason === "DESTROY");
  let deleted = 0;
  for (const actorId of actors) {
    for (const sessionId of await deps.memory.listSessionIds(actorId)) {
      const events = await deps.memory.listEventIds(actorId, sessionId);
      for (const eventId of events) await deps.memory.deleteEvent(actorId, sessionId, eventId);
      deleted += events.length;
    }
    const records = await deps.memory.listRecordIds(actorNamespace(actorId));
    for (const recordId of records) await deps.memory.deleteRecord(recordId);
    deleted += records.length;
  }
  return deleted;
}

/** Opens a `PURGEREQ#` ticket in the world's partition and asks `WorldJanitor` for the next passes. */
export async function requestPurge(deps: PurgeDeps, worldId: string): Promise<string> {
  const requestId = deps.newId();
  await deps.connector.write(deps.connector.counters.openTicketOp({ worldId, kind: "PURGEREQ", requestId, openedAtReal: deps.now().toISOString() }));
  try {
    await deps.invoker.invoke({ kind: "MEMORY_PURGE", worldId, requestId });
  } catch (error) {
    // The first pass already ran; the next ones are a second layer (a new epoch is a new actor).
    deps.log.warn("worlds.memory_purge_invoke_failed", { worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
  return requestId;
}

export interface PurgeOutcome {
  readonly complete: boolean;
  readonly passes: number;
  readonly deleted: number;
}

async function audit(deps: PurgeDeps, worldId: string, action: string, detail: Record<string, number> = {}, outcome?: string): Promise<void> {
  await deps.connector.audit.append({
    worldId,
    epoch: await deps.connector.counters.getEpoch(worldId),
    auditId: `aud-${deps.newId().toLowerCase()}`,
    ts: deps.now().toISOString(),
    action,
    actor: "SYSTEM",
    refs: { worldId },
    ...(outcome ? { outcome } : {}),
    detail,
  });
}

/** Pass 2 and the listings until two in a row are empty, within the 10-minute cap from `startedAtReal`. */
export async function runPurgePasses(deps: PurgeDeps, worldId: string, startedAtReal: string, budget: Budget): Promise<PurgeOutcome> {
  const deadline = Date.parse(startedAtReal) + PURGE_TIMING.capMs;
  let passes = 0;
  let deleted = 0;
  let emptyInARow = 0;
  let wait: number = PURGE_TIMING.secondPassAfterMs;
  while (emptyInARow < PURGE_TIMING.emptyListingsToStop) {
    const wakeAt = deps.now().getTime() + wait;
    if (wakeAt > deadline || outOfTime(budget)) {
      const last = await purgePass(deps, worldId);
      passes += 1;
      deleted += last;
      if (last === 0) break;
      deps.log.error("worlds.memory_purge_incomplete", { metric: "MemoryPurgeIncomplete", worldId, passes });
      await audit(deps, worldId, "MEMORY_PURGE_INCOMPLETE", { passes, deleted });
      return { complete: false, passes, deleted };
    }
    await deps.sleep(wait);
    const found = await purgePass(deps, worldId);
    passes += 1;
    deleted += found;
    // Pass 2 deletes what arrived after pass 1; it is not a listing.
    if (passes > 1) emptyInARow = found === 0 ? emptyInARow + 1 : 0;
    wait = PURGE_TIMING.listingEveryMs;
  }
  deps.log.info("worlds.memory_purge_done", { worldId, passes, deleted });
  return { complete: true, passes, deleted };
}

export type PurgeRequestResult = { readonly status: "MISSING" | "BUSY" | "DONE" } | ({ readonly status: "PURGED" } & PurgeOutcome);

/** `MEMORY_PURGE` of `WorldJanitor`: only with the world's own ticket, claimed under a lease. */
export async function handlePurgeRequest(deps: PurgeDeps, request: { readonly worldId: string; readonly requestId: string }, budget: Budget): Promise<PurgeRequestResult> {
  const { connector } = deps;
  const ticket = await connector.counters.getTicket(request.worldId, "PURGEREQ", request.requestId);
  if (!ticket) {
    deps.log.warn("worlds.purge_request_missing", { worldId: request.worldId });
    await audit(deps, request.worldId, "PURGE_REQUEST_MISSING", {}, "REFUSED");
    return { status: "MISSING" };
  }
  if (ticket.status === "DONE") return { status: "DONE" };
  const claimed = await connector.counters.claimTicket(request.worldId, "PURGEREQ", request.requestId, leaseUntil(deps));
  if (!claimed) return { status: "BUSY" };
  const outcome = await runPurgePasses(deps, request.worldId, ticket.openedAtReal, budget);
  await connector.write(connector.counters.completeTicketOp(request.worldId, "PURGEREQ", request.requestId));
  return { status: "PURGED", ...outcome };
}
