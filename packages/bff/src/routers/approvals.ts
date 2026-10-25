// `approvals` router (docs/tool-catalog.md `decide_approval`, docs/architecture.md §8.5; FL-024, FL-034,
// FL-035, FL-036, FL-087). The agent never approves its own action: approving is this console's, with a
// sign-in of at most 15 minutes (**R**, routers/roles.ts) and the cap tier of the role (**T**): an
// operator up to the operator's cap, a supervisor (or a guest in their own world) above it.
//
//   list         pending approvals of the world, oldest first: amount, the cap it went over, evidence,
//                expiry, and whether this principal may decide it
//   decide (W R T)
//     APPROVED   the approval is decided once (`decision = PENDING` and its version) with its
//                `AuditLog ACTION APPROVED` in the same transaction; then `APPROVAL_DECIDED` is ENQUEUED
//                with ONLY the approval's locator: the worker re-reads it strongly consistent, claims
//                `EXEC#`, recomputes the amount and moves the money (`execute_approved_action`). The
//                console never executes anything. Asking again for an approval this person already
//                approved and nobody executed enqueues the same event again (same id: deduplicated).
//     REJECTED   with its reason: decided, audited and the complaint back to a person (`HUMAN_REVIEW`)
//                in one transaction with its register entry
//   A role below the tier → 403 and `AuditLog DENY CAP_TIER`; an expired approval, or one of another
//   epoch, cannot be decided.
import { z } from "zod";
import { type CapTier, Id, ToolError } from "@reclamo/shared";
import { checkDecidable, isLapsed, roleMayDecide } from "../complaints/caps";
import { deadlineText } from "../complaints/sla";
import { canTransition, transition } from "../complaints/state-machine";
import type { Approval } from "../domain/case-items";
import type { Complaint } from "../domain/complaint";
import type { CapLimits } from "../domain/world";
import { maskSensitive } from "../lib/mask";
import { pesosFromCents } from "../services/money";
import { type OperationsServices, WorldScoped, actorOfCtx, auditOp, checkWorld, complaintOf, enqueueAs, operationsOf, worldTime } from "./inbox";
import { accessProcedure, capTierOf } from "./roles";
import { type WorldContext, router } from "./trpc";

const APPROVAL_ACTIONS = { approved: "APPROVED", rejected: "REJECTED", deny: "DENY" } as const;

/** The tier a principal decides with; `undefined` for a role that decides nothing. */
function tierOf(ctx: WorldContext): Exclude<CapTier, "AGENT"> | undefined {
  return capTierOf(ctx.principal.role);
}

/** The cap the amount went over: the agent's for an `OPERATOR` approval, the operator's above it. */
function capExceeded(approval: Approval, limits: CapLimits | undefined) {
  if (limits === undefined) return null;
  const cents = approval.capTier === "OPERATOR" ? limits.agentCents : limits.operatorCents;
  return { tier: approval.capTier === "OPERATOR" ? ("AGENT" as const) : ("OPERATOR" as const), cap: pesosFromCents(cents) };
}

async function listView(ctx: WorldContext, services: OperationsServices) {
  const worldId = ctx.principal.worldId;
  const [pending, settings, { simNow }] = await Promise.all([services.data.caseItems.listPendingApprovals(worldId), services.data.worlds.getSettings(worldId), worldTime(ctx, services)]);
  const complaints = new Map<string, Complaint | undefined>();
  await Promise.all(
    [...new Set(pending.map((approval) => approval.complaintId))].map(async (complaintId) => {
      complaints.set(complaintId, await services.data.complaints.get(worldId, complaintId));
    }),
  );
  const tier = tierOf(ctx);
  const items = pending.map((approval) => {
    const complaint = complaints.get(approval.complaintId);
    const lapsed = isLapsed(approval, { epoch: ctx.world.epoch, simNow: simNow.toISOString() });
    return {
      approvalId: approval.approvalId,
      complaintId: approval.complaintId,
      complaintNumber: complaint?.complaintNumber ?? null,
      customerId: complaint?.customerId ?? null,
      action: approval.action,
      amount: pesosFromCents(approval.amountCents),
      capTier: approval.capTier,
      capExceeded: capExceeded(approval, settings?.caps.perAction[approval.action]),
      evidenceId: approval.evidenceId,
      justification: approval.justification,
      requestedBy: approval.requestedBy,
      requestedAtSim: approval.requestedAtSim,
      expiresAtSim: approval.expiresAtSim,
      expiresText: deadlineText(approval.expiresAtSim),
      lapsed,
      decidableByMe: !lapsed && tier !== undefined && roleMayDecide(tier, approval.capTier),
      version: approval.version,
    };
  });
  return { simNow: simNow.toISOString(), items };
}

const DecideInput = z
  .object({
    ...WorldScoped,
    complaintId: Id,
    approvalId: Id,
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((input) => input.decision === "APPROVED" || input.reason !== undefined, { message: "a rejection carries its reason", path: ["reason"] });
type DecideInput = z.infer<typeof DecideInput>;

/** `APPROVAL_DECIDED` of one approval: its id is fixed, so a repeated decision is deduplicated by the queue and the worker. */
function decidedEventId(approvalId: string): string {
  return `evt-apr-${approvalId}`;
}

async function enqueueDecided(ctx: WorldContext, services: OperationsServices, approval: Approval, complaint: Complaint, simNow: Date): Promise<string> {
  return enqueueAs(ctx, services, {
    type: "APPROVAL_DECIDED",
    eventId: decidedEventId(approval.approvalId),
    customerId: complaint.customerId,
    epoch: approval.epoch,
    eventAtSim: simNow.toISOString(),
    payload: { approvalId: approval.approvalId, complaintId: approval.complaintId },
  });
}

const REFUSAL: Readonly<Record<string, { code: "CONFLICT" | "NOT_ELIGIBLE"; message: string }>> = {
  NOT_PENDING: { code: "CONFLICT", message: "this approval was already decided" },
  EXPIRED: { code: "NOT_ELIGIBLE", message: "this approval expired: the case went back to a person" },
  OTHER_EPOCH: { code: "NOT_ELIGIBLE", message: "this approval belongs to an earlier state of the world" },
};

async function decide(ctx: WorldContext, services: OperationsServices, input: DecideInput) {
  const worldId = ctx.principal.worldId;
  const approval = await services.data.caseItems.getApproval(worldId, input.complaintId, input.approvalId);
  if (approval === undefined) throw new ToolError("NOT_FOUND", "no such approval in this world");
  const complaint = await complaintOf(ctx, services, approval.complaintId);
  const { simNow } = await worldTime(ctx, services);
  const refs = { complaintId: approval.complaintId, approvalId: approval.approvalId };

  // The person who approved asks again and nothing executed it yet: the event may have been lost.
  if (input.decision === "APPROVED" && approval.decision === "APPROVED" && approval.decidedBy === ctx.principal.staffId && approval.executedAt === undefined) {
    return { decision: "APPROVED" as const, replay: true, eventId: await enqueueDecided(ctx, services, approval, complaint, simNow) };
  }
  const tier = tierOf(ctx);
  const check = tier === undefined ? ({ ok: false, block: "ROLE_BELOW_TIER" } as const) : checkDecidable(approval, { epoch: ctx.world.epoch, simNow: simNow.toISOString(), role: tier });
  if (!check.ok) {
    if (check.block === "ROLE_BELOW_TIER") {
      await services.data.write(auditOp(ctx, services, { action: APPROVAL_ACTIONS.deny, outcome: "CAP_TIER", ruleIds: ["CAP"], atSim: simNow, refs: { ...refs, capTier: approval.capTier, role: ctx.principal.role } }));
      throw new ToolError("ABOVE_CAP", `this approval needs the ${approval.capTier} tier`, "CAP_TIER");
    }
    const refusal = REFUSAL[check.block] ?? { code: "CONFLICT" as const, message: "this approval cannot be decided" };
    throw new ToolError(refusal.code, refusal.message, check.block);
  }

  const decided = services.data.caseItems.decideApprovalOp({
    worldId,
    complaintId: approval.complaintId,
    approvalId: approval.approvalId,
    version: approval.version,
    decision: input.decision,
    decidedBy: ctx.principal.staffId,
    decidedAtSim: simNow.toISOString(),
    ...(input.reason === undefined ? {} : { reason: maskSensitive(input.reason) }),
  });
  const audited = auditOp(ctx, services, { action: input.decision === "APPROVED" ? APPROVAL_ACTIONS.approved : APPROVAL_ACTIONS.rejected, outcome: input.decision, ruleIds: ["CAP"], atSim: simNow, refs: { ...refs, capTier: approval.capTier } });

  if (input.decision === "APPROVED") {
    await services.data.transact([decided, audited]);
    return { decision: "APPROVED" as const, replay: false, eventId: await enqueueDecided(ctx, services, approval, complaint, simNow) };
  }
  if (!canTransition(complaint.status, "HUMAN_REVIEW")) {
    await services.data.transact([decided, audited]);
    return { decision: "REJECTED" as const, replay: false, status: complaint.status };
  }
  const atSim = simNow.toISOString();
  const moved = await transition(services.chains(), {
    worldId,
    complaintId: complaint.complaintId,
    to: "HUMAN_REVIEW",
    cause: "APPROVAL_REJECTED",
    actor: actorOfCtx(ctx),
    atSim,
    complaint,
    patch: { handoff: { reason: "OTHER", atSim, ...(input.reason === undefined ? {} : { summary: maskSensitive(input.reason) }) } },
    extra: () => [decided, audited],
  });
  return { decision: "REJECTED" as const, replay: false, status: moved.complaint.status };
}

export const approvalsRouter = router({
  list: accessProcedure("approvals.list").query(({ ctx }) => listView(ctx, operationsOf(ctx.deps))),

  decide: accessProcedure("approvals.decide")
    .input(DecideInput)
    .mutation(async ({ ctx, input, path }) => {
      await checkWorld(ctx, path, input);
      return decide(ctx, operationsOf(ctx.deps), input);
    }),
});
