// The deterministic fallback of a failed turn (docs/design-brief.md §8.1, FL-107): a timeout of the
// Harness, a stream error, a turn that ended without finishing (`max_tokens`, too many iterations) or a
// QA-forced failure. The complaint number and the acknowledgement already went out by code; the
// customer gets the fixed `HANDOFF_NOTICE`, the matter goes to a person with reason `OTHER`, and the
// worker audits `TURN_FAILED` and `AGENT_FALLBACK`. Nothing of the failed turn's text is ever sent.
import { HANDOFF_REASON_LABEL } from "../copy";
import type { TurnOutcome } from "../turns/deps";
import { WORKER_ACTIONS, auditOnce, countMetric } from "./audit";
import { type HandoffDeps, type HandoffResult, handOff } from "./escalation";
import { type TurnEvent, answersOf } from "./events";

export type FailedTurn = Extract<TurnOutcome, { kind: "FAILED" }>;

/** Fixed summary for the operator: the reason's label and the cause codes, never the customer's words. */
export function fallbackSummary(failure: Pick<FailedTurn, "cause" | "stopReason">): string {
  return [HANDOFF_REASON_LABEL.OTHER, "AGENT_FALLBACK", failure.cause, ...(failure.stopReason === undefined ? [] : [failure.stopReason])].join(" · ");
}

export async function runFallback(deps: HandoffDeps, event: TurnEvent, failure: FailedTurn): Promise<HandoffResult> {
  const refs = { customerId: event.customerId, turnId: failure.turnId };
  await auditOnce(deps, { action: WORKER_ACTIONS.turnFailed, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, outcome: failure.cause, refs, detail: { trigger: event.type, ...(failure.stopReason === undefined ? {} : { stopReason: failure.stopReason }) } });
  const handoff = await handOff(deps, {
    worldId: event.worldId,
    customerId: event.customerId,
    epoch: event.epoch,
    eventId: event.eventId,
    eventAtSim: event.eventAtSim,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    reason: "OTHER",
    summary: fallbackSummary(failure),
    ...(failure.complaintIds[0] === undefined ? {} : { complaintId: failure.complaintIds[0] }),
    notify: true,
    cause: "AGENT_FALLBACK",
    ...answersOf(event),
  });
  await auditOnce(deps, {
    action: WORKER_ACTIONS.agentFallback,
    worldId: event.worldId,
    epoch: event.epoch,
    eventId: event.eventId,
    atSim: event.eventAtSim,
    outcome: failure.cause,
    refs: { ...refs, ...(handoff.complaint === undefined ? {} : { complaintId: handoff.complaint.complaintId }) },
    detail: { notified: handoff.noticeMessageId !== undefined },
  });
  countMetric(deps.log, "AgentFallbacks", { cause: failure.cause, trigger: event.type });
  return handoff;
}
