// The complaint state machine (docs/design-brief.md §4, docs/architecture.md §8.1). The allowed
// transitions are data (`from → to → requires`), and `transition()` is the ONLY function that changes
// `Complaint.status`: a conditional update on `version` and on the allowed origin states, plus the
// register entry (`STATUS`, `WITHDRAWN` or `RECLASSIFIED`) in the same `TransactWriteItems`
// (appendChained). A cancelled transaction re-reads the complaint and the head and retries; a
// transition the table does not allow is a programming error (`INVALID_TRANSITION`, alarm).
//
// `requires` are code preconditions: `RESOLVED` needs an action or evidence that founds it (an
// operator resolving a human case is the foundation itself); `ANSWERED` needs the written answer sent
// (`answer.messageId` with proof `SENT` or `DELIVERED`); `CLOSED` needs five business days since it.
// Reaching `ANSWERED` (or withdrawing) cancels the SLA milestones in the same transaction, and
// `ANSWERED` adds the `AUTO_CLOSE` timer; leaving `ANSWERED` cancels that timer.
import { type ComplaintStatus, ToolError, type ErrorCode } from "@reclamo/shared";
import type { Actor } from "../domain/common";
import type { Complaint } from "../domain/complaint";
import type { RegisterEventType } from "../domain/ledger";
import type { ComplaintPatch } from "../connector/repos/complaints";
import type { WriteOp } from "../connector/store";
import type { ComplaintsDeps } from "./deps";
import { foundsResolution } from "./foundation";
import { type AppendChainedResult, appendChained } from "./register";
import { type CancelPlan, autoCloseAt, autoCloseTimer, cancelMilestonesPlan, cancelTimersPlan, loadHolidays } from "./sla";

export type Requirement = "FOUNDATION" | "ANSWER_SENT" | "AUTO_CLOSE_DUE";

export interface TransitionRule {
  readonly from: readonly ComplaintStatus[];
  readonly to: ComplaintStatus;
  readonly requires?: Requirement;
}

/** Statuses whose case is still being worked (the withdrawal and the hand-off apply to all of them). */
export const WORKING_STATUSES: readonly ComplaintStatus[] = ["REGISTERED", "INVESTIGATING", "AWAITING_CUSTOMER", "AWAITING_SETTLEMENT", "AWAITING_NETWORK", "AWAITING_APPROVAL"];

/** Every allowed transition (docs/design-brief.md §4). */
export const TRANSITIONS: readonly TransitionRule[] = [
  { from: ["REGISTERED", "AWAITING_CUSTOMER", "AWAITING_SETTLEMENT", "AWAITING_NETWORK"], to: "INVESTIGATING" },
  { from: ["INVESTIGATING"], to: "AWAITING_CUSTOMER" },
  { from: ["INVESTIGATING"], to: "AWAITING_SETTLEMENT" },
  { from: ["INVESTIGATING"], to: "AWAITING_NETWORK" },
  // From a person's case too: an action above the cap is the same request whoever holds the case, and
  // HUMAN_REVIEW → RESOLVED already lets the agent apply money under the cap.
  { from: ["INVESTIGATING", "HUMAN_REVIEW"], to: "AWAITING_APPROVAL" },
  { from: ["INVESTIGATING", "AWAITING_APPROVAL", "HUMAN_REVIEW"], to: "RESOLVED", requires: "FOUNDATION" },
  { from: [...WORKING_STATUSES, "RESOLVED", "ANSWERED"], to: "HUMAN_REVIEW" },
  { from: ["RESOLVED"], to: "ANSWERED", requires: "ANSWER_SENT" },
  { from: ["ANSWERED"], to: "CLOSED", requires: "AUTO_CLOSE_DUE" },
];

/** What the agent may ask for with `update_complaint`; the rest comes from other tools or the console. */
export const AGENT_REQUESTABLE: readonly ComplaintStatus[] = ["AWAITING_CUSTOMER", "AWAITING_SETTLEMENT", "AWAITING_NETWORK", "INVESTIGATING", "RESOLVED"];

/** Statuses a withdrawal can start from: every one before the written answer. */
export const WITHDRAWABLE: readonly ComplaintStatus[] = [...WORKING_STATUSES, "HUMAN_REVIEW", "RESOLVED"];

export function ruleFor(from: ComplaintStatus, to: ComplaintStatus): TransitionRule | undefined {
  return TRANSITIONS.find((rule) => rule.to === to && rule.from.includes(from));
}

/** Origin states the table allows for `to`. */
export function allowedFrom(to: ComplaintStatus): ComplaintStatus[] {
  return [...new Set(TRANSITIONS.filter((rule) => rule.to === to).flatMap((rule) => rule.from))];
}

export function canTransition(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return ruleFor(from, to) !== undefined;
}

/** A transition the table does not allow: a programming error, never an answer to the model. */
export class InvalidTransitionError extends ToolError {
  constructor(
    readonly from: ComplaintStatus,
    readonly to: ComplaintStatus,
  ) {
    super("INVALID", `transition ${from} → ${to} is not allowed`, "INVALID_TRANSITION");
  }
}

/** A precondition of the target state that the case does not meet yet. */
export class RequirementNotMetError extends ToolError {
  constructor(
    readonly requirement: Requirement,
    code: ErrorCode,
    message: string,
  ) {
    super(code, message, requirement);
  }
}

const REQUIREMENT_CODE: Readonly<Record<Requirement, ErrorCode>> = { FOUNDATION: "EVIDENCE_REQUIRED", ANSWER_SENT: "NOT_ELIGIBLE", AUTO_CLOSE_DUE: "NOT_ELIGIBLE" };

export interface TransitionRequest {
  readonly worldId: string;
  readonly complaintId: string;
  readonly to: ComplaintStatus;
  /** Short machine reason (`IDENTIFIED`, `RECEIPT_REQUESTED`, `HANDOFF_FRAUD`), stored in history and register. */
  readonly cause: string;
  readonly actor: Actor;
  /** Simulated instant of the event that causes it. */
  readonly atSim: string;
  /** The complaint as the caller read it; re-read (strongly consistent) when absent or on a retry. */
  readonly complaint?: Complaint;
  readonly patch?: ComplaintPatch;
  /** `STATUS` unless it is a withdrawal or a reclassification. */
  readonly eventType?: Extract<RegisterEventType, "STATUS" | "WITHDRAWN" | "RECLASSIFIED">;
  /** The Argentine holidays (loaded from `Reference` when a rule needs them and they are absent). */
  readonly holidays?: readonly string[];
  /** More operations that commit with the transition (built again on every retry). */
  readonly extra?: (complaint: Complaint) => Promise<readonly WriteOp[]> | readonly WriteOp[];
  /** Skips the origin table (only `withdraw`). */
  readonly origins?: readonly ComplaintStatus[];
}

export interface TransitionResult {
  readonly complaint: Complaint;
  readonly register: AppendChainedResult<"REG">;
}

async function readComplaint(deps: ComplaintsDeps, worldId: string, complaintId: string): Promise<Complaint> {
  const complaint = await deps.connector.complaints.get(worldId, complaintId, { consistent: true });
  if (!complaint) throw new ToolError("NOT_FOUND", "complaint not found");
  return complaint;
}

function isFoundedByOperator(complaint: Complaint, actor: Actor): boolean {
  return complaint.status === "HUMAN_REVIEW" && actor.startsWith("OPERATOR:");
}

async function checkRequirement(deps: ComplaintsDeps, request: TransitionRequest, complaint: Complaint, requirement: Requirement, holidays: () => Promise<readonly string[]>): Promise<void> {
  const fail = (message: string): never => {
    throw new RequirementNotMetError(requirement, REQUIREMENT_CODE[requirement], message);
  };
  if (requirement === "FOUNDATION") {
    if (isFoundedByOperator(complaint, request.actor)) return;
    const file = await deps.connector.caseItems.caseFile(request.worldId, request.complaintId);
    const acted = file.actions.some((action) => action.status === "EXECUTED" || action.status === "CONFLICT");
    const evidenced = file.evidence.some((evidence) => foundsResolution(complaint.type, evidence.kind));
    if (!acted && !evidenced) fail("RESOLVED needs an action or evidence that founds it");
    return;
  }
  const answer = complaint.answer;
  if (requirement === "ANSWER_SENT") {
    if (!answer?.messageId || (answer.deliveryProof !== "SENT" && answer.deliveryProof !== "DELIVERED")) fail("ANSWERED needs the written answer sent");
    return;
  }
  if (!answer?.sentAtSim) return fail("CLOSED needs a sent written answer");
  if (Date.parse(request.atSim) < Date.parse(autoCloseAt(answer.sentAtSim, await holidays()))) fail("CLOSED needs five business days since the answer");
}

function answerCount(complaint: Complaint): number {
  return complaint.statusHistory.filter((change) => change.to === "ANSWERED").length;
}

/** Timers that ride with the transition: cancel milestones, add or cancel `AUTO_CLOSE`. */
async function timerPlan(deps: ComplaintsDeps, request: TransitionRequest, complaint: Complaint, holidays: () => Promise<readonly string[]>): Promise<CancelPlan> {
  const { connector } = deps;
  const plans: CancelPlan[] = [];
  if (request.to === "ANSWERED" || request.eventType === "WITHDRAWN") {
    plans.push(await cancelMilestonesPlan(connector, request.worldId, request.complaintId, request.to === "ANSWERED" ? "ANSWERED" : "WITHDRAWN"));
  }
  if (complaint.status === "ANSWERED" && request.to !== "ANSWERED") {
    plans.push(await cancelTimersPlan(connector, request.worldId, request.complaintId, ["AUTO_CLOSE"], `LEFT_ANSWERED_${request.to}`));
  }
  const ops = plans.flatMap((plan) => plan.ops);
  if (request.to === "ANSWERED") {
    const answeredAtSim = complaint.answer?.sentAtSim ?? request.atSim;
    const timer = autoCloseTimer({ worldId: request.worldId, epoch: complaint.epoch, complaintId: request.complaintId, answeredAtSim, answerIndex: answerCount(complaint) + 1, holidays: await holidays() });
    ops.push(connector.timers.putOp(timer));
  }
  return { ops, scheduleNames: plans.flatMap((plan) => plan.scheduleNames), timerIds: plans.flatMap((plan) => plan.timerIds) };
}

/** Changes the status of a complaint with its register entry, atomically; retries a lost race. */
export async function transition(deps: ComplaintsDeps, request: TransitionRequest): Promise<TransitionResult> {
  let cachedHolidays: readonly string[] | undefined = request.holidays;
  const holidays = async (): Promise<readonly string[]> => (cachedHolidays ??= await loadHolidays(deps.connector));
  const first = request.complaint ?? (await readComplaint(deps, request.worldId, request.complaintId));
  const origins = request.origins ?? allowedFrom(request.to);
  if (!origins.includes(first.status)) {
    deps.log.error("complaints.invalid_transition", { metric: "INVALID_TRANSITION", worldId: request.worldId, fromStatus: first.status, toStatus: request.to, cause: request.cause });
    throw new InvalidTransitionError(first.status, request.to);
  }
  let latest = first;
  let cancelled: CancelPlan = { ops: [], scheduleNames: [], timerIds: [] };
  let created: { kind: string; timerId: string }[] = [];
  const register = await appendChained(deps, {
    chain: "REG",
    worldId: request.worldId,
    epoch: first.epoch,
    build: async ({ attempt }) => {
      latest = attempt === 0 ? first : await readComplaint(deps, request.worldId, request.complaintId);
      // The status moved on under us: not a programming error, a conflict the caller re-evaluates.
      if (!origins.includes(latest.status)) throw new ToolError("CONFLICT", `complaint is ${latest.status} now`, "STATUS_MOVED");
      const rule = request.origins ? undefined : ruleFor(latest.status, request.to);
      if (rule?.requires) await checkRequirement(deps, request, latest, rule.requires, holidays);
      cancelled = await timerPlan(deps, request, latest, holidays);
      created = request.to === "ANSWERED" ? [{ kind: "AUTO_CLOSE", timerId: `${request.complaintId}-AUTO_CLOSE-${answerCount(latest) + 1}` }] : [];
      const update = deps.connector.complaints.transitionOp({
        worldId: request.worldId,
        complaintId: request.complaintId,
        version: latest.version,
        allowedFrom: [latest.status],
        to: request.to,
        change: { from: latest.status, to: request.to, atSim: request.atSim, cause: request.cause, actor: request.actor },
        ...(request.patch ? { patch: request.patch } : {}),
      });
      return {
        entry: {
          eventType: request.eventType ?? "STATUS",
          atSim: request.atSim,
          complaintId: latest.complaintId,
          complaintNumber: latest.complaintNumber,
          kind: latest.kind,
          type: latest.type,
          channel: latest.channel,
          origin: latest.origin,
          status: request.to,
          reason: request.cause,
        },
        extra: [update, ...cancelled.ops, ...((await request.extra?.(latest)) ?? [])],
      };
    },
  });
  await afterCommit(deps, request.worldId, cancelled, created);
  return { complaint: await readComplaint(deps, request.worldId, request.complaintId), register };
}

async function afterCommit(deps: ComplaintsDeps, worldId: string, cancelled: CancelPlan, created: readonly { kind: string; timerId: string }[]): Promise<void> {
  if (!deps.milestones) return;
  try {
    if (cancelled.scheduleNames.length > 0) await deps.milestones.cancel(worldId, cancelled.scheduleNames);
    if (created.length > 0) await deps.milestones.schedule(worldId, created);
  } catch (error) {
    // The timers are already right in the table; the dispatcher discards a stale schedule (§10).
    deps.log.warn("complaints.schedule_sync_failed", { worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}

/** The customer withdraws: outcome `WITHDRAWN`, register entry `WITHDRAWN`, milestones cancelled, status `RESOLVED` (the confirmation answer follows). */
export function withdraw(deps: ComplaintsDeps, request: Omit<TransitionRequest, "to" | "eventType" | "origins" | "patch"> & { patch?: Omit<ComplaintPatch, "outcome"> }): Promise<TransitionResult> {
  return transition(deps, { ...request, to: "RESOLVED", eventType: "WITHDRAWN", origins: WITHDRAWABLE, patch: { ...request.patch, outcome: "WITHDRAWN" } });
}
