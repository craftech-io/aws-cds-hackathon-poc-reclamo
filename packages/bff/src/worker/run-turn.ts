// The gates every turn passes before the Harness, in this order (docs/architecture.md §7 and §9.1,
// docs/architecture-guests.md §7 "Orden de la cadena de costo"), and what the worker does with the turn's
// outcome:
//
//   1. `control = OPERATOR` → no turn: the event stays on the timeline (`TURN_SKIPPED_CONTROL_OPERATOR`,
//      `CH-CONTROL`, FL-084);
//   2. the kill switch (`KILL#AGENT`, `W#<w>#KILL`) → `AGENT_KILLED`, `AgentKilled`, handoff (FL-109);
//   3. the world's `TURN_CAP` (hour, day; epoch for a self-signup world), then the pool's `GLOBAL_CAP`
//      (PUBLIC, SIGNUP or QA) → `TURN_CAP` / `GLOBAL_CAP`, `TurnCapHits` / `GlobalCapHits`, handoff
//      (FL-105, FL-125). Nothing that costs ran: no G1, no preloaded read, no Harness;
//   4. the turn (turns/turn.ts): G1, session, preloaded reads, memory, Harness;
//   5. BLOCKED → worker/guardrail-block.ts; FAILED → worker/fallback.ts; COMPLETED → the obligations.
//
// Every decision is audited once per event, so a retried event never doubles a row.
import { deferAutoClose } from "../complaints/auto-close";
import { runTurn } from "../turns/turn";
import type { TurnOutcome } from "../turns/deps";
import { loadTurnContext } from "../turns/facts";
import { WORKER_ACTIONS, auditOnce, countMetric } from "./audit";
import { poolBuckets, poolOf, worldBuckets, countTurnIn } from "./caps";
import { type HandoffDeps, handOff } from "./escalation";
import { type TurnEvent, answersOf } from "./events";
import { runFallback } from "./fallback";
import { handleGuardrailBlock } from "./guardrail-block";
import { AGENT_KILLED_METRIC, agentKillScope } from "./kill";
import { type ObligationFired, runObligations } from "./obligations";
import type { WorkerContext, WorkerDeps } from "./ports";

export const TURN_CAP_METRIC = "TurnCapHits";
export const GLOBAL_CAP_METRIC = "GlobalCapHits";

export type GateRefusal = "CONTROL_OPERATOR" | "AGENT_KILLED" | "TURN_CAP" | "GLOBAL_CAP";

export type TurnRun = { readonly kind: "REFUSED"; readonly refusal: GateRefusal } | { readonly kind: "RAN"; readonly outcome: TurnOutcome; readonly obligations: readonly ObligationFired[] };

function handoffDeps(deps: WorkerDeps, ctx: WorkerContext): HandoffDeps {
  return { data: deps.data, complaints: deps.complaints, gate: deps.gate, now: ctx.now, log: ctx.log };
}

async function refuseWithHandoff(deps: WorkerDeps, ctx: WorkerContext, event: TurnEvent, refusal: Exclude<GateRefusal, "CONTROL_OPERATOR">, detail: Readonly<Record<string, string | number>>): Promise<TurnRun> {
  const handoff = handoffDeps(deps, ctx);
  const action = refusal === "AGENT_KILLED" ? WORKER_ACTIONS.agentKilled : refusal === "TURN_CAP" ? WORKER_ACTIONS.turnCap : WORKER_ACTIONS.globalCap;
  await auditOnce(handoff, { action, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, ruleIds: [refusal], refs: { customerId: event.customerId }, detail: { trigger: event.type, ...detail } });
  countMetric(ctx.log, refusal === "AGENT_KILLED" ? AGENT_KILLED_METRIC : refusal === "TURN_CAP" ? TURN_CAP_METRIC : GLOBAL_CAP_METRIC, { trigger: event.type, ...detail });
  const complaintId = "complaintId" in event.payload ? event.payload.complaintId : undefined;
  await handOff(handoff, {
    worldId: event.worldId,
    customerId: event.customerId,
    epoch: event.epoch,
    eventId: event.eventId,
    eventAtSim: event.eventAtSim,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    reason: "OTHER",
    summary: refusal,
    ...(complaintId === undefined ? {} : { complaintId }),
    notify: true,
    cause: refusal,
    ...answersOf(event),
  });
  return { kind: "REFUSED", refusal };
}

/** Steps 1-3: who may run a turn now. `undefined` when every gate let it through (and counted it). */
async function gates(deps: WorkerDeps, ctx: WorkerContext, event: TurnEvent, control: "AGENT" | "OPERATOR"): Promise<TurnRun | undefined> {
  if (control === "OPERATOR") {
    await auditOnce(handoffDeps(deps, ctx), { action: WORKER_ACTIONS.skippedControl, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, ruleIds: ["CH-CONTROL"], refs: { customerId: event.customerId }, detail: { trigger: event.type } });
    return { kind: "REFUSED", refusal: "CONTROL_OPERATOR" };
  }
  const killed = await agentKillScope(deps.data, event.worldId);
  if (killed !== undefined) return refuseWithHandoff(deps, ctx, event, "AGENT_KILLED", { scope: killed });
  const settings = await deps.data.worlds.getSettings(event.worldId);
  if (settings === undefined) throw new Error("the world has no settings: the event is retried once the world is ready");
  const at = ctx.now();
  const world = await countTurnIn(deps.data, worldBuckets(event.worldId, event.epoch, settings, at), at);
  if (!world.allowed) return refuseWithHandoff(deps, ctx, event, "TURN_CAP", { window: world.bucket.window, cap: world.bucket.limit });
  const pool = await countTurnIn(deps.data, poolBuckets(event.worldId, at), at);
  if (!pool.allowed) return refuseWithHandoff(deps, ctx, event, "GLOBAL_CAP", { pool: poolOf(event.worldId), window: pool.bucket.window, cap: pool.bucket.limit });
  return undefined;
}

/** Runs a turn event through the gates, the Harness and what follows its outcome. */
export async function runTurnEvent(deps: WorkerDeps, ctx: WorkerContext & { readonly deadlineMs: number }, event: TurnEvent): Promise<TurnRun> {
  // A message of the customer while a complaint is answered moves its automatic closure (FL-083).
  if (event.type === "CUSTOMER_MESSAGE") await deferAutoClose(deps.complaints, { worldId: event.worldId, customerId: event.customerId, atSim: event.eventAtSim });
  const context = await loadTurnContext(deps.data, event);
  const refused = await gates(deps, ctx, event, context.conversation?.control ?? "AGENT");
  if (refused !== undefined) return refused;
  const outcome = await runTurn({ ...deps.turn, data: deps.data }, event, { log: ctx.log, now: ctx.now, deadlineMs: ctx.deadlineMs }, context);
  const handoff = handoffDeps(deps, ctx);
  if (outcome.kind === "BLOCKED") {
    await handleGuardrailBlock(handoff, event, outcome);
    return { kind: "RAN", outcome, obligations: [] };
  }
  if (outcome.kind === "FAILED") {
    await runFallback(handoff, event, outcome);
    return { kind: "RAN", outcome, obligations: [] };
  }
  if (outcome.kind === "SKIPPED") return { kind: "RAN", outcome, obligations: [] };
  const obligations = await runObligations({ ...handoff, handlers: deps.handlers }, ctx, event, outcome);
  ctx.log.info("turn.completed", { trigger: event.type, toolUses: outcome.toolUses, stopReason: outcome.stopReason, obligations: obligations.join(",") });
  return { kind: "RAN", outcome, obligations };
}
