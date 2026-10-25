// `escalate_to_human` (docs/tool-catalog.md, FL-060, FL-061, FL-049): a person takes over. With a
// complaint, it goes to `HUMAN_REVIEW` with the reason and the operator's summary (masked) in the same
// transaction as its register entry, plus a human task in its case; without one, the conversation gets a
// human task. Then the code sends the fixed `HANDOFF_NOTICE` through the gate. `FRAUD` raises the
// priority to `HIGH`, sends the fixed safety guidance (with the freeze notice when the wallet was
// frozen for this complaint) and records the supervisor alert the console shows. A complaint already in
// `HUMAN_REVIEW` keeps its status; the notice is the same message (its id derives from the complaint and
// the reason, so the gate's send claim answers it once).
import { type HandoffReason, ToolError, ok } from "@reclamo/shared";
import { WHATSAPP_TEXT, fill } from "../../copy";
import { deadlineText } from "../../complaints/sla";
import { WORKING_STATUSES, transition } from "../../complaints/state-machine";
import { isConflict } from "../../connector/errors";
import { type Complaint, inboxStateOf } from "../../domain/complaint";
import { maskSensitive } from "../../lib/mask";
import { sha256Hex } from "../../lib/crypto";
import { type ToolContext, type ToolImplementation, actorOf } from "../common/context";
import type { ToolInput } from "../common/define";
import { sendSystem } from "../messaging/outbound";
import type { HandoffPorts } from "./ports";
import type { HANDOFF_TOOLS } from "./schema";

type EscalateInput = ToolInput<(typeof HANDOFF_TOOLS)["escalate_to_human"]>;

/** Statuses a complaint can be handed to a person from (the state machine's origins of `HUMAN_REVIEW`). */
const ESCALABLE: ReadonlySet<Complaint["status"]> = new Set([...WORKING_STATUSES, "RESOLVED", "ANSWERED"]);

/** The complaint the handoff is about: the one named, else the session's only open one, else none. */
async function complaintOf(ctx: ToolContext<EscalateInput>): Promise<Complaint | undefined> {
  const { worldId, customerId, complaintIds } = ctx.session;
  const named = ctx.findings.complaintIds[0];
  const ids = named === undefined ? complaintIds : [named];
  const loaded = await Promise.all(ids.map((id) => ctx.connector.complaints.get(worldId, id, { consistent: true })));
  const candidates = loaded.filter((complaint): complaint is Complaint => complaint !== undefined && complaint.customerId === customerId && (named !== undefined || inboxStateOf(complaint.status) === "OPEN"));
  if (named === undefined && candidates.length > 1) throw new ToolError("INVALID", `complaintId is required: this session has ${candidates.length} open complaints`, "AMBIGUOUS_COMPLAINT");
  return candidates[0];
}

function taskId(ctx: ToolContext<EscalateInput>, scope: string): string {
  return `task-${sha256Hex([ctx.session.worldId, scope, ctx.input.reason, ctx.session.triggerEventId].join("\u0000")).slice(0, 24)}`;
}

async function ignoreDuplicate(write: Promise<void>): Promise<void> {
  try {
    await write;
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

async function handOverComplaint(ctx: ToolContext<EscalateInput>, ports: HandoffPorts, complaint: Complaint, summary: string): Promise<Complaint> {
  const { worldId } = ctx.session;
  const reason: HandoffReason = ctx.input.reason;
  const atSim = ctx.session.eventAtSim;
  const priority = reason === "FRAUD" ? ({ priority: "HIGH" } as const) : {};
  const note = ctx.connector.caseItems.putNoteOp({
    worldId,
    complaintId: complaint.complaintId,
    noteId: taskId(ctx, complaint.complaintId),
    kind: "HUMAN_TASK",
    atSim,
    author: actorOf(ctx.principal),
    text: summary,
    task: { status: "OPEN", route: "HUMAN_QUEUE" },
  });
  if (complaint.status === "HUMAN_REVIEW") {
    await ignoreDuplicate(ctx.connector.write(note));
    if (reason === "FRAUD" && complaint.priority !== "HIGH") return ctx.connector.complaints.patch(worldId, complaint.complaintId, complaint.version, { priority: "HIGH" });
    return complaint;
  }
  if (!ESCALABLE.has(complaint.status)) throw new ToolError("NOT_ELIGIBLE", `a ${complaint.status} complaint cannot be handed over`, "NOT_ESCALABLE");
  const result = await transition(ports.complaints(ctx.log), {
    worldId,
    complaintId: complaint.complaintId,
    complaint,
    to: "HUMAN_REVIEW",
    cause: `HANDOFF_${reason}`,
    actor: actorOf(ctx.principal),
    atSim,
    patch: { handoff: { reason, atSim, summary }, ...priority },
    extra: () => [note],
  });
  return result.complaint;
}

async function hasFrozenWallet(ctx: ToolContext<EscalateInput>, complaint: Complaint): Promise<boolean> {
  const actions = await ctx.connector.caseItems.listActions(ctx.session.worldId, complaint.complaintId);
  return actions.some((action) => action.kind === "FREEZE_OUTGOING" && action.status === "EXECUTED");
}

export function escalateToHumanTool(ports: HandoffPorts): ToolImplementation<EscalateInput> {
  return async (ctx) => {
    const { input, session } = ctx;
    const summary = maskSensitive(input.summary);
    const complaint = await complaintOf(ctx);
    if (complaint === undefined) {
      await ignoreDuplicate(
        ctx.connector.write(
          ctx.connector.conversations.putTaskOp({
            worldId: session.worldId,
            customerId: session.customerId,
            taskId: taskId(ctx, "CONV"),
            atSim: session.eventAtSim,
            author: actorOf(ctx.principal),
            text: summary,
            task: { status: "OPEN", route: "HUMAN_QUEUE" },
          }),
        ),
      );
      const notice = await sendSystem(ports.gate, ctx, { kind: "HANDOFF_NOTICE", text: WHATSAPP_TEXT.HANDOFF_NOTICE_NO_COMPLAINT, refs: { reason: input.reason }, idParts: ["CONV", session.customerId, input.reason, session.triggerEventId] });
      await ctx.audit({ action: "ESCALATED", outcome: input.reason, refs: { scope: "CONVERSATION", ...(notice.messageId === undefined ? {} : { messageId: notice.messageId }) } });
      return ok({ status: "HUMAN_REVIEW", ...(notice.messageId === undefined ? {} : { handoffNoticeMessageId: notice.messageId }) });
    }

    const handed = await handOverComplaint(ctx, ports, complaint, summary);
    if (input.reason === "FRAUD") {
      const text = (await hasFrozenWallet(ctx, handed)) ? `${WHATSAPP_TEXT.SAFETY_GUIDANCE_FREEZE}\n\n${WHATSAPP_TEXT.SAFETY_GUIDANCE}` : WHATSAPP_TEXT.SAFETY_GUIDANCE;
      await sendSystem(ports.gate, ctx, { kind: "SAFETY_GUIDANCE", complaintId: handed.complaintId, text, idParts: [handed.complaintId, "SAFETY_GUIDANCE"] });
      await ctx.audit({ action: "SUPERVISOR_ALERT", outcome: "FRAUD", refs: { complaintId: handed.complaintId, complaintNumber: handed.complaintNumber }, detail: { priority: handed.priority } });
    }
    const notice = await sendSystem(ports.gate, ctx, {
      kind: "HANDOFF_NOTICE",
      complaintId: handed.complaintId,
      text: fill(WHATSAPP_TEXT.HANDOFF_NOTICE, { complaintNumber: handed.complaintNumber, deadlineText: deadlineText(handed.deadlineSim) }),
      refs: { complaintNumber: handed.complaintNumber, reason: input.reason },
      idParts: [handed.complaintId, "HANDOFF", input.reason],
    });
    await ctx.audit({
      action: "ESCALATED",
      outcome: input.reason,
      refs: { complaintId: handed.complaintId, ...(notice.messageId === undefined ? {} : { messageId: notice.messageId }) },
      detail: { from: complaint.status, priority: handed.priority },
    });
    return ok({ status: "HUMAN_REVIEW", ...(notice.messageId === undefined ? {} : { handoffNoticeMessageId: notice.messageId }) });
  };
}
