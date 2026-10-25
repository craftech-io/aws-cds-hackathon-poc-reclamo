// `request_operator_approval` (docs/tool-catalog.md, FL-024, FL-034, FL-038, FL-088): after a money action
// answered `ABOVE_CAP`, a person is asked to approve it. The agent never approves: `decision` exists in
// the schema only for the Cedar forbid and zod refuses it with any value (`LAM-STRICT`), and no tool of
// any target approves. Here the code fixes everything the request says:
//
//   - only after an `ABOVE_CAP` of the same evidence (the marker the `actions` target left with the
//     action, the amount and the tier it computed from the core and the world's caps), else `NOT_ELIGIBLE`;
//   - the `Approval` is always `PENDING`, keeps the world's epoch and expires two simulated business days
//     later (complaints/caps.ts); a pending one for the same evidence is answered again, not duplicated;
//   - the complaint moves to `AWAITING_APPROVAL` in the same transaction that creates the approval;
//   - the customer reads the fixed update ("lo tiene que aprobar una persona"), counted as the one
//     `COMPLAINT_UPDATE` of the event that opened the turn.
//
// The execution happens later in the worker (`execute_approved_action`), which re-reads the approval and
// recomputes the amount with the core before moving any money.
import { z } from "zod";
import { CapAction, ToolError, ok, pesosFromCents } from "@reclamo/shared";
import { WHATSAPP_TEXT, fill } from "../../copy";
import { type CapDecision, buildApproval, isLapsed } from "../../complaints/caps";
import { loadHolidays } from "../../complaints/sla";
import { transition } from "../../complaints/state-machine";
import type { Approval } from "../../domain/case-items";
import type { Complaint } from "../../domain/complaint";
import { CapLimits } from "../../domain/world";
import type { NewApproval } from "../../connector/repos/case-items";
import { sha256Hex } from "../../lib/crypto";
import { maskSensitive } from "../../lib/mask";
import { type ToolContext, type ToolImplementation, actorOf } from "../common/context";
import type { ToolInput } from "../common/define";
import { oncePerEventSource } from "../common/fences";
import { ABOVE_CAP_MARKER, capActionOfEvidence, scopedEvidence } from "../actions/evidence";
import { requiredComplaint } from "../actions/ports";
import { sendSystem } from "../messaging/outbound";
import type { HandoffPorts } from "./ports";
import type { HANDOFF_TOOLS } from "./schema";

type ApprovalInput = ToolInput<(typeof HANDOFF_TOOLS)["request_operator_approval"]>;

/** What the `actions` target recorded when it refused above the cap (money.ts `markAboveCap`). */
const AboveCapMarker = z.looseObject({
  capAction: CapAction,
  capTier: z.enum(["OPERATOR", "SUPERVISOR"]),
  amountCents: z.number().int().positive(),
  reason: z.enum(["AMOUNT_ABOVE_AGENT_CAP", "MONTHLY_AUTO_LIMIT"]),
  limits: CapLimits,
});
type AboveCapMarker = z.infer<typeof AboveCapMarker>;

/** The cap decision the marker records, as `buildApproval` takes it. */
function decisionOf(marker: AboveCapMarker): CapDecision {
  return { action: marker.capAction, amountCents: marker.amountCents, tier: marker.capTier, reason: marker.reason, limits: marker.limits };
}

/** Statuses that reach `AWAITING_APPROVAL` through `INVESTIGATING` first. */
const BEFORE_INVESTIGATING: ReadonlySet<Complaint["status"]> = new Set(["REGISTERED", "AWAITING_CUSTOMER", "AWAITING_SETTLEMENT", "AWAITING_NETWORK"]);

function approvalIdOf(complaintId: string, evidenceId: string, attempt: number): string {
  return `apr-${sha256Hex([complaintId, evidenceId, String(attempt)].join("\u0000")).slice(0, 24)}`;
}

function answerOf(approval: Pick<Approval, "approvalId" | "capTier" | "amountCents">) {
  return ok({ approvalId: approval.approvalId, capTier: approval.capTier, amount: pesosFromCents(approval.amountCents), status: "PENDING" });
}

/** Moves the complaint to `AWAITING_APPROVAL`, the approval riding in the last transition. */
async function awaitApproval(ctx: ToolContext<ApprovalInput>, ports: HandoffPorts, complaint: Complaint, approval: NewApproval): Promise<void> {
  const deps = ports.complaints(ctx.log);
  const base = { worldId: ctx.session.worldId, complaintId: complaint.complaintId, actor: actorOf(ctx.principal), atSim: ctx.session.eventAtSim };
  let current = complaint;
  if (BEFORE_INVESTIGATING.has(current.status)) current = (await transition(deps, { ...base, complaint: current, to: "INVESTIGATING", cause: "APPROVAL_REQUESTED" })).complaint;
  const create = ctx.connector.caseItems.createApprovalOp(approval);
  if (current.status === "AWAITING_APPROVAL") {
    await ctx.connector.write(create);
    return;
  }
  await transition(deps, { ...base, complaint: current, to: "AWAITING_APPROVAL", cause: "APPROVAL_REQUESTED", extra: () => [create] });
}

/** The fixed update, unless a `COMPLAINT_UPDATE` already went out for this event (`LAM-ONCE-PER-EVENT`). */
async function notifyCustomer(ctx: ToolContext<ApprovalInput>, ports: HandoffPorts, complaint: Complaint, approvalId: string): Promise<string | undefined> {
  const claim = await ctx.connector.claims.claimOnce(ctx.session.worldId, oncePerEventSource("COMPLAINT_UPDATE"), ctx.session.triggerEventId, { turnId: ctx.session.turnId, approvalId });
  if (!claim.first) return undefined;
  const sent = await sendSystem(ports.gate, ctx, {
    kind: "COMPLAINT_UPDATE",
    complaintId: complaint.complaintId,
    text: fill(WHATSAPP_TEXT.APPROVAL_PENDING, { complaintNumber: complaint.complaintNumber }),
    refs: { complaintNumber: complaint.complaintNumber, approvalId },
    idParts: [complaint.complaintId, approvalId],
  });
  return sent.messageId;
}

export function requestOperatorApprovalTool(ports: HandoffPorts): ToolImplementation<ApprovalInput> {
  return async (ctx) => {
    const { input, session } = ctx;
    const complaint = requiredComplaint(ctx);
    const evidence = scopedEvidence(ctx.findings, input.evidenceId);
    if (evidence.complaintId !== complaint.complaintId) throw new ToolError("EVIDENCE_REQUIRED", "the evidence belongs to another complaint of this session", "EVIDENCE_OTHER_COMPLAINT");
    const capAction = capActionOfEvidence(evidence);
    if (capAction === undefined) throw new ToolError("EVIDENCE_REQUIRED", "this evidence founds no money action", "EVIDENCE_KIND");
    const marker = AboveCapMarker.safeParse((await ctx.connector.claims.getIdempotency(session.worldId, ABOVE_CAP_MARKER, evidence.evidenceId))?.result);
    if (!marker.success || marker.data.capAction !== capAction) {
      await ctx.audit({ action: "DENY", outcome: "NO_ABOVE_CAP", refs: { deniedTool: "REQUEST_OPERATOR_APPROVAL", evidenceId: evidence.evidenceId } });
      throw new ToolError("NOT_ELIGIBLE", "an approval is asked only after the action answered ABOVE_CAP for this evidence", "NO_ABOVE_CAP");
    }

    const earlier = (await ctx.connector.caseItems.caseFile(session.worldId, complaint.complaintId)).approvals.filter((approval) => approval.evidenceId === evidence.evidenceId);
    const pending = earlier.find((approval) => approval.decision === "PENDING" && !isLapsed(approval, { epoch: complaint.epoch, simNow: session.eventAtSim }));
    if (pending !== undefined) return answerOf(pending);
    if (earlier.some((approval) => approval.decision === "APPROVED")) throw new ToolError("CONFLICT", "this action was already approved", "ALREADY_APPROVED");

    const approval = buildApproval({
      worldId: session.worldId,
      complaintId: complaint.complaintId,
      approvalId: approvalIdOf(complaint.complaintId, evidence.evidenceId, earlier.length + 1),
      evidenceId: evidence.evidenceId,
      justification: maskSensitive(input.justification),
      decision: decisionOf(marker.data),
      epoch: complaint.epoch,
      requestedAtSim: session.eventAtSim,
      holidays: await loadHolidays(ctx.connector),
    });
    await awaitApproval(ctx, ports, complaint, approval);
    const messageId = await notifyCustomer(ctx, ports, complaint, approval.approvalId);
    await ctx.audit({
      action: "APPROVAL_REQUESTED",
      outcome: "PENDING",
      refs: { approvalId: approval.approvalId, evidenceId: evidence.evidenceId, capAction: approval.action, capTier: approval.capTier, ...(messageId === undefined ? {} : { messageId }) },
      detail: { amountCents: approval.amountCents, expiresAtSim: approval.expiresAtSim },
    });
    return answerOf(approval);
  };
}
