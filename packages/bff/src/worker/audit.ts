// The worker's own decisions in `AuditLog` (docs/architecture.md §7, §8.5, §9.1): turns skipped by the
// operator's control, cut by a cap or the kill switch, guardrail blocks and masks, failed and silent
// turns, obligations, executions of an approved action, events discarded (wrong queue, tombstoned) and
// events lost to the dead-letter queue. Each one is written at most once per event and action
// (`IDEMP#AUDIT#<action>.<eventId>` first), so a retried event never doubles a row. Actor `SYSTEM`: the
// deterministic code decided, not the agent. Refs are ids and codes only, masked by the audit writer.
import type { Connector } from "../connector/port";
import type { JsonObject } from "../domain/common";
import { ulid } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { maskAuditRefs } from "../auth/audit";

export const WORKER_ACTIONS = {
  skippedControl: "TURN_SKIPPED_CONTROL_OPERATOR",
  turnCap: "TURN_CAP",
  globalCap: "GLOBAL_CAP",
  agentKilled: "AGENT_KILLED",
  guardrailBlock: "GUARDRAIL_BLOCK",
  guardrailMask: "GUARDRAIL_MASK",
  memoryDiscarded: "MEMORY_DISCARDED",
  turnFailed: "TURN_FAILED",
  agentFallback: "AGENT_FALLBACK",
  agentSilent: "AGENT_SILENT",
  answerDue: "ANSWER_DUE",
  reconcileDue: "RECONCILE_DUE",
  answerObligationFailed: "ANSWER_OBLIGATION_FAILED",
  reconcileObligationFailed: "RECONCILE_OBLIGATION_FAILED",
  reconciledByCode: "RECONCILED_BY_CODE",
  approvalNotExecutable: "APPROVAL_NOT_EXECUTABLE",
  actionExecuted: "EXECUTED",
  executionRefused: "EXECUTION_REFUSED",
  handoff: "HANDOFF",
  operatorRefused: "OPERATOR_EVENT_REFUSED",
  deadLettered: "EVENT_DEAD_LETTERED",
  wrongQueue: "WRONG_QUEUE",
  tombstoned: "TOMBSTONED_EVENT",
  emailSuppressed: "EMAIL_SUPPRESSED",
  followUpSkipped: "FOLLOW_UP_SKIPPED",
} as const;
export type WorkerAction = (typeof WORKER_ACTIONS)[keyof typeof WORKER_ACTIONS];

export interface WorkerDecision {
  readonly action: WorkerAction;
  readonly worldId: string;
  /** The epoch of the event: its audit partition. */
  readonly epoch: number;
  readonly eventId: string;
  /** Simulated instant of the event: the decision's place in the timeline. */
  readonly atSim?: string;
  readonly ruleIds?: readonly string[];
  readonly refs?: Readonly<Record<string, string>>;
  readonly outcome?: string;
  readonly detail?: JsonObject;
}

export interface AuditDeps {
  readonly data: Pick<Connector, "audit" | "claims">;
  /** Real time (audit stamps are real). */
  readonly now: () => Date;
  readonly log: Logger;
}

/** The `ByRef` index entry of a decision: its complaint, else its customer. */
function primaryRefOf(refs: Readonly<Record<string, string>>): string | undefined {
  if (refs["complaintId"] !== undefined) return `CMP#${refs["complaintId"]}`;
  if (refs["customerId"] !== undefined) return `CUS#${refs["customerId"]}`;
  return undefined;
}

/** Writes the decision once per event and action; a repeat returns `false` and writes nothing. */
export async function auditOnce(deps: AuditDeps, decision: WorkerDecision): Promise<boolean> {
  const claim = await deps.data.claims.claimOnce(decision.worldId, "AUDIT", `${decision.action}.${decision.eventId}`.slice(0, 160));
  if (!claim.first) return false;
  const at = deps.now();
  const refs = maskAuditRefs({ ...(decision.refs ?? {}), eventId: decision.eventId }, deps.log);
  const primaryRef = primaryRefOf(refs);
  await deps.data.audit.append({
    worldId: decision.worldId,
    epoch: decision.epoch,
    auditId: ulid(at.getTime()),
    ts: at.toISOString(),
    ...(decision.atSim === undefined ? {} : { atSim: decision.atSim }),
    action: decision.action,
    actor: "SYSTEM",
    ...(decision.ruleIds === undefined ? {} : { ruleIds: [...decision.ruleIds] }),
    refs,
    ...(primaryRef === undefined ? {} : { primaryRef }),
    ...(decision.outcome === undefined ? {} : { outcome: decision.outcome }),
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
  });
  return true;
}

/** A metric line for the metric filters (observability is logs only, ADR-0021 §11). */
export function countMetric(log: Logger, metric: string, fields: Readonly<Record<string, unknown>> = {}): void {
  log.info("metric", { metric, ...fields });
}
