// What the event workers run with (docs/architecture.md §7). The turn, the obligations, the execution of
// an approved action, the guardrail path, the fallback and the quiescence are this folder's own; the
// deterministic handlers of other modules come in through `EventHandlers`, imported in process
// (`caller WORKER`, docs/tool-catalog.md "Handlers de invocación directa") and wired by the Lambda entry
// (worker/production.ts):
//
//   TIMER             `fire_timer`                         timers/ (WP-30)
//   reconcile         `reconcile` of a complaint           reconcile/ (WP-27, as reconcile_payment does)
//   OPERATOR_ANSWER   the written answer (PDF + SES)        the answer pipeline of answer_complaint_in_writing (WP-29)
//   money             recompute and execute an approved     the money actions of the actions target (WP-29)
//                     action through the core's claim
//   EMAIL_EVENT       the effects of `record_email_event`   email-events/ effects (suppress, retry timer)
//   confirmAction     the closure or data change            the email pipeline of the gate (worker/confirmations.ts)
//                     confirmation email
//   HEALTH_PROBE      `/v1/health` of the core and networks core/, networks/
//
// A handler throws to put the event back on the queue; whatever it enqueues goes through `ctx.enqueue`,
// so the follow-up is in flight before the current event leaves it.
import type { CapAction, Caller, ReconciliationResult } from "@reclamo/shared";
import type { ComplaintsDeps } from "../complaints/deps";
import type { Connector } from "../connector/port";
import type { Action, Approval } from "../domain/case-items";
import type { Complaint } from "../domain/complaint";
import type { EmailEventEffects } from "../email-events/apply";
import type { Logger } from "../lib/log";
import type { OperatorReroute, OutboundGate } from "../outbound/types";
import type { TurnDeps } from "../turns/deps";
import type { Enqueuer } from "./enqueue";
import type { CustomerEventInput, EventOf } from "./events";

export interface WorkerContext {
  readonly log: Logger;
  /** Real time; the simulated "now" of every rule is the event's `eventAtSim`. */
  readonly now: () => Date;
  /** `ApproximateReceiveCount` of the delivery (1 on the first one). */
  readonly receiveCount: number;
  /** Producer of follow-up events (`ANSWER_DUE`, `RECONCILE_DUE`), with the worker's caller of the world. */
  readonly enqueue: (event: CustomerEventInput) => Promise<void>;
}

/** What `reconcile` found for a complaint whose receipt was read (the evidence and timers are its own). */
export interface ReconcileOutcome {
  readonly result: ReconciliationResult;
  readonly evidenceId?: string;
}

export interface ReconcileRequest {
  readonly worldId: string;
  readonly customerId: string;
  readonly complaint: Complaint;
  /** The `RECEIPT_READING` evidence the reconciliation is about (`readingId` is mandatory, §6.1). */
  readonly readingEvidenceId: string;
  readonly eventId: string;
  readonly atSim: string;
}

/** What the core answers for an approved money action, recomputed with the same evidence (§8.5 step 3). */
export interface MoneyQuote {
  readonly action: CapAction;
  readonly amountCents: number;
}

export type MoneyExecution =
  | { readonly status: "EXECUTED"; readonly actionId: string }
  | { readonly status: "CONFLICT"; readonly actionId: string }
  /** `retryable`: the core or the network could not answer now (the event is retried); otherwise they refused. */
  | { readonly status: "FAILED"; readonly reason: string; readonly retryable: boolean };

/** The money half of `execute_approved_action`: the core's amount and its natural-key claim. */
export interface ApprovedMoneyActions {
  quote(approval: Approval, complaint: Complaint, ctx: { readonly atSim: string; readonly correlationId: string }): Promise<MoneyQuote>;
  execute(approval: Approval, complaint: Complaint, ctx: { readonly atSim: string; readonly correlationId: string; readonly idempotencyKey: string }): Promise<MoneyExecution>;
}

export interface WrittenAnswerRequest {
  readonly event: EventOf<"OPERATOR_ANSWER">;
  readonly complaint: Complaint;
  readonly actor: `OPERATOR:${string}`;
}

/** An `ACCOUNT_CLOSURE` or `DATA_CHANGE` the core took for a complaint: its confirmation email is owed. */
export interface ConfirmationRequest {
  readonly worldId: string;
  readonly customerId: string;
  readonly eventId: string;
  readonly correlationId?: string;
  readonly eventAtSim: string;
  readonly complaint: Complaint;
  readonly action: Action;
}

export interface EventHandlers {
  fireTimer(event: EventOf<"TIMER">, ctx: WorkerContext): Promise<void>;
  reconcile(request: ReconcileRequest, ctx: WorkerContext): Promise<ReconcileOutcome>;
  writtenAnswer(request: WrittenAnswerRequest, ctx: WorkerContext): Promise<void>;
  /** Sends the confirmation email of a closure or a data change through the gate (sender `SYSTEM`). */
  confirmAction(request: ConfirmationRequest, ctx: WorkerContext): Promise<void>;
  readonly money: ApprovedMoneyActions;
  /** The effects of `record_email_event` for one `EMAIL_EVENT` (its world, epoch and customer). */
  emailEffects(event: EventOf<"EMAIL_EVENT">, ctx: WorkerContext): EmailEventEffects;
  /** `GET /v1/health` of the core and the networks with the worker's role; throws when either is down. */
  healthProbe(event: EventOf<"HEALTH_PROBE">, ctx: WorkerContext): Promise<{ readonly core: string; readonly networks: string }>;
}

/** Releases a poison message at once (visibility 0), so its two deliveries reach the QA dead letters fast. */
export interface QueueVisibility {
  releaseNow(receiptHandle: string, queueUrl: string): Promise<void>;
}

export interface WorkerDeps {
  readonly data: Connector;
  readonly complaints: ComplaintsDeps;
  readonly gate: OutboundGate;
  /** A permitted path the console picked for a blocked message (`OPERATOR_SEND` with `route`). */
  readonly reroute: OperatorReroute;
  readonly turn: Omit<TurnDeps, "data">;
  readonly handlers: EventHandlers;
  readonly enqueuer: Enqueuer;
  readonly queue: QueueVisibility;
  /** Real time. */
  readonly now: () => Date;
  readonly loggerFor: (correlationId: string) => Logger;
}

/** The worker's caller for a world: who enqueues follow-ups and calls targets in process. */
export function workerCaller(worldId: string, eventId: string): Caller {
  return { kind: "WORKER", worldId, eventId };
}
