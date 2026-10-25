// Money actions of a complaint as the scenarios check them (docs/test-plan.md §4.3 "Acciones"): the agent
// never approves; above its cap it asks a person (`request_operator_approval`, `AWAITING_APPROVAL`), the
// console decides with a recent sign-in, and the worker executes the approved action once, re-reading
// the approval. Every money action took its claim by natural key in the core (`OPC#`, `REV#`, `RFD#`, `TRV#`).
import type { ComplaintStatus, StaffRole } from "@reclamo/shared";
import { type CaseView, caseOf, consoleAttempt, consoleCall } from "./console";
import { WAITS } from "./eventually";
import { type Persona, progressOf, untilStatus } from "./flows";
import { type ScenarioContext, ensure } from "./steps";

export type MoneyAction = "APPLY_PAYMENT" | "REVERSE_CHARGE" | "REFUND_DUPLICATE" | "TRANSFER_REVERSAL";

const CLAIM_PREFIX: Readonly<Record<MoneyAction, string>> = { APPLY_PAYMENT: "OPC#", REVERSE_CHARGE: "REV#", REFUND_DUPLICATE: "RFD#", TRANSFER_REVERSAL: "TRV#" };

export const executed = (view: CaseView, kind: MoneyAction) => view.actions.filter((action) => action.kind === kind && action.status === "EXECUTED");

/** Every executed money action of the case carries the claim of its kind. */
export function expectClaims(ctx: ScenarioContext, view: CaseView, kind: MoneyAction): void {
  for (const action of executed(view, kind)) ctx.check(action.claimKey?.startsWith(CLAIM_PREFIX[kind]) === true, `${kind} ${action.actionId} has no ${CLAIM_PREFIX[kind]} claim`);
}

/** The details of the latest evidence of `kind`. */
export function latestDetails(view: CaseView, kind: string): Readonly<Record<string, unknown>> | undefined {
  return view.evidence.filter((item) => item.kind === kind).at(-1)?.details as Readonly<Record<string, unknown>> | undefined;
}

export interface ApprovalExpectation {
  readonly action: MoneyAction;
  readonly tier: "OPERATOR" | "SUPERVISOR";
  readonly amountCents?: number;
}

/** `ABOVE_CAP` → `request_operator_approval` with the evidence: the case waits for a person. */
export async function expectApprovalRequested(ctx: ScenarioContext, persona: Persona, complaintId: string, expected: ApprovalExpectation) {
  await untilStatus(ctx, persona, complaintId, ["AWAITING_APPROVAL"], { progress: progressOf(ctx, persona.key), timeoutSec: WAITS.turnSec * 2 });
  const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, complaintId));
  const [approval] = ctx.exactly(view, 1, "pending approvals", view.approvals.filter((item) => item.decision === "PENDING"));
  ensure(approval !== undefined, "no pending approval");
  ctx.check(approval.action === expected.action && approval.capTier === expected.tier, `approval ${approval.action} ${approval.capTier}, expected ${expected.action} ${expected.tier}`);
  if (expected.amountCents !== undefined) ctx.check(approval.amountCents === expected.amountCents, `approval of ${approval.amountCents} cents, expected ${expected.amountCents}`);
  ctx.none(view, `${expected.action} executed before the decision`, executed(view, expected.action));
  ctx.note("approvalId", approval.approvalId);
  return approval;
}

/** A person decides in the console, with a recent sign-in. */
export async function decide(ctx: ScenarioContext, persona: Persona, complaintId: string, approvalId: string, decision: "APPROVED" | "REJECTED", role: StaffRole = "OPERATOR", reason?: string) {
  return consoleCall(ctx, "approvals", "decide", { complaintId, approvalId, decision, ...(reason === undefined ? {} : { reason }) }, { worldId: persona.worldId, role, signedInSecAgo: 0 });
}

/** The same decision refused (`FORBIDDEN CAP_TIER` for an OPERATOR above their tier). */
export async function decisionRefused(ctx: ScenarioContext, persona: Persona, complaintId: string, approvalId: string, role: StaffRole): Promise<string> {
  const answer = await consoleAttempt(ctx, "approvals", "decide", { complaintId, approvalId, decision: "APPROVED" }, { worldId: persona.worldId, role, signedInSecAgo: 0 });
  ctx.check(!answer.ok, `${role} could decide an approval above its tier`);
  return answer.ok ? "OK" : `${answer.error.code}${answer.error.reason ? ` ${answer.error.reason}` : ""}`;
}

/** After an approval, the worker executes the action exactly once, the approved one, and the complaint moves on. */
export async function expectExecutedOnce(ctx: ScenarioContext, persona: Persona, complaintId: string, approvalId: string, kind: MoneyAction, statuses: readonly ComplaintStatus[] = ["RESOLVED", "ANSWERED", "CLOSED"]): Promise<CaseView> {
  await untilStatus(ctx, persona, complaintId, statuses, { progress: progressOf(ctx, persona.key), timeoutSec: WAITS.turnSec * 2 });
  const view = await ctx.quietRead(persona.worldId, () => caseOf(ctx, persona.worldId, complaintId));
  const [action] = ctx.exactly(view, 1, `${kind} executed`, executed(view, kind));
  ctx.check(action?.approvalId === approvalId, `the executed ${kind} is not the approved one`);
  ctx.check(view.approvals.find((item) => item.approvalId === approvalId)?.executedAt !== undefined, "the approval has no execution");
  expectClaims(ctx, view, kind);
  return view;
}
