// The destructive phases of a reset, an expiry and a destruction (docs/architecture.md §10):
//
//   WIPE     waits until no event of the old epoch is in flight (7 minutes at most, then goes on and
//            audits RESET_FORCED_BUSY), deletes the Scheduler schedule of every timer, then deletes
//            through `WorldIndex` every item of the world in `Core`, `Networks`, `Complaints`, `Timers`,
//            `Conversations` (and its `Metrics` partition), plus the runtime rows a reload rewrites
//            (pending emails and scans, identity-challenge ledgers). It never touches `Worlds`
//            (`META`, `SETTINGS`, `STAFF#`), the append-only tables, the epoch counter, tombstones,
//            tickets or the real-clock caps: worlds/repos refuse it (connector/repos/world-items.ts).
//   OBJECTS  deletes the objects under the world root (never `Exports`).
//
// Every step is idempotent and checks the budget between blocks, so a cut run repeats it safely.
import { isConflict } from "../connector/errors";
import { keys } from "../connector/keys";
import { WORLD_INDEXED_TABLES, type WorldIndexedTable } from "../connector/repos/world-items";
import type { Key } from "../connector/store";
import { worldObjectRoot } from "../channels/email/config";
import { type Budget, type WorldsDeps, outOfTime } from "./deps";
import type { TemplateDocument } from "./template";

/** A worker turn ends or times out within 360 s; an older in-flight token is a leftover. */
const IN_FLIGHT_MAX_AGE_MS = 360_000;
export const QUIET_WAIT_CAP_MS = 7 * 60_000;
const QUIET_POLL_MS = 5_000;
/** Passes over a table until one finds nothing (the index is eventually consistent). */
const WIPE_PASSES = 5;
const PAGE = 200;
const OBJECTS_PER_CALL = 1_000;

export type StepResult = "DONE" | "OUT_OF_TIME";

type WipeDeps = Pick<WorldsDeps, "connector" | "store" | "schedules" | "objects" | "log" | "now" | "sleep" | "newId">;

function liveTokens(tokens: readonly string[], now: number): string[] {
  return tokens.filter((token) => {
    const added = Number(token.split("~")[1]);
    return !Number.isFinite(added) || now - added < IN_FLIGHT_MAX_AGE_MS;
  });
}

/**
 * Waits for the world's in-flight events to end; `FORCED` after the cap (the caller audits it), and
 * `OUT_OF_TIME` when the invocation would end first (the next one waits again).
 */
export async function waitQuiet(deps: WipeDeps, worldId: string, budget: Budget): Promise<"QUIET" | "FORCED" | "OUT_OF_TIME"> {
  const started = deps.now().getTime();
  for (;;) {
    const state = await deps.connector.runtime.getWorldState(worldId);
    if (liveTokens(state.inFlight, deps.now().getTime()).length === 0) return "QUIET";
    if (deps.now().getTime() - started >= QUIET_WAIT_CAP_MS) return "FORCED";
    if (outOfTime(budget)) return "OUT_OF_TIME";
    await deps.sleep(QUIET_POLL_MS);
  }
}

/** Deletes the schedule of every timer of the world (a missing one is fine; a leftover would be discarded). */
export async function deleteSchedules(deps: WipeDeps, worldId: string, budget: Budget): Promise<StepResult> {
  let cursor: string | undefined;
  do {
    if (outOfTime(budget)) return "OUT_OF_TIME";
    const page = await deps.connector.worldItems.listKeys("Timers", worldId, { limit: PAGE, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const timer = await deps.store.get("Timers", key, { consistent: true });
      if (typeof timer?.scheduleName === "string" && timer.scheduleName !== "") await deps.schedules.delete(timer.scheduleName);
    }
    cursor = page.cursor;
  } while (cursor);
  return "DONE";
}

async function wipePass(deps: WipeDeps, table: WorldIndexedTable | "Metrics", worldId: string, budget: Budget, heartbeat: () => Promise<void>): Promise<number | "OUT_OF_TIME"> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    if (outOfTime(budget)) return "OUT_OF_TIME";
    const options = { limit: PAGE, ...(cursor ? { cursor } : {}) };
    const page = table === "Metrics" ? await deps.connector.worldItems.listMetricsKeys(worldId, options) : await deps.connector.worldItems.listKeys(table, worldId, options);
    if (page.keys.length > 0) {
      await deps.connector.worldItems.delete(table, worldId, page.keys);
      deleted += page.keys.length;
      await heartbeat();
    }
    cursor = page.cursor;
  } while (cursor);
  return deleted;
}

/** Deletes every item of the world in the indexed tables and its metrics, pass after pass until empty. */
export async function wipeTables(deps: WipeDeps, worldId: string, budget: Budget, heartbeat: () => Promise<void>): Promise<StepResult> {
  for (const table of [...WORLD_INDEXED_TABLES, "Metrics"] as const) {
    for (let pass = 0; pass < WIPE_PASSES; pass += 1) {
      const deleted = await wipePass(deps, table, worldId, budget, heartbeat);
      if (deleted === "OUT_OF_TIME") return "OUT_OF_TIME";
      if (deleted === 0) break;
      if (pass === WIPE_PASSES - 1) deps.log.warn("worlds.wipe_not_settled", { worldId, table });
      else await deps.sleep(1_000);
    }
  }
  return "DONE";
}

/** The customers of a template (their challenge ledgers are per customer). */
export function templateCustomerIds(template: TemplateDocument): string[] {
  return template.items.filter((row) => row.table === "Core" && row.entity === "Customer").map((row) => String(row.data.customerId));
}

/** The runtime rows a reload starts from scratch: pending emails and scans, identity-challenge ledgers. */
export async function wipeRuntimeRows(deps: WipeDeps, worldId: string, customerIds: readonly string[]): Promise<void> {
  const pending = await deps.connector.runtime.listPending(worldId);
  for (const item of pending) await deps.connector.write(deps.connector.runtime.closePendingOp(worldId, item.kind, item.pendingId));
  const ledgers: Key[] = customerIds.map((customerId) => keys.runtime(worldId, "CHALLENGE", customerId));
  for (let start = 0; start < ledgers.length; start += PAGE) await deps.connector.worldItems.delete("Runtime", worldId, ledgers.slice(start, start + PAGE));
}

/**
 * Every pending approval of the old epoch expires with the epoch (docs/architecture.md §8.5), audited
 * once: the entry's key is fixed by the reset (`at` is its request instant), so a repeated `WIPE` finds it.
 */
export async function expirePendingApprovals(deps: WipeDeps, worldId: string, epoch: number, at: string): Promise<number> {
  const pending = await deps.connector.caseItems.listPendingApprovals(worldId, 500);
  let expired = 0;
  for (const approval of pending) {
    try {
      await deps.connector.audit.append({
        worldId,
        epoch,
        auditId: `aud-expired-${approval.approvalId}`,
        ts: at,
        action: "APPROVAL_EXPIRED",
        actor: "SYSTEM",
        refs: { approvalId: approval.approvalId, complaintId: approval.complaintId },
        primaryRef: `CMP#${approval.complaintId}`,
        outcome: "EPOCH_CHANGED",
      });
      expired += 1;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  return expired;
}

async function deletePrefix(deps: WipeDeps, prefix: string, budget: Budget, heartbeat: () => Promise<void>): Promise<StepResult> {
  for (;;) {
    if (outOfTime(budget)) return "OUT_OF_TIME";
    const deleted = await deps.objects.deleteUnder(prefix, OBJECTS_PER_CALL);
    if (deleted === 0) return "DONE";
    await heartbeat();
  }
}

/**
 * Deletes the world's objects (`Media`, `Documents`, `Emails`, `Settlements`) until none is left: the
 * world root, and in `Media` the simulator's uploads (`up/<w>/`) and live WhatsApp media (`wa/<w>/`),
 * which live outside the root and also expire by lifecycle (a refusal there is logged, not fatal).
 */
export async function deleteObjects(deps: WipeDeps, worldId: string, budget: Budget, heartbeat: () => Promise<void>): Promise<StepResult> {
  if ((await deletePrefix(deps, worldObjectRoot(worldId), budget, heartbeat)) === "OUT_OF_TIME") return "OUT_OF_TIME";
  for (const prefix of [`up/${worldId}/`, `wa/${worldId}/`]) {
    try {
      if ((await deletePrefix(deps, prefix, budget, heartbeat)) === "OUT_OF_TIME") return "OUT_OF_TIME";
    } catch (error) {
      deps.log.warn("worlds.media_cleanup_skipped", { worldId, prefix: prefix.slice(0, 3), errorName: error instanceof Error ? error.name : "UnknownError" });
    }
  }
  return "DONE";
}
