// The work half of a reset or an expiry (docs/architecture.md §10, docs/architecture-guests.md §6), run by
// `WorldJanitor` (`WORLD_RESET`), by `seed:load` in process and by the hourly resume:
//
//   1. claim the ticket `RESETREQ#<requestId>` (`OPEN`, or `CLAIMED` with an expired lease) under a
//      14-minute lease; without a ticket it refuses (RESET_REQUEST_MISSING), held by another it ends;
//   2. require `META` `RESETTING` (or `EXPIRING`) with this `reset.requestId`; the epochs come from
//      `META.reset` and `COUNTER#EPOCH`, never from the payload;
//   3. run the phases in order from `reset.phase`, each idempotent, saving `reset.phase` and the
//      heartbeat after every block: `WIPE`, `OBJECTS`, `RELOAD` (not for an expiry), `PURGE`;
//   4. LAST, `RESETTING → READY` (or `EXPIRING → EXPIRED`) conditional on the request, with the
//      ticket `DONE` and the audit entry, in one transaction.
//
// Out of time between blocks, it saves its position, gives the ticket back and invokes itself again.
import { signupWorldClassOf } from "@reclamo/shared";
import { BuildCursor, type ResetPhase, type WorldMeta } from "../domain/world";
import { type Budget, type WorldsDeps, leaseUntil } from "./deps";
import { writeWorld } from "./factory";
import { instantiate } from "./instantiate";
import { purgePass, requestPurge } from "./memory-purge";
import { metaUpdateOp, releaseCapacityOp } from "./meta";
import { FactoryTemplate } from "./template";
import { deleteObjects, deleteSchedules, expirePendingApprovals, templateCustomerIds, waitQuiet, wipeRuntimeRows, wipeTables, type StepResult } from "./wipe";

export type ResetWorkResult =
  | { readonly status: "READY" | "EXPIRED"; readonly durationMs: number }
  | { readonly status: "CONTINUED"; readonly phase: ResetPhase }
  | { readonly status: "MISSING" | "BUSY" | "STALE" };

interface Job {
  readonly deps: WorldsDeps;
  readonly worldId: string;
  readonly requestId: string;
  readonly meta: WorldMeta;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly expiring: boolean;
  readonly budget: Budget;
}

const RESET_PHASES: readonly ResetPhase[] = ["WIPE", "OBJECTS", "RELOAD", "PURGE"];
const EXPIRY_PHASES: readonly ResetPhase[] = ["WIPE", "OBJECTS", "PURGE"];

async function auditAction(job: Job, epoch: number, action: string, extra: { outcome?: string; detail?: Record<string, number> } = {}): Promise<void> {
  await job.deps.connector.audit.append({
    worldId: job.worldId,
    epoch,
    auditId: `aud-${job.deps.newId().toLowerCase()}`,
    ts: job.deps.now().toISOString(),
    action,
    actor: "SYSTEM",
    refs: { requestId: job.requestId },
    ...extra,
  });
}

/** Saves the phase (and the factory's cursor), renews the heartbeat and the ticket's lease. */
async function heartbeat(job: Job, phase: ResetPhase, cursor?: BuildCursor): Promise<void> {
  const at = job.deps.now().toISOString();
  await job.deps.connector.transact([
    metaUpdateOp(job.deps, {
      worldId: job.worldId,
      from: job.meta.status,
      resetRequestId: job.requestId,
      set: { "reset.phase": phase, "reset.heartbeatAtReal": at, ...(cursor ? { buildCursor: BuildCursor.parse(cursor) } : {}) },
    }),
    job.deps.connector.counters.heartbeatTicketOp(job.worldId, "RESETREQ", job.requestId, leaseUntil(job.deps), { phase }),
  ]);
}

function templateOf(job: Job): FactoryTemplate {
  return FactoryTemplate.parse(job.meta.template);
}

/**
 * The demo phones of `SeedOverrides.personaPhones` survive a reset of `demo`: read from its customers
 * before `WIPE` deletes them, kept in the ticket (the world's own partition) and written again by `RELOAD`.
 */
async function demoLivePhones(job: Job): Promise<Record<string, string>> {
  if (job.worldId !== "demo") return {};
  const { deps } = job;
  const saved = (await deps.connector.counters.getTicket(job.worldId, "RESETREQ", job.requestId))?.detail?.livePhones;
  if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved as Record<string, string>;
  const phones: Record<string, string> = {};
  for (const customerId of templateCustomerIds(await deps.templates.read(templateOf(job)))) {
    const customer = await deps.store.get("Core", { pk: `W#${job.worldId}#CUS#${customerId}`, sk: "META" }, { consistent: true });
    if (typeof customer?.liveE164 === "string") phones[customerId] = customer.liveE164;
  }
  await deps.connector.write(deps.connector.counters.heartbeatTicketOp(job.worldId, "RESETREQ", job.requestId, leaseUntil(deps), { phase: "WIPE", detail: { livePhones: phones } }));
  return phones;
}

async function wipe(job: Job): Promise<StepResult> {
  const { deps } = job;
  await demoLivePhones(job);
  await expirePendingApprovals(deps, job.worldId, job.fromEpoch, job.meta.reset?.requestedAtReal ?? deps.now().toISOString());
  const quiet = await waitQuiet(deps, job.worldId, job.budget);
  if (quiet === "OUT_OF_TIME") return "OUT_OF_TIME";
  if (quiet === "FORCED") await auditAction(job, job.fromEpoch, "RESET_FORCED_BUSY");
  if ((await deleteSchedules(deps, job.worldId, job.budget)) === "OUT_OF_TIME") return "OUT_OF_TIME";
  if ((await wipeTables(deps, job.worldId, job.budget, () => heartbeat(job, "WIPE"))) === "OUT_OF_TIME") return "OUT_OF_TIME";
  await wipeRuntimeRows(deps, job.worldId, templateCustomerIds(await deps.templates.read(templateOf(job))));
  return "DONE";
}

async function reload(job: Job): Promise<StepResult> {
  const livePhones = await demoLivePhones(job);
  const build = await instantiate(await job.deps.templates.read(templateOf(job)), { worldId: job.worldId, epoch: job.toEpoch, keys: job.deps.keys(), livePhones });
  const written = await writeWorld(job.deps, {
    build,
    mode: "RELOAD",
    ...(job.meta.buildCursor ? { cursor: job.meta.buildCursor } : {}),
    budget: job.budget,
    onBlock: (next) => heartbeat(job, "RELOAD", next),
  });
  return written.done ? "DONE" : "OUT_OF_TIME";
}

/**
 * The first Memory pass, then the ticketed passes in `WorldJanitor`. A first pass that cannot run here
 * (`seed:load` in a shell whose role does not reach Memory) is left to those passes: the new epoch
 * already gives the world new actors, so nothing of the old one is ever read again.
 */
async function purge(job: Job): Promise<StepResult> {
  try {
    const deleted = await purgePass(job.deps, job.worldId);
    job.deps.log.info("worlds.memory_first_pass", { worldId: job.worldId, deleted });
  } catch (error) {
    job.deps.log.warn("worlds.memory_first_pass_deferred", { metric: "MemoryPurgeDeferred", worldId: job.worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
  await requestPurge(job.deps, job.worldId);
  return "DONE";
}

async function runPhase(job: Job, phase: ResetPhase): Promise<StepResult> {
  switch (phase) {
    case "WIPE":
      return wipe(job);
    case "OBJECTS":
      return deleteObjects(job.deps, job.worldId, job.budget, () => heartbeat(job, "OBJECTS"));
    case "RELOAD":
      return reload(job);
    case "PURGE":
      return purge(job);
  }
}

/** The last step: `READY` (or `EXPIRED`) only now, with the ticket and the audit entry. */
async function finish(job: Job): Promise<ResetWorkResult> {
  const { deps, worldId } = job;
  const now = deps.now();
  const durationMs = now.getTime() - Date.parse(job.meta.reset?.requestedAtReal ?? now.toISOString());
  const worldClass = signupWorldClassOf(worldId);
  await deps.connector.transact([
    metaUpdateOp(deps, {
      worldId,
      from: job.meta.status,
      to: job.expiring ? "EXPIRED" : "READY",
      resetRequestId: job.requestId,
      set: { epoch: job.toEpoch, ...(job.expiring ? { expiredAtReal: now.toISOString() } : { lastResetAtReal: now.toISOString() }) },
      remove: job.expiring ? ["reset", "buildCursor", "readyAtReal", "lastActivityAtReal"] : ["reset", "buildCursor"],
    }),
    deps.connector.counters.completeTicketOp(worldId, "RESETREQ", job.requestId),
    deps.connector.audit.appendOp({
      worldId,
      epoch: job.toEpoch,
      auditId: `aud-${deps.newId().toLowerCase()}`,
      ts: now.toISOString(),
      action: job.expiring ? "GUEST_WORLD_EXPIRED" : "WORLD_RESET",
      actor: "SYSTEM",
      refs: { requestId: job.requestId },
      detail: { durationMs, fromEpoch: job.fromEpoch, toEpoch: job.toEpoch },
    }),
    ...(job.expiring && worldClass ? [releaseCapacityOp(deps, { active: true }, worldClass)] : []),
  ]);
  if (job.expiring) deps.log.info("worlds.guest_world_expired", { metric: "GuestWorldsExpired", worldId, durationMs });
  else deps.log.info("worlds.reset_done", { metric: "WorldResetDuration", worldId, durationMs });
  return { status: job.expiring ? "EXPIRED" : "READY", durationMs };
}

async function continueLater(job: Job, phase: ResetPhase): Promise<ResetWorkResult> {
  const { deps } = job;
  await deps.connector.write(deps.connector.counters.releaseTicketOp(job.worldId, "RESETREQ", job.requestId));
  await deps.invoker.invoke({ kind: "WORLD_RESET", worldId: job.worldId, requestId: job.requestId });
  deps.log.info("worlds.reset_continued", { worldId: job.worldId, phase });
  return { status: "CONTINUED", phase };
}

/** The work of a reset or an expiry (see the header). */
export async function runWorldReset(deps: WorldsDeps, request: { readonly worldId: string; readonly requestId: string }, budget: Budget): Promise<ResetWorkResult> {
  const { connector } = deps;
  const ticket = await connector.counters.getTicket(request.worldId, "RESETREQ", request.requestId);
  if (!ticket) {
    deps.log.warn("worlds.reset_request_missing", { worldId: request.worldId });
    await connector.audit.append({
      worldId: request.worldId,
      epoch: await connector.counters.getEpoch(request.worldId),
      auditId: `aud-${deps.newId().toLowerCase()}`,
      ts: deps.now().toISOString(),
      action: "RESET_REQUEST_MISSING",
      actor: "SYSTEM",
      refs: { worldId: request.worldId },
      outcome: "REFUSED",
    });
    return { status: "MISSING" };
  }
  if (ticket.status === "DONE") return { status: "STALE" };
  if (!(await connector.counters.claimTicket(request.worldId, "RESETREQ", request.requestId, leaseUntil(deps)))) return { status: "BUSY" };

  const meta = await connector.worlds.getMeta(request.worldId, { consistent: true });
  const reset = meta?.reset;
  const epoch = await connector.counters.getEpoch(request.worldId);
  if (!meta || !reset || reset.requestId !== request.requestId || (meta.status !== "RESETTING" && meta.status !== "EXPIRING") || epoch !== reset.toEpoch) {
    deps.log.warn("worlds.reset_request_stale", { worldId: request.worldId, status: meta?.status });
    await connector.write(connector.counters.completeTicketOp(request.worldId, "RESETREQ", request.requestId));
    return { status: "STALE" };
  }
  const expiring = meta.status === "EXPIRING";
  const job: Job = { deps, worldId: request.worldId, requestId: request.requestId, meta, fromEpoch: reset.fromEpoch, toEpoch: reset.toEpoch, expiring, budget };
  const phases = expiring ? EXPIRY_PHASES : RESET_PHASES;
  const start = Math.max(0, phases.indexOf(reset.phase));
  for (const phase of phases.slice(start)) {
    if (phase !== reset.phase) await heartbeat(job, phase);
    if ((await runPhase(job, phase)) === "OUT_OF_TIME") return continueLater(job, phase);
  }
  return finish(job);
}
