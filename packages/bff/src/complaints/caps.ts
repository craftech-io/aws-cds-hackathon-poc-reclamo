// Policy caps of money actions and the approvals above them (docs/design-brief.md §4, docs/architecture.md
// §8.5, ADR-0005). The code decides every tier: up to the agent cap of the action the agent acts; up
// to the operator cap an operator approves; above, a supervisor. Independently of the amount, the
// third automatic reversal or refund of the same customer in 30 simulated days needs an operator
// (`MONTHLY_AUTO_LIMIT`). An approval keeps the world epoch and expires two simulated business days
// after it was requested; it is executable only once, approved by a staff member, in its epoch and
// before it expires, and never for more than it approved or in another tier.
import { type CapAction, type CapTier, type StaffRole, ToolError } from "@reclamo/shared";
import type { Action, Approval } from "../domain/case-items";
import type { NewApproval } from "../connector/repos/case-items";
import type { CapLimits, WorldCaps } from "../domain/world";
import type { Connector } from "../connector/port";
import { nthBusinessDay } from "../services/business-days";
import { isoAr } from "./sla";

/** Actions counted by the monthly limit: reversals and refunds (not payment allocations). */
export const REVERSAL_ACTIONS: ReadonlySet<CapAction> = new Set<CapAction>(["REVERSE_CHARGE", "REFUND_DUPLICATE", "TRANSFER_REVERSAL"]);

/** Simulated days the monthly limit looks back. */
export const AUTO_LIMIT_WINDOW_DAYS = 30;

/** Business days an approval stays decidable and executable. */
export const APPROVAL_BUSINESS_DAYS = 2;

export type CapReason = "WITHIN_AGENT_CAP" | "AMOUNT_ABOVE_AGENT_CAP" | "MONTHLY_AUTO_LIMIT";

export interface CapDecision {
  readonly action: CapAction;
  readonly amountCents: number;
  readonly tier: CapTier;
  readonly reason: CapReason;
  readonly limits: CapLimits;
}

/** The tier the amount alone needs. */
export function tierForAmount(limits: CapLimits, amountCents: number): CapTier {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new ToolError("INVALID", "amount must be a non-negative integer of centavos");
  if (amountCents <= limits.agentCents) return "AGENT";
  if (amountCents <= limits.operatorCents) return "OPERATOR";
  return "SUPERVISOR";
}

/** `LAM-CAP`: who may execute this action of this amount for this customer now. */
export function evaluateCap(input: { action: CapAction; amountCents: number; caps: WorldCaps; automaticReversalsIn30Days: number }): CapDecision {
  const limits = input.caps.perAction[input.action];
  if (!limits) throw new ToolError("UNAVAILABLE", `no cap configured for ${input.action}`);
  const byAmount = tierForAmount(limits, input.amountCents);
  const overMonthly = REVERSAL_ACTIONS.has(input.action) && input.automaticReversalsIn30Days >= input.caps.autoActionsPer30Days;
  if (byAmount !== "AGENT") return { action: input.action, amountCents: input.amountCents, tier: byAmount, reason: "AMOUNT_ABOVE_AGENT_CAP", limits };
  if (overMonthly) return { action: input.action, amountCents: input.amountCents, tier: "OPERATOR", reason: "MONTHLY_AUTO_LIMIT", limits };
  return { action: input.action, amountCents: input.amountCents, tier: "AGENT", reason: "WITHIN_AGENT_CAP", limits };
}

function isAutomaticReversal(action: Action, sinceMs: number, untilMs: number): boolean {
  const at = Date.parse(action.atSim);
  return (
    REVERSAL_ACTIONS.has(action.kind as CapAction) &&
    action.status === "EXECUTED" &&
    action.actor === "AGENT" &&
    action.approvalId === undefined &&
    at > sinceMs &&
    at <= untilMs
  );
}

/** Reversals and refunds the agent executed on its own for this customer in the last 30 simulated days. */
export async function countAutomaticReversals(connector: Connector, input: { worldId: string; customerId: string; simNow: string }): Promise<number> {
  const untilMs = Date.parse(input.simNow);
  const sinceMs = untilMs - AUTO_LIMIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const complaints = await connector.complaints.listByCustomer(input.worldId, input.customerId);
  const actions = await Promise.all(complaints.map((complaint) => connector.caseItems.listActions(input.worldId, complaint.complaintId)));
  return actions.flat().filter((action) => isAutomaticReversal(action, sinceMs, untilMs)).length;
}

/** Two simulated business days after the request, at the same local time. */
export function approvalExpiresAt(requestedAtSim: string, holidays: Iterable<string>): string {
  const requested = new Date(requestedAtSim);
  return isoAr(nthBusinessDay(requested, APPROVAL_BUSINESS_DAYS, isoAr(requested).slice(11, 19), holidays));
}

/** A new `PENDING` approval for a cap decision above the agent (`request_operator_approval`). */
export function buildApproval(input: {
  worldId: string;
  complaintId: string;
  approvalId: string;
  evidenceId: string;
  justification: string;
  decision: CapDecision;
  epoch: number;
  requestedAtSim: string;
  holidays: Iterable<string>;
}): NewApproval {
  if (input.decision.tier === "AGENT") throw new ToolError("INVALID", "an action within the agent cap needs no approval");
  return {
    worldId: input.worldId,
    complaintId: input.complaintId,
    approvalId: input.approvalId,
    action: input.decision.action,
    amountCents: input.decision.amountCents,
    capTier: input.decision.tier,
    evidenceId: input.evidenceId,
    justification: input.justification.slice(0, 500),
    requestedBy: "AGENT",
    requestedAtSim: input.requestedAtSim,
    epoch: input.epoch,
    expiresAtSim: approvalExpiresAt(input.requestedAtSim, input.holidays),
  };
}

export type ApprovalBlock = "NOT_PENDING" | "NOT_APPROVED" | "NOT_DECIDED_BY_STAFF" | "OTHER_EPOCH" | "EXPIRED" | "ALREADY_EXECUTED" | "ROLE_BELOW_TIER";

export type ApprovalCheck = { readonly ok: true } | { readonly ok: false; readonly block: ApprovalBlock };

function expiredOrOtherEpoch(approval: Approval, epoch: number, simNow: string): ApprovalCheck | undefined {
  if (approval.epoch !== epoch) return { ok: false, block: "OTHER_EPOCH" };
  if (Date.parse(approval.expiresAtSim) <= Date.parse(simNow)) return { ok: false, block: "EXPIRED" };
  return undefined;
}

/** Roles that may decide each tier: an operator up to the operator cap, a supervisor any. */
export function roleMayDecide(role: StaffRole, tier: Exclude<CapTier, "AGENT">): boolean {
  if (role === "SUPERVISOR") return true;
  return role === "OPERATOR" && tier === "OPERATOR";
}

/** `decide_approval`: pending, same epoch, not expired, and a role of at least its tier. */
export function checkDecidable(approval: Approval, input: { epoch: number; simNow: string; role: StaffRole }): ApprovalCheck {
  if (approval.decision !== "PENDING") return { ok: false, block: "NOT_PENDING" };
  const stale = expiredOrOtherEpoch(approval, input.epoch, input.simNow);
  if (stale) return stale;
  return roleMayDecide(input.role, approval.capTier) ? { ok: true } : { ok: false, block: "ROLE_BELOW_TIER" };
}

/** Step 1 of `execute_approved_action` (§8.5): on the approval read strongly consistent. */
export function checkExecutable(approval: Approval, input: { epoch: number; simNow: string }): ApprovalCheck {
  if (approval.decision !== "APPROVED") return { ok: false, block: "NOT_APPROVED" };
  if (!approval.decidedBy) return { ok: false, block: "NOT_DECIDED_BY_STAFF" };
  if (approval.executedAt) return { ok: false, block: "ALREADY_EXECUTED" };
  return expiredOrOtherEpoch(approval, input.epoch, input.simNow) ?? { ok: true };
}

/** A pending approval past its expiry or of another epoch: it goes back to a person (`HUMAN_REVIEW`). */
export function isLapsed(approval: Approval, input: { epoch: number; simNow: string }): boolean {
  return approval.decision === "PENDING" && expiredOrOtherEpoch(approval, input.epoch, input.simNow) !== undefined;
}

/** Step 3 of §8.5: recomputed amount and tier; more than approved, or another tier, goes to a person. */
export function recheckApproved(approval: Approval, recomputed: CapDecision): { readonly ok: true } | { readonly ok: false; readonly reason: "AMOUNT_GREW" | "TIER_CHANGED" | "ACTION_CHANGED" } {
  if (recomputed.action !== approval.action) return { ok: false, reason: "ACTION_CHANGED" };
  if (recomputed.amountCents > approval.amountCents) return { ok: false, reason: "AMOUNT_GREW" };
  if (recomputed.tier !== approval.capTier) return { ok: false, reason: "TIER_CHANGED" };
  return { ok: true };
}
