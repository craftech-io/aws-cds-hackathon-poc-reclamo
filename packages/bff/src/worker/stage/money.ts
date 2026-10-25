// The money half of `execute_approved_action` in the stage (docs/architecture.md §8.5 steps 3 and 4):
// the plan of the `actions` target (agent-tools/actions/money-plan.ts) recomputes the amount from the
// approval's own evidence and the core at the moment of acting, and executes with the approval's
// idempotency key; the core's natural-key claim answers `CONFLICT` with the existing action to a second
// complaint over the same debit, charge or transfer. The executed action is recorded on the complaint
// (`ACT#`, with the approval's id and its decider as actor) and, for a reversal or a refund, the refund
// register entry (`RRI`) in the same transaction, once: a redelivery finds the row and writes nothing.
import { type CapAction, ToolError } from "@reclamo/shared";
import { planMoneyAction, MoneyRefusal, type MoneyEnv, type MoneyPlan } from "../../agent-tools/actions/money-plan";
import type { ComplaintsDeps } from "../../complaints/deps";
import { appendChained } from "../../complaints/register";
import type { NewOf } from "../../connector/codec";
import type { Connector } from "../../connector/port";
import type { CoreClient } from "../../core/client";
import type { Action, Approval } from "../../domain/case-items";
import type { Complaint } from "../../domain/complaint";
import type { RefundEntry } from "../../domain/ledger";
import type { NetworkClient } from "../../networks/client";
import type { ApprovedMoneyActions, MoneyExecution } from "../ports";

export interface StageMoneyDeps {
  readonly data: Connector;
  readonly core: () => CoreClient;
  readonly networks: () => NetworkClient;
  readonly complaints: () => ComplaintsDeps;
}

/** The refund register's cause of each reversal; `APPLY_PAYMENT` leaves no refund entry. */
const REFUND_CAUSES: Partial<Record<CapAction, RefundEntry["cause"]>> = { REVERSE_CHARGE: "REVERSE_CHARGE", REFUND_DUPLICATE: "REFUND_DUPLICATE", TRANSFER_REVERSAL: "TRANSFER_REVERSAL" };

async function planOf(deps: StageMoneyDeps, approval: Approval, complaint: Complaint, ctx: { readonly atSim: string; readonly correlationId: string }): Promise<MoneyPlan> {
  const [evidence, settings] = await Promise.all([deps.data.caseItems.getEvidence(approval.worldId, approval.complaintId, approval.evidenceId), deps.data.worlds.getSettings(approval.worldId)]);
  if (evidence === undefined) throw new ToolError("EVIDENCE_REQUIRED", "the approval's evidence is gone");
  if (settings === undefined) throw new ToolError("UNAVAILABLE", "the world has no settings yet");
  const env: MoneyEnv = {
    core: deps.core(),
    networks: deps.networks(),
    worldId: approval.worldId,
    customerId: complaint.customerId,
    complaintId: complaint.complaintId,
    simNow: ctx.atSim,
    correlationId: ctx.correlationId,
    referenceRate: settings.referenceRate,
  };
  return planMoneyAction(approval.action, evidence, env);
}

function approvedRow(approval: Approval, plan: MoneyPlan, executed: { readonly actionId: string; readonly status: Action["status"]; readonly amountCents?: number; readonly coreRef?: string; readonly atSim: string }, idempotencyKey: string): NewOf<typeof Action> {
  return {
    worldId: approval.worldId,
    complaintId: approval.complaintId,
    actionId: executed.actionId,
    kind: plan.action,
    status: executed.status,
    ...(executed.amountCents === undefined ? {} : { amountCents: executed.amountCents }),
    ...(executed.coreRef === undefined ? {} : { coreRef: executed.coreRef }),
    idempotencyKey,
    claimKey: plan.claimKey,
    evidenceId: plan.evidence.evidenceId,
    approvalId: approval.approvalId,
    atSim: executed.atSim,
    actor: `OPERATOR:${approval.decidedBy ?? "stf-unknown"}`,
  };
}

/** The approved money actions of the event workers: recompute with the core, execute once, record. */
export function stageApprovedMoney(deps: StageMoneyDeps): ApprovedMoneyActions {
  return {
    async quote(approval, complaint, ctx) {
      const plan = await planOf(deps, approval, complaint, ctx);
      return { action: plan.action, amountCents: plan.amountCents };
    },
    async execute(approval, complaint, ctx): Promise<MoneyExecution> {
      const plan = await planOf(deps, approval, complaint, ctx);
      let done;
      try {
        done = await plan.execute({ cap: approval.amountCents, idempotencyKey: ctx.idempotencyKey });
      } catch (error) {
        if (error instanceof MoneyRefusal && error.code === "CONFLICT") {
          const actionId = error.existingActionId ?? `act-${approval.approvalId}`;
          if ((await deps.data.caseItems.getAction(approval.worldId, approval.complaintId, actionId)) === undefined) {
            await deps.data.caseItems.putAction(approvedRow(approval, plan, { actionId, status: "CONFLICT", atSim: ctx.atSim, ...(error.existingActionId === undefined ? {} : { coreRef: error.existingActionId }) }, ctx.idempotencyKey));
          }
          return { status: "CONFLICT", actionId };
        }
        if (error instanceof ToolError) return { status: "FAILED", reason: error.code, retryable: error.code === "UNAVAILABLE" };
        throw error;
      }
      const row = approvedRow(approval, plan, { actionId: done.coreActionId, status: "EXECUTED", amountCents: done.amountCents, coreRef: done.creditNoteId ?? done.coreActionId, atSim: done.atSim }, ctx.idempotencyKey);
      if ((await deps.data.caseItems.getAction(approval.worldId, approval.complaintId, done.coreActionId)) !== undefined) return { status: "EXECUTED", actionId: done.coreActionId };
      const cause = REFUND_CAUSES[plan.action];
      if (cause === undefined) {
        await deps.data.caseItems.putAction(row);
        return { status: "EXECUTED", actionId: done.coreActionId };
      }
      await appendChained(deps.complaints(), {
        chain: "RRI",
        worldId: approval.worldId,
        epoch: complaint.epoch,
        build: () => ({
          entry: {
            atSim: done.atSim,
            customerId: complaint.customerId,
            complaintId: complaint.complaintId,
            complaintNumber: complaint.complaintNumber,
            actionId: done.coreActionId,
            cause,
            product: plan.product.slice(0, 60),
            amountCents: done.amountCents,
            interestCents: done.interestCents,
            ...(done.creditNoteId === undefined ? {} : { creditNoteId: done.creditNoteId }),
          },
          extra: [deps.data.caseItems.putActionOp(row)],
        }),
      });
      return { status: "EXECUTED", actionId: done.coreActionId };
    },
  };
}
