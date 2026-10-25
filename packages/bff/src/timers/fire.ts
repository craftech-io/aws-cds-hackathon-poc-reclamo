// `fire_timer` (docs/tool-catalog.md, docs/architecture.md §10): the one way a timer fires, whoever
// fires it — a Scheduler schedule (`firedBy SCHEDULER`, timers/dispatch.ts), the demo clock
// (`firedBy CLOCK`, clock/advance.ts) or a direct dispatch of a running world's timer due within a
// minute (`SCHEDULER`, timers/resync.ts). In every mode the event happens at `eventAtSim = dueAtSim`,
// never at the arrival time, so a late Scheduler fire decides exactly as the clock would have.
//
//   1. claim: conditional `SCHEDULED → FIRED` on status, version and epoch; a lost race is `RACE`
//      and does nothing (the winner runs the effect)
//   2. the effect of its kind (routes.ts), with event ids derived from the claim
//   3. `AuditLog TIMER_FIRED`
//
// If the effect fails after the claim, the claim is undone (`FIRED → SCHEDULED`, version + 1): the timer
// is due again, so the world reads busy and the next move of the clock (or a resync of a running world)
// fires it again; every id it produces is derived, so nothing runs twice.
import type { TimerFiredBy } from "@reclamo/shared";
import type { Timer } from "../domain/timer";
import { isConflict } from "../connector/errors";
import { type TimerDeps, errorNameOf, newIdOf } from "./deps";
import { type DispatchEffect, dispatchEffect } from "./routes";

export interface FireRequest {
  readonly timer: Timer;
  readonly firedBy: TimerFiredBy;
  readonly correlationId?: string;
}

export type FireOutcome =
  | { readonly status: "FIRED"; readonly timer: Timer; readonly effect: DispatchEffect }
  | { readonly status: "RACE" }
  | { readonly status: "FAILED"; readonly errorName: string };

/** `CMP#<id>` of a complaint's timer, the audit entry's `ByRef` key; none for batches and transfers. */
function primaryRefOf(timer: Timer): string | undefined {
  return timer.ownerKey?.startsWith("CMP#") ? timer.ownerKey : undefined;
}

export async function auditTimer(deps: TimerDeps, timer: Timer, action: string, outcome: string, detail: Record<string, string | number | boolean>): Promise<void> {
  const primaryRef = primaryRefOf(timer);
  try {
    await deps.connector.audit.append({
      worldId: timer.worldId,
      epoch: timer.epoch,
      auditId: newIdOf(deps, "aud"),
      ts: deps.realNow().toISOString(),
      atSim: timer.dueAtSim,
      action,
      actor: "SYSTEM",
      refs: { timerKey: deps.connector.timers.timerKey(timer), kind: timer.kind, timerId: timer.timerId },
      ...(primaryRef ? { primaryRef } : {}),
      outcome,
      detail,
    });
  } catch (error) {
    // The audit never undoes what already happened; the log line keeps the decision.
    deps.log.error("timers.audit_failed", { worldId: timer.worldId, action, errorName: errorNameOf(error) });
  }
}

async function claim(timer: Timer, firedBy: TimerFiredBy, deps: TimerDeps): Promise<Timer | undefined> {
  try {
    return await deps.connector.timers.transition({
      worldId: timer.worldId,
      kind: timer.kind,
      timerId: timer.timerId,
      version: timer.version,
      from: ["SCHEDULED"],
      to: "FIRED",
      epoch: timer.epoch,
      firedBy,
      firedAtSim: timer.dueAtSim,
    });
  } catch (error) {
    if (isConflict(error)) return undefined;
    throw error;
  }
}

async function undoClaim(claimed: Timer, deps: TimerDeps): Promise<void> {
  try {
    await deps.connector.timers.transition({ worldId: claimed.worldId, kind: claimed.kind, timerId: claimed.timerId, version: claimed.version, from: ["FIRED"], to: "SCHEDULED", epoch: claimed.epoch, reason: "DISPATCH_FAILED" });
  } catch (error) {
    deps.log.error("timers.undo_failed", { worldId: claimed.worldId, kind: claimed.kind, timerId: claimed.timerId, errorName: errorNameOf(error) });
  }
}

/** Claims and fires one timer at its own `dueAtSim`. */
export async function fireTimer(request: FireRequest, deps: TimerDeps): Promise<FireOutcome> {
  const { timer, firedBy } = request;
  const claimed = await claim(timer, firedBy, deps);
  if (!claimed) {
    deps.log.info("timers.fire_race", { worldId: timer.worldId, kind: timer.kind, timerId: timer.timerId, firedBy });
    return { status: "RACE" };
  }
  // A schedule left behind by a fire that did not come from it: it would fire and be discarded anyway.
  if (timer.scheduleName && firedBy !== "SCHEDULER" && deps.scheduler) {
    await deps.scheduler.delete(timer.scheduleName).catch((error: unknown) => deps.log.warn("timers.schedule_delete_failed", { worldId: timer.worldId, errorName: errorNameOf(error) }));
  }
  try {
    const effect = await dispatchEffect(claimed, timer.version, deps, { firedBy, ...(request.correlationId ? { correlationId: request.correlationId } : {}) });
    deps.log.info("timers.fired", { worldId: timer.worldId, kind: timer.kind, timerId: timer.timerId, firedBy, enqueued: effect.enqueued.length, alsoFired: effect.alsoFired.length, note: effect.note });
    await auditTimer(deps, claimed, "TIMER_FIRED", firedBy, { enqueued: effect.enqueued.length, alsoFired: effect.alsoFired.join(",").slice(0, 200), ...(effect.note ? { note: effect.note } : {}) });
    for (const timerId of effect.alsoFired) {
      await auditTimer(deps, { ...claimed, kind: "SETTLEMENT_RECHECK", timerId }, "TIMER_FIRED", "PUBLICATION", { publishedBy: timer.timerId });
    }
    return { status: "FIRED", timer: claimed, effect };
  } catch (error) {
    const errorName = errorNameOf(error);
    deps.log.error("timers.dispatch_failed", { metric: "TimerDispatchFailures", worldId: timer.worldId, kind: timer.kind, timerId: timer.timerId, firedBy, errorName });
    await undoClaim(claimed, deps);
    await auditTimer(deps, claimed, "TIMER_DISPATCH_FAILED", errorName, { firedBy });
    return { status: "FAILED", errorName };
  }
}
