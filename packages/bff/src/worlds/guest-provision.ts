// Provisioning of the self-signup worlds (docs/architecture-guests.md §5): the sign-up leaves the world
// `REGISTERED` in the `GuestIndex` queue with a ticket `Runtime/W#<w>#PROVISIONREQ#<requestId>` and
// invokes `WorldJanitor` with ONLY `{kind: WORLD_CREATE, worldId, requestId}`:
//
//   - without an open ticket in the world's partition it refuses (PROVISION_REQUEST_MISSING);
//   - the ticket is claimed under a lease, so two invocations never build at once, and the request
//     that moves the world `REGISTERED → CREATING` binds it (`META.provisionRequestId`): any other
//     request on that world ends as superseded;
//   - `REGISTERED → CREATING` takes a place in `GUESTCAP#ACTIVE` (40 active, 3 creating) in the same
//     transaction; without room the world stays queued and the ticket open (the runner's `qa-*-su*`
//     worlds do the same in their own `GUEST#QA#` queue and `GUESTCAP#QA`, worlds/meta.ts);
//   - the build is the factory's (worlds/create.ts) and `READY` comes last, with `creating − 1`.
//
// The provisioning pass (every 5 minutes) keeps the queue moving: positions, a queued request older
// than 7 days → `EXPIRED`, a start for every free place, and a `CREATING` world whose heartbeat is
// older than 20 minutes resumed (three resumes without progress → `WorldCreateStuck`).
import { type SignupWorldClass, ToolError, signupWorldClassOf } from "@reclamo/shared";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import type { StoredItem, WriteOp } from "../connector/store";
import { cond } from "../connector/store";
import { type Budget, type WorldsDeps, leaseUntil } from "./deps";
import { createWorld } from "./create";
import { SIGNUP_WORLD_CLASSES, activeLimitFor, guestQueuePartition, metaUpdateOp, rawMeta, readCapacity, releaseCapacityOp, takeCapacityOp } from "./meta";
import { isSignupWorld } from "./template";

const DAY_MS = 24 * 3_600_000;
export const QUEUE_EXPIRY_MS = 7 * DAY_MS;
export const STALE_CREATION_MS = 20 * 60_000;
const STUCK_AFTER = 3;
/** Seven days of the ticket (docs/architecture-guests.md §11). */
const TICKET_TTL_SECONDS = 7 * 24 * 3_600;

export type ProvisionResult = { readonly status: "READY" | "QUEUED" | "CONTINUED" | "MISSING" | "BUSY" | "DONE" | "SUPERSEDED" | "STALE" };

type ProvisionDeps = WorldsDeps;

function ticketKey(worldId: string, requestId: string) {
  return keys.runtime(worldId, "PROVISIONREQ", requestId);
}

/** A new `OPEN` ticket in the world's partition (the janitor's own, for a queued or stuck world). */
export function provisionTicketOp(deps: Pick<WorldsDeps, "now">, worldId: string, requestId: string, attempts = 0): WriteOp {
  const now = deps.now();
  const item: StoredItem = {
    ...ticketKey(worldId, requestId),
    entity: "ProvisionRequest",
    worldId,
    requestId,
    status: "OPEN",
    requestedAtReal: now.toISOString(),
    attempts,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + TICKET_TTL_SECONDS,
  };
  return { kind: "put", table: "Runtime", item, condition: cond.absent() };
}

function ticketChange(deps: Pick<WorldsDeps, "now">, worldId: string, requestId: string, status: "OPEN" | "CLAIMED" | "DONE", extra: { lease?: string; attempt?: boolean; detail?: Record<string, unknown> } = {}): WriteOp {
  return {
    kind: "update",
    table: "Runtime",
    key: ticketKey(worldId, requestId),
    condition: cond.present(),
    update: {
      set: { status, updatedAt: deps.now().toISOString(), ...(extra.lease ? { leaseUntilReal: extra.lease } : {}), ...(extra.detail ? { detail: extra.detail } : {}) },
      ...(extra.attempt ? { add: { attempts: 1 } } : {}),
      ...(extra.lease ? {} : { remove: ["leaseUntilReal"] }),
    },
  };
}

/** Self-signup worlds and the scenario runner's sign-up worlds are the only ones provisioned here. */
const provisionable = isSignupWorld;

async function claim(deps: ProvisionDeps, worldId: string, requestId: string): Promise<boolean> {
  const now = deps.now().toISOString();
  try {
    await deps.store.write({
      ...ticketChange(deps, worldId, requestId, "CLAIMED", { lease: leaseUntil(deps) }),
      condition: cond.and(cond.present(), cond.or(cond.eq("status", "OPEN"), cond.and(cond.eq("status", "CLAIMED"), cond.lt("leaseUntilReal", now)))),
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

async function audit(deps: ProvisionDeps, worldId: string, action: string, refs: Record<string, string>, outcome?: string): Promise<void> {
  await deps.connector.audit.append({
    worldId,
    epoch: await deps.connector.counters.getEpoch(worldId),
    auditId: `aud-${deps.newId().toLowerCase()}`,
    ts: deps.now().toISOString(),
    action,
    actor: "SYSTEM",
    refs,
    ...(outcome ? { outcome } : {}),
  });
}

async function done(deps: ProvisionDeps, worldId: string, requestId: string, status: ProvisionResult["status"]): Promise<ProvisionResult> {
  await deps.store.write(ticketChange(deps, worldId, requestId, "DONE"));
  return { status };
}

/** `WORLD_CREATE` of `WorldJanitor` (see the header). */
export async function handleWorldCreate(deps: ProvisionDeps, request: { readonly worldId: string; readonly requestId: string }, budget: Budget): Promise<ProvisionResult> {
  const { worldId, requestId } = request;
  if (!provisionable(worldId)) throw new ToolError("FORBIDDEN", `${worldId} is not provisioned by sign-up`, "NOT_PROVISIONABLE");
  const ticket = await deps.store.get("Runtime", ticketKey(worldId, requestId), { consistent: true });
  if (!ticket) {
    deps.log.warn("worlds.provision_request_missing", { worldId });
    await audit(deps, worldId, "PROVISION_REQUEST_MISSING", { worldId }, "REFUSED");
    return { status: "MISSING" };
  }
  if (ticket.status === "DONE") return { status: "DONE" };
  if (!(await claim(deps, worldId, requestId))) return { status: "BUSY" };

  const meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
  if (!meta || meta.status === "READY") return done(deps, worldId, requestId, meta ? "DONE" : "STALE");
  if (meta.status !== "REGISTERED" && meta.status !== "CREATING") return done(deps, worldId, requestId, "STALE");
  const worldClass = signupWorldClassOf(worldId) ?? "SIGNUP";
  const capacity = await readCapacity(deps, worldClass);
  try {
    const result = await createWorld(deps, {
      worldId,
      template: "guest",
      budget,
      provisionRequestId: requestId,
      startOps: [takeCapacityOp(deps, worldId, capacity)],
      finishOps: [releaseCapacityOp(deps, { creating: true }, worldClass), ticketChange(deps, worldId, requestId, "DONE")],
      heartbeat: async () => {
        await deps.store.write(ticketChange(deps, worldId, requestId, "CLAIMED", { lease: leaseUntil(deps) }));
      },
    });
    if (result.status === "READY") return { status: "READY" };
    await deps.store.write(ticketChange(deps, worldId, requestId, "OPEN"));
    await deps.invoker.invoke({ kind: "WORLD_CREATE", worldId, requestId });
    return { status: "CONTINUED" };
  } catch (error) {
    if (error instanceof ToolError && error.reason === "SUPERSEDED") return done(deps, worldId, requestId, "SUPERSEDED");
    if (!isConflict(error)) throw error;
    const after = await rawMeta(deps, worldId);
    // Still ours: a lost race mid-build; the lease expires and the pass resumes it.
    if (after?.status === "CREATING" && after.provisionRequestId === requestId) throw error;
    if (after?.status !== "REGISTERED") return done(deps, worldId, requestId, "SUPERSEDED");
    // No room: the world waits in the queue, the ticket stays open for the next pass.
    await deps.store.write(ticketChange(deps, worldId, requestId, "OPEN"));
    await audit(deps, worldId, "GUEST_WORLD_QUEUED", { requestId });
    return { status: "QUEUED" };
  }
}

/** The `gs-*` (or the runner's `qa-*-su*`) worlds in one state of the queue, oldest first (index `GuestIndex`, read only by `WorldJanitor`). */
export async function guestWorldsIn(deps: Pick<WorldsDeps, "store">, status: string, worldClass: SignupWorldClass = "SIGNUP", limit = 500): Promise<string[]> {
  const page = await deps.store.query({ table: "Worlds", index: "GuestIndex", partition: guestQueuePartition(worldClass, status), limit });
  // `W#<worldId>#WORLD`: the key is projected whatever else the index carries.
  return page.items.flatMap((item) => {
    const worldId = item.pk.split("#")[1];
    return worldId && signupWorldClassOf(worldId) === worldClass ? [worldId] : [];
  });
}

async function expireQueued(deps: ProvisionDeps, worldId: string): Promise<boolean> {
  const meta = await rawMeta(deps, worldId);
  const requested = typeof meta?.requestedAtReal === "string" ? Date.parse(meta.requestedAtReal) : Number.NaN;
  if (meta?.status !== "REGISTERED" || !(deps.now().getTime() - requested > QUEUE_EXPIRY_MS)) return false;
  try {
    await deps.connector.write(metaUpdateOp(deps, { worldId, from: "REGISTERED", to: "EXPIRED", set: { expiredAtReal: deps.now().toISOString() }, remove: ["queuePosition"] }));
    await audit(deps, worldId, "GUEST_WORLD_EXPIRED", { reason: "QUEUED_TOO_LONG" }, "QUEUE_EXPIRED");
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  return true;
}

/** Positions, old requests out of the queue, and one start per free place (they run asynchronously). */
async function moveQueue(deps: ProvisionDeps, worldClass: SignupWorldClass): Promise<{ queued: number; started: number }> {
  const queue = await guestWorldsIn(deps, "REGISTERED", worldClass);
  let position = 0;
  const waiting: string[] = [];
  for (const worldId of queue) {
    if (await expireQueued(deps, worldId)) continue;
    const meta = await rawMeta(deps, worldId);
    if (meta?.status !== "REGISTERED") continue;
    if (meta.queuePosition !== position) {
      await deps.connector.write(metaUpdateOp(deps, { worldId, from: "REGISTERED", set: { queuePosition: position } })).catch((error: unknown) => (isConflict(error) ? undefined : Promise.reject(error)));
    }
    waiting.push(worldId);
    position += 1;
  }
  const capacity = await readCapacity(deps, worldClass);
  let [active, creating] = [capacity.active, capacity.creating];
  const starting: string[] = [];
  for (const worldId of waiting) {
    if (creating >= capacity.creatingLimit) break;
    // A run's primed QA limit binds only its own worlds: another run's world behind it may still start.
    if (active >= activeLimitFor(capacity, worldId, deps.now())) continue;
    starting.push(worldId);
    active += 1;
    creating += 1;
  }
  for (const worldId of starting) {
    const requestId = deps.newId();
    await deps.connector.write(provisionTicketOp(deps, worldId, requestId));
    await deps.invoker.invoke({ kind: "WORLD_CREATE", worldId, requestId });
  }
  return { queued: waiting.length, started: starting.length };
}

/** A `CREATING` world without a heartbeat for 20 minutes: its ticket reopened (or recreated), attempts counted. */
async function resumeStaleCreation(deps: ProvisionDeps, worldId: string): Promise<"NOT_STALE" | "RESUMED" | "STUCK"> {
  const meta = await rawMeta(deps, worldId);
  const requestId = typeof meta?.provisionRequestId === "string" ? meta.provisionRequestId : undefined;
  const beat = typeof meta?.updatedAt === "string" ? Date.parse(meta.updatedAt) : 0;
  if (meta?.status !== "CREATING" || !requestId || deps.now().getTime() - beat < STALE_CREATION_MS) return "NOT_STALE";
  const ticket = await deps.store.get("Runtime", ticketKey(worldId, requestId), { consistent: true });
  const cursor = meta.buildCursor as { phase?: string; block?: number } | undefined;
  const progress = `${cursor?.phase ?? "-"}:${cursor?.block ?? 0}`;
  const detail = (ticket?.detail ?? {}) as { progress?: string; stalls?: number };
  const stalls = detail.progress === progress ? (detail.stalls ?? 0) + 1 : 1;
  await deps.store.write(ticket ? ticketChange(deps, worldId, requestId, "OPEN", { attempt: true, detail: { progress, stalls } }) : provisionTicketOp(deps, worldId, requestId, 1));
  // The heartbeat moves, so the next pass waits another 20 minutes for this attempt.
  await deps.connector.write(metaUpdateOp(deps, { worldId, from: "CREATING", provisionRequestId: requestId, set: {} }));
  if (stalls >= STUCK_AFTER) deps.log.error("worlds.create_stuck", { metric: "WorldCreateStuck", worldId, attempts: stalls, progress });
  await deps.invoker.invoke({ kind: "WORLD_CREATE", worldId, requestId });
  return stalls >= STUCK_AFTER ? "STUCK" : "RESUMED";
}

export interface ProvisionPassResult {
  readonly queued: number;
  readonly started: number;
  readonly resumed: number;
}

/** The provisioning half of the 5-minute pass (the expiry half is worlds/guest-expiry.ts). */
export async function provisionPass(deps: ProvisionDeps): Promise<ProvisionPassResult> {
  let resumed = 0;
  let queued = 0;
  let started = 0;
  for (const worldClass of SIGNUP_WORLD_CLASSES) {
    for (const worldId of await guestWorldsIn(deps, "CREATING", worldClass)) if ((await resumeStaleCreation(deps, worldId)) !== "NOT_STALE") resumed += 1;
    const moved = await moveQueue(deps, worldClass);
    queued += moved.queued;
    started += moved.started;
  }
  deps.log.info("worlds.provision_pass", { metric: "GuestWorldsQueued", queued, started, resumed });
  return { queued, started, resumed };
}
