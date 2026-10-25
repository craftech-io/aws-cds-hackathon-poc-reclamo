// The four money tools of the `actions` target (docs/tool-catalog.md): `apply_payment`,
// `reverse_charge`, `refund_duplicate_debit`, `request_transfer_reversal`. The wrapper already proved the
// session, the identification, the open complaint, the agent's control of the conversation and that the
// evidence id is one of this complaint (`LAM-SCOPE`). Here, in order:
//
//   1. `LAM-EVIDENCE`: the evidence is of the kind the action needs and says what founds it;
//   2. the amount comes from the evidence and the core (money-plan.ts), never from the model; money the
//      core already moved before this complaint (a charge already reversed) answers `ALREADY_REVERSED`
//      before the cap, so no approval is ever asked for it;
//   3. `LAM-CAP`: the world's cap and the monthly automatic limit decide the tier; above the agent's,
//      the tool answers `ABOVE_CAP` with `{capAction, capTier, amount}`, leaves the marker the approval
//      request needs and moves nothing;
//   4. the core moves the money once per natural key: a second attempt (another complaint, a retried
//      approval) answers `CONFLICT` with the existing `actionId`, recorded on this complaint too;
//   5. the action is recorded (`ACT#`) and, for a reversal or a refund, the refund register entry
//      (`RRI`) in the same transaction; then the audit entry.
import { type CapAction, ToolError, fail, ok, pesosFromCents } from "@reclamo/shared";
import { type CapDecision, countAutomaticReversals, evaluateCap } from "../../complaints/caps";
import type { Complaint } from "../../domain/complaint";
import type { Action } from "../../domain/case-items";
import type { RefundEntry } from "../../domain/ledger";
import { appendChained } from "../../complaints/register";
import { sha256Hex } from "../../lib/crypto";
import type { NewOf } from "../../connector/codec";
import { type ToolContext, type ToolImplementation, type ToolResponse, actorOf } from "../common/context";
import { failureWith } from "../messaging/outbound";
import { ABOVE_CAP_MARKER, scopedEvidence } from "./evidence";
import { type AlreadyDone, type MoneyEnv, type MoneyExecution, type MoneyPlan, MoneyRefusal, planMoneyAction } from "./money-plan";
import { type ActionPorts, requiredComplaint, settingsOf } from "./ports";

const REFUND_CAUSE: Partial<Record<CapAction, RefundEntry["cause"]>> = {
  REVERSE_CHARGE: "REVERSE_CHARGE",
  REFUND_DUPLICATE: "REFUND_DUPLICATE",
  TRANSFER_REVERSAL: "TRANSFER_REVERSAL",
};

/** What the money tools and the approval request need to plan an action of the complaint. */
export async function moneyEnvOf(ctx: ToolContext<unknown>, ports: Pick<ActionPorts, "core" | "networks">, complaint: Complaint): Promise<{ env: MoneyEnv; settings: Awaited<ReturnType<typeof settingsOf>> }> {
  const settings = await settingsOf(ctx);
  const env: MoneyEnv = {
    core: ports.core(),
    networks: ports.networks(),
    worldId: ctx.session.worldId,
    customerId: ctx.session.customerId,
    complaintId: complaint.complaintId,
    simNow: ctx.session.eventAtSim,
    correlationId: ctx.correlationId,
    referenceRate: settings.referenceRate,
  };
  return { env, settings };
}

/** `LAM-CAP` for a plan: the world's caps and the customer's automatic reversals in 30 simulated days. */
export async function capDecisionOf(ctx: Pick<ToolContext<unknown>, "connector" | "session">, plan: MoneyPlan, settings: Awaited<ReturnType<typeof settingsOf>>): Promise<CapDecision> {
  const automaticReversalsIn30Days = await countAutomaticReversals(ctx.connector, { worldId: ctx.session.worldId, customerId: ctx.session.customerId, simNow: ctx.session.eventAtSim });
  return evaluateCap({ action: plan.action, amountCents: plan.amountCents, caps: settings.caps, automaticReversalsIn30Days });
}

/** The answer above the cap: nothing moved; the agent may only ask for an approval. */
function aboveCapAnswer(decision: Pick<CapDecision, "action" | "tier" | "amountCents" | "reason">): ToolResponse {
  return failureWith(fail("ABOVE_CAP", `above the agent's cap: ask for an approval of ${decision.tier} with request_operator_approval`, decision.reason), {
    capAction: decision.action,
    capTier: decision.tier,
    amount: pesosFromCents(decision.amountCents),
  });
}

async function markAboveCap(ctx: ToolContext<unknown>, plan: MoneyPlan, decision: Pick<CapDecision, "tier" | "amountCents" | "reason" | "limits">): Promise<void> {
  await ctx.connector.claims.claimOnce(ctx.session.worldId, ABOVE_CAP_MARKER, plan.evidence.evidenceId, {
    capAction: plan.action,
    capTier: decision.tier,
    amountCents: decision.amountCents,
    reason: decision.reason,
    limits: { agentCents: decision.limits.agentCents, operatorCents: decision.limits.operatorCents },
    turnId: ctx.session.turnId,
  });
  await ctx.audit({ action: "ABOVE_CAP", outcome: decision.reason, ruleIds: ["LAM-CAP"], refs: { evidenceId: plan.evidence.evidenceId, capAction: plan.action, capTier: decision.tier }, detail: { amountCents: decision.amountCents } });
}

/** Same complaint, same action, same evidence → same key: a retried call replays the core's first answer. */
function idempotencyKeyOf(complaintId: string, plan: MoneyPlan): string {
  return `${plan.action}:${sha256Hex([complaintId, plan.action, plan.evidence.evidenceId].join("\u0000")).slice(0, 40)}`;
}

function actionRow(ctx: ToolContext<unknown>, complaint: Complaint, plan: MoneyPlan, fields: Pick<NewOf<typeof Action>, "actionId" | "status" | "idempotencyKey" | "atSim"> & { amountCents?: number; coreRef?: string }): NewOf<typeof Action> {
  return {
    worldId: ctx.session.worldId,
    complaintId: complaint.complaintId,
    kind: plan.action,
    claimKey: plan.claimKey,
    evidenceId: plan.evidence.evidenceId,
    actor: actorOf(ctx.principal),
    ...fields,
  };
}

/** `ACT#` (and the refund register entry with it) once: a replayed answer finds the row and writes nothing. */
async function recordExecuted(ctx: ToolContext<unknown>, ports: ActionPorts, complaint: Complaint, plan: MoneyPlan, executed: MoneyExecution, idempotencyKey: string): Promise<void> {
  const { worldId } = ctx.session;
  if ((await ctx.connector.caseItems.getAction(worldId, complaint.complaintId, executed.coreActionId)) !== undefined) return;
  const row = actionRow(ctx, complaint, plan, {
    actionId: executed.coreActionId,
    status: "EXECUTED",
    amountCents: executed.amountCents,
    coreRef: executed.creditNoteId ?? executed.coreActionId,
    idempotencyKey,
    atSim: executed.atSim,
  });
  const cause = REFUND_CAUSE[plan.action];
  if (cause === undefined) {
    await ctx.connector.caseItems.putAction(row);
    return;
  }
  await appendChained(ports.complaints(ctx.log), {
    chain: "RRI",
    worldId,
    epoch: complaint.epoch,
    build: () => ({
      entry: {
        atSim: executed.atSim,
        customerId: ctx.session.customerId,
        complaintId: complaint.complaintId,
        complaintNumber: complaint.complaintNumber,
        actionId: executed.coreActionId,
        cause,
        product: plan.product.slice(0, 60),
        amountCents: executed.amountCents,
        interestCents: executed.interestCents,
        ...(executed.creditNoteId === undefined ? {} : { creditNoteId: executed.creditNoteId }),
      },
      extra: [ctx.connector.caseItems.putActionOp(row)],
    }),
  });
}

/** `CONFLICT`: the money already moved under another action; this complaint records it and gets its id. */
async function recordConflict(ctx: ToolContext<unknown>, complaint: Complaint, plan: MoneyPlan, refusal: MoneyRefusal, idempotencyKey: string): Promise<ToolResponse> {
  const existing = refusal.existingActionId;
  const actionId = existing ?? `act-${sha256Hex(idempotencyKey).slice(0, 24)}`;
  if ((await ctx.connector.caseItems.getAction(ctx.session.worldId, complaint.complaintId, actionId)) === undefined) {
    await ctx.connector.caseItems.putAction(actionRow(ctx, complaint, plan, { actionId, status: "CONFLICT", ...(existing === undefined ? {} : { coreRef: existing }), idempotencyKey, atSim: ctx.session.eventAtSim }));
  }
  await ctx.audit({ action: plan.action, outcome: "CONFLICT", refs: { evidenceId: plan.evidence.evidenceId, claimKey: plan.claimKey, ...(existing === undefined ? {} : { actionId: existing }) } });
  return failureWith(fail("CONFLICT", "this was already done: the money moved once, under the existing action", "ALREADY_EXECUTED"), existing === undefined ? {} : { actionId: existing });
}

/** The money already moved before this complaint (a charge reversed earlier): nothing to do, nothing to approve. */
async function alreadyDoneAnswer(ctx: ToolContext<unknown>, plan: MoneyPlan, done: AlreadyDone): Promise<ToolResponse> {
  await ctx.audit({ action: plan.action, outcome: done.reason, refs: { evidenceId: plan.evidence.evidenceId, claimKey: plan.claimKey, actionId: done.coreActionId } });
  return failureWith(fail("CONFLICT", "this was already returned to the customer: tell them when and with which credit note; never reverse it or ask an approval for it again", done.reason), done.output);
}

/** Steps 1 to 5 for one money action founded on the evidence the input names. */
export async function runMoneyAction(ctx: ToolContext<unknown>, ports: ActionPorts, action: CapAction, evidenceRef: string): Promise<ToolResponse> {
  const complaint = requiredComplaint(ctx);
  const evidence = scopedEvidence(ctx.findings, evidenceRef);
  if (evidence.complaintId !== complaint.complaintId) throw new ToolError("EVIDENCE_REQUIRED", "the evidence belongs to another complaint of this session", "EVIDENCE_OTHER_COMPLAINT");
  const { env, settings } = await moneyEnvOf(ctx, ports, complaint);
  const plan = await planMoneyAction(action, evidence, env);
  if (plan.alreadyDone !== undefined) return alreadyDoneAnswer(ctx, plan, plan.alreadyDone);
  const decision = await capDecisionOf(ctx, plan, settings);
  if (decision.tier !== "AGENT") {
    await markAboveCap(ctx, plan, decision);
    return aboveCapAnswer(decision);
  }
  const idempotencyKey = idempotencyKeyOf(complaint.complaintId, plan);
  let executed: MoneyExecution;
  try {
    executed = await plan.execute({ cap: decision.limits.agentCents, idempotencyKey });
  } catch (error) {
    if (error instanceof MoneyRefusal && error.code === "CONFLICT") return recordConflict(ctx, complaint, plan, error, idempotencyKey);
    if (error instanceof MoneyRefusal && error.code === "ABOVE_CAP") {
      // The core recomputed more than the evidence said: the operator decides, never the agent.
      const raised = { ...decision, tier: "OPERATOR" as const, reason: "AMOUNT_ABOVE_AGENT_CAP" as const };
      await markAboveCap(ctx, plan, raised);
      return aboveCapAnswer(raised);
    }
    throw error;
  }
  await recordExecuted(ctx, ports, complaint, plan, executed, idempotencyKey);
  await ctx.audit({
    action: plan.action,
    outcome: "EXECUTED",
    ruleIds: ["LAM-EVIDENCE", "LAM-CAP"],
    refs: { actionId: executed.coreActionId, evidenceId: evidence.evidenceId, claimKey: plan.claimKey },
    detail: { amountCents: executed.amountCents, interestCents: executed.interestCents, capTier: decision.tier },
  });
  return ok({ ...executed.output });
}

type MoneyInput<K extends string> = { readonly [P in K]: string };

function moneyTool<K extends string>(ports: ActionPorts, action: CapAction, field: K): ToolImplementation<MoneyInput<K>> {
  return (ctx) => runMoneyAction(ctx as ToolContext<unknown>, ports, action, ctx.input[field]);
}

export function moneyImplementations(ports: ActionPorts) {
  return {
    apply_payment: moneyTool(ports, "APPLY_PAYMENT", "reconciliationId"),
    reverse_charge: moneyTool(ports, "REVERSE_CHARGE", "chargeCheckId"),
    refund_duplicate_debit: moneyTool(ports, "REFUND_DUPLICATE", "duplicateCheckId"),
    request_transfer_reversal: moneyTool(ports, "TRANSFER_REVERSAL", "transferEvidenceId"),
  };
}
