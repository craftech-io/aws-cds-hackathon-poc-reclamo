// `update_complaint` (docs/tool-catalog.md, FL-042): the agent moves a complaint of its session only
// along what the state machine allows it (complaints/state-machine.ts decides; `HUMAN_REVIEW`,
// `AWAITING_APPROVAL`, `ANSWERED` and `CLOSED` are not even in the enum), records the outcome of a
// resolution (checked against the case file, complaints/outcome.ts), records the customer's withdrawal,
// schedules a follow-up turn or leaves an internal note.
// `RESOLVED` needs an action or an evidence that founds it (`EVIDENCE_REQUIRED` otherwise). Asking for
// the status the complaint already has changes nothing.
//
// The follow-up is a `FOLLOW_UP` timer of the complaint (follow-up.ts).
import { ToolError, ok } from "@reclamo/shared";
import { checkOutcome } from "../../complaints/outcome";
import { transition, withdraw } from "../../complaints/state-machine";
import { isConflict } from "../../connector/errors";
import type { Complaint } from "../../domain/complaint";
import { maskSensitive } from "../../lib/mask";
import { sha256Hex } from "../../lib/crypto";
import { type ToolContext, type ToolImplementation, actorOf } from "../common/context";
import type { ToolInput } from "../common/define";
import { requiredComplaint } from "../actions/ports";
import { scheduleFollowUp } from "./follow-up";
import type { ComplaintPorts } from "./ports";
import type { COMPLAINTS_TOOLS } from "./schema";

type UpdateInput = ToolInput<(typeof COMPLAINTS_TOOLS)["update_complaint"]>;

async function changeStatus(ctx: ToolContext<UpdateInput>, ports: ComplaintPorts, complaint: Complaint): Promise<Complaint> {
  const { input } = ctx;
  const deps = ports.complaints(ctx.log);
  const base = { worldId: ctx.session.worldId, complaintId: complaint.complaintId, complaint, actor: actorOf(ctx.principal), atSim: ctx.session.eventAtSim };
  if (input.withdrawn === true) {
    if (input.outcome !== undefined && input.outcome !== "WITHDRAWN") throw new ToolError("INVALID", "a withdrawal has the outcome WITHDRAWN", "VALIDATION");
    if (input.status !== undefined && input.status !== "RESOLVED") throw new ToolError("INVALID", "a withdrawal resolves the complaint", "VALIDATION");
    if (complaint.outcome === "WITHDRAWN") return complaint;
    return (await withdraw(deps, { ...base, cause: "CUSTOMER_WITHDREW" })).complaint;
  }
  if (input.status === undefined) return complaint;
  if (input.status === complaint.status) return complaint;
  if (input.status === "RESOLVED" && input.outcome !== undefined) {
    const actions = await ctx.connector.caseItems.listActions(ctx.session.worldId, complaint.complaintId);
    checkOutcome(complaint.type, actions, input.outcome);
  }
  const patch = input.status === "RESOLVED" && input.outcome !== undefined ? { patch: { outcome: input.outcome } } : {};
  return (await transition(deps, { ...base, to: input.status, cause: `AGENT_${input.status}`, ...patch })).complaint;
}

export function updateComplaintTool(ports: ComplaintPorts): ToolImplementation<UpdateInput> {
  return async (ctx) => {
    const { input, session } = ctx;
    const before = requiredComplaint(ctx);
    const complaint = await changeStatus(ctx, ports, before);
    const followUpDueAtSim = input.followUpAtSim === undefined ? undefined : await scheduleFollowUp(ctx, complaint, input.followUpAtSim, ports.complaints(ctx.log).milestones);
    if (input.note !== undefined) {
      await ctx.connector.caseItems.putNote({
        worldId: session.worldId,
        complaintId: complaint.complaintId,
        noteId: `note-${sha256Hex([session.turnId, input.note].join("\u0000")).slice(0, 24)}`,
        kind: "NOTE",
        atSim: session.eventAtSim,
        author: actorOf(ctx.principal),
        text: maskSensitive(input.note),
      }).catch((error: unknown) => {
        if (!isConflict(error)) throw error;
      });
    }
    await ctx.audit({
      action: "UPDATE_COMPLAINT",
      outcome: complaint.status,
      refs: { complaintId: complaint.complaintId },
      detail: { from: before.status, to: complaint.status, withdrawn: input.withdrawn === true, note: input.note !== undefined, ...(followUpDueAtSim === undefined ? {} : { followUpDueAtSim }) },
    });
    return ok({ status: complaint.status, version: complaint.version, ...(followUpDueAtSim === undefined ? {} : { followUpAtSim: followUpDueAtSim }) });
  };
}
