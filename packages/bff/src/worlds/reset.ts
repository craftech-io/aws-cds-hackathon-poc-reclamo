// `reset_world`, asynchronous and resumable (docs/architecture.md §10), and the expiry of a self-signup
// world, which is the same work without `RELOAD` (docs/architecture-guests.md §6). This module holds the
// two halves around the work (worlds/reset-work.ts):
//
//   request  ONE transaction: `META READY → RESETTING` (or `→ EXPIRING`) conditional on `READY`, with
//            `reset{requestId, fromEpoch e, toEpoch e + 1, phase WIPE, …}`; `COUNTER#EPOCH e → e + 1`;
//            the tombstone of `e`; the ticket `RESETREQ#<requestId>`; the audit entry; for a reset of a
//            self-signup world, one more in `W#<w>#RESETCAP#<realDay>` below its cap (3 per REAL day,
//            docs/architecture-guests.md §7: the guest drives the world clock, never this one). The caller (the
//            console's `clock.reset`, the QA driver, the nightly pass, the expiry pass) then invokes
//            `WorldJanitor` asynchronously with ONLY `{kind: WORLD_RESET, worldId, requestId}` and
//            answers at once: no request behind CloudFront waits for the work.
//   resume   the hourly pass reopens every `RESETTING`/`EXPIRING` world whose heartbeat is more than
//            20 minutes old (attempts + 1) and invokes the work again; three resumes in a row without
//            progress raise `WorldResetStuck`, and the world stays `RESETTING`: never `READY` half-done.
import { ToolError } from "@reclamo/shared";
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import type { CapBucket } from "../connector/repos/caps";
import type { Actor } from "../domain/common";
import type { WorldMeta } from "../domain/world";
import { GUEST_WORLD_LIMITS } from "../leads/limits";
import type { WorldsDeps } from "./deps";
import { metaUpdateOp } from "./meta";
import { isSignupWorld } from "./template";

export type ResetKind = "RESET" | "EXPIRE";

export interface ResetRequestInput {
  readonly worldId: string;
  readonly actor: Actor;
  /** `RESET` (default) reloads the template; `EXPIRE` (self-signup worlds) leaves the world `EXPIRED`. */
  readonly kind?: ResetKind;
  /** Refuse when the last reset ended less than this ago (the console: 10 minutes). */
  readonly minIntervalMs?: number;
  readonly reason?: string;
  /** `EXPIRE` of a world already `EXPIRING` with no request (`leads:delete` retired it): the request it lacks. */
  readonly adopt?: true;
}

export interface ResetRequested {
  readonly requestId: string;
  readonly status: "RESETTING" | "EXPIRING";
  readonly fromEpoch: number;
  readonly toEpoch: number;
}

type RequestDeps = Pick<WorldsDeps, "connector" | "now" | "newId">;

/** Heartbeats older than this mark a reset or expiry whose invocation died. */
export const STALE_HEARTBEAT_MS = 20 * 60_000;
/** Resumes in a row without progress before `WorldResetStuck`. */
export const STUCK_AFTER = 3;

/** The refusal of a reset past the day's cap of a self-signup world; the console words it as its usage limit. */
export const RESET_DAILY_CAP = "RESET_DAILY_CAP";

/** The real day's reset bucket of a self-signup world; an expiry and every other world are not counted. */
function resetCapBucket(worldId: string, kind: ResetKind, at: Date): CapBucket | undefined {
  return kind === "RESET" && isSignupWorld(worldId) ? { kind: "RESETCAP", worldId, at } : undefined;
}

function dailyCapReached(worldId: string): ToolError {
  return new ToolError("CONFLICT", `${worldId} was already reset ${GUEST_WORLD_LIMITS.resetsPerDay} times this real day`, RESET_DAILY_CAP);
}

function refuse(meta: WorldMeta | undefined, worldId: string): ToolError {
  if (meta?.status === "RESETTING" || meta?.status === "EXPIRING") return new ToolError("CONFLICT", `${worldId} is already being reset`, "WORLD_RESETTING");
  return new ToolError("CONFLICT", `${worldId} is not ready`, "WORLD_NOT_READY");
}

/** The request half (see the header); the caller invokes `WorldJanitor` with the returned `requestId`. */
export async function requestWorldReset(deps: RequestDeps, input: ResetRequestInput): Promise<ResetRequested> {
  const kind = input.kind ?? "RESET";
  if (kind === "EXPIRE" && !isSignupWorld(input.worldId)) throw new ToolError("FORBIDDEN", "only a self-signup world expires", "NOT_EXPIRABLE");
  if (input.adopt && kind !== "EXPIRE") throw new ToolError("INVALID", "only an expiry adopts an expiring world", "NOT_EXPIRABLE");
  const from = input.adopt ? "EXPIRING" : "READY";
  const meta = await deps.connector.worlds.getMeta(input.worldId, { consistent: true });
  if (meta?.status !== from || (input.adopt && meta.reset !== undefined)) throw refuse(meta, input.worldId);
  const now = deps.now();
  if (input.minIntervalMs !== undefined && meta.lastResetAtReal && now.getTime() - Date.parse(meta.lastResetAtReal) < input.minIntervalMs) {
    throw new ToolError("CONFLICT", `${input.worldId} was reset less than ${Math.round(input.minIntervalMs / 60_000)} minutes ago`, "RATE_LIMITED");
  }
  const capBucket = resetCapBucket(input.worldId, kind, now);
  const { resetsPerDay } = GUEST_WORLD_LIMITS;
  if (capBucket && (await deps.connector.caps.peek(capBucket)) >= resetsPerDay) throw dailyCapReached(input.worldId);
  const fromEpoch = await deps.connector.counters.getEpoch(input.worldId);
  if (fromEpoch < 1) throw new ToolError("UNAVAILABLE", `${input.worldId} has no epoch counter`, "EPOCH_MISSING");
  const requestId = deps.newId();
  const at = now.toISOString();
  const status = kind === "EXPIRE" ? "EXPIRING" : "RESETTING";
  const { connector } = deps;
  try {
    await connector.transact([
      metaUpdateOp(deps, {
        worldId: input.worldId,
        from,
        to: status,
        ...(input.adopt ? { withoutReset: true as const } : {}),
        set: { reset: { requestId, fromEpoch, toEpoch: fromEpoch + 1, phase: "WIPE", requestedAtReal: at, heartbeatAtReal: at, attempts: 0 } },
        remove: ["buildCursor"],
      }),
      connector.counters.advanceEpochOp(input.worldId, fromEpoch),
      connector.runtime.putTombstoneOp({ worldId: input.worldId, epoch: fromEpoch, reason: kind === "EXPIRE" ? "DESTROY" : "RESET", atReal: at }),
      connector.counters.openTicketOp({ worldId: input.worldId, kind: "RESETREQ", requestId, openedAtReal: at }),
      connector.audit.appendOp({
        worldId: input.worldId,
        epoch: fromEpoch,
        auditId: `aud-${requestId.toLowerCase()}`,
        ts: at,
        action: kind === "EXPIRE" ? "GUEST_WORLD_EXPIRING" : "WORLD_RESET_REQUESTED",
        actor: input.actor,
        refs: { requestId, ...(input.reason ? { reason: input.reason } : {}) },
      }),
      // Counted with the request, so a refused request never spends one; the condition holds the cap under a race.
      ...(capBucket ? [connector.caps.incrementOp(capBucket, resetsPerDay)] : []),
    ]);
  } catch (error) {
    if (!isConflict(error)) throw error;
    const current = await connector.worlds.getMeta(input.worldId, { consistent: true });
    if (capBucket && current?.status === from && (await connector.caps.peek(capBucket)) >= resetsPerDay) throw dailyCapReached(input.worldId);
    throw refuse(current, input.worldId);
  }
  return { requestId, status, fromEpoch, toEpoch: fromEpoch + 1 };
}

/** The request, then the asynchronous invocation; a failed invocation is resumed by the hourly pass. */
export async function requestAndStartReset(deps: RequestDeps & Pick<WorldsDeps, "invoker" | "log">, input: ResetRequestInput): Promise<ResetRequested> {
  const requested = await requestWorldReset(deps, input);
  try {
    await deps.invoker.invoke({ kind: "WORLD_RESET", worldId: input.worldId, requestId: requested.requestId });
  } catch (error) {
    deps.log.warn("worlds.reset_invoke_failed", { worldId: input.worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
  return requested;
}

/** Where a reset stands, compared across resumes to tell progress from a stuck world. */
export function resetProgress(meta: WorldMeta): string {
  return `${meta.reset?.phase ?? "-"}:${meta.buildCursor?.phase ?? "-"}:${meta.buildCursor?.block ?? 0}`;
}

export type ResumeResult = "NOT_STALE" | "RESUMED" | "STUCK";

/**
 * Reopens a reset (or expiry) whose heartbeat is stale: ticket back to `OPEN` (attempts + 1, recreated
 * if it expired), `reset.attempts + 1` and a fresh heartbeat, then the asynchronous invocation.
 */
export async function resumeStaleReset(deps: RequestDeps & Pick<WorldsDeps, "store" | "invoker" | "log">, worldId: string): Promise<ResumeResult> {
  const { connector } = deps;
  const meta = await connector.worlds.getMeta(worldId, { consistent: true });
  const reset = meta?.reset;
  if (!meta || !reset || (meta.status !== "RESETTING" && meta.status !== "EXPIRING")) return "NOT_STALE";
  const now = deps.now();
  if (now.getTime() - Date.parse(reset.heartbeatAtReal) < STALE_HEARTBEAT_MS) return "NOT_STALE";
  const ticketKey = keys.runtime(worldId, "RESETREQ", reset.requestId);
  const ticket = await deps.store.get("Runtime", ticketKey, { consistent: true });
  const progress = resetProgress(meta);
  const detail = (ticket?.detail ?? {}) as { progress?: string; stalls?: number };
  // A stale heartbeat is an attempt that made no progress; a moved position starts the count again.
  const stalls = detail.progress === progress ? (detail.stalls ?? 0) + 1 : 1;
  const at = now.toISOString();
  const ticketOp = ticket
    ? { kind: "update" as const, table: "Runtime" as const, key: ticketKey, update: { set: { status: "OPEN", detail: { ...detail, progress, stalls }, updatedAt: at }, add: { attempts: 1, version: 1 }, remove: ["leaseUntilReal"] } }
    : connector.counters.openTicketOp({ worldId, kind: "RESETREQ", requestId: reset.requestId, openedAtReal: at, attempts: reset.attempts + 1 });
  await connector.transact([
    metaUpdateOp(deps, { worldId, from: meta.status, resetRequestId: reset.requestId, set: { "reset.attempts": reset.attempts + 1, "reset.heartbeatAtReal": at } }),
    ticketOp,
  ]);
  const stuck = stalls >= STUCK_AFTER;
  if (stuck) deps.log.error("worlds.reset_stuck", { metric: "WorldResetStuck", worldId, status: meta.status, attempts: reset.attempts + 1, progress });
  try {
    await deps.invoker.invoke({ kind: "WORLD_RESET", worldId, requestId: reset.requestId });
  } catch (error) {
    deps.log.warn("worlds.reset_invoke_failed", { worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
  return stuck ? "STUCK" : "RESUMED";
}
