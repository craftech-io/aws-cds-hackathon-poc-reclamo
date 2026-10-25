// The three account actions of the `actions` target (docs/tool-catalog.md): `freeze_outgoing`,
// `request_account_closure` and `request_data_change`. None moves money, so none has a cap; each acts
// once (the core replays the first answer to the same idempotency key) and leaves its `ACT#` row and
// its audit entry. Nothing here sends a message: `ToolActions` has no outbound pipeline; the worker
// sends the closure and data change confirmations after the turn (worker/confirmations.ts).
//
//   freeze_outgoing          only in an `UNKNOWN_OPERATION` complaint; no tool lifts it
//   request_account_closure  only with the nonce of the `CONFIRM_CLOSURE` button the customer tapped in
//                            this conversation (`LAM-EVIDENCE`): the one named, else the button of the
//                            turn's inbound message; the conditions come from the core
//   request_data_change      the new value is extracted by code from the customer's message (the turn's or
//                            an earlier one of the complaint, unless one is named; never a challenge
//                            answer: data-change-value.ts), never written by the model; one pending change
//                            per field and complaint (a second call replays it); a phone needs no message:
//                            it, or an account under review, is `REFERRED` and the complaint goes to a
//                            person (`RISKY_DATA_CHANGE`)
import type { ClosureCondition } from "@reclamo/core-contract";
import { ToolError, fail, ok } from "@reclamo/shared";
import { EMAIL_TEXT } from "../../copy";
import type { DataChangeField } from "../../copy/types";
import { transition } from "../../complaints/state-machine";
import type { Action } from "../../domain/case-items";
import type { Complaint } from "../../domain/complaint";
import type { NewOf } from "../../connector/codec";
import { sha256Hex } from "../../lib/crypto";
import { CoreError } from "../../core/errors";
import { type ToolContext, type ToolImplementation, actorOf } from "../common/context";
import { sourceMessageIdOf } from "../common/principal";
import type { ToolInput } from "../common/define";
import { deferredUntilText, failureWith } from "../messaging/outbound";
import { newValueOf } from "./data-change-value";
import { type ActionPorts, requiredComplaint } from "./ports";
import type { ACTIONS_TOOLS } from "./schema";

type Tools = typeof ACTIONS_TOOLS;

function coreCtx(ctx: ToolContext<unknown>) {
  return { worldId: ctx.session.worldId, simNow: ctx.session.eventAtSim, correlationId: ctx.correlationId };
}

/** `FREEZE:<hash>`: one key per complaint and action, so a retried call replays the core's first answer. */
function keyOf(kind: Action["kind"], ...parts: readonly string[]): string {
  return `${kind}:${sha256Hex(parts.join("\u0000")).slice(0, 40)}`;
}

async function recordAction(ctx: ToolContext<unknown>, complaint: Complaint, row: Omit<NewOf<typeof Action>, "worldId" | "complaintId" | "actor">): Promise<void> {
  if ((await ctx.connector.caseItems.getAction(ctx.session.worldId, complaint.complaintId, row.actionId)) !== undefined) return;
  await ctx.connector.caseItems.putAction({ ...row, worldId: ctx.session.worldId, complaintId: complaint.complaintId, actor: actorOf(ctx.principal) });
}

/** A core refusal that names an existing action (`CONFLICT`) is answered with it. */
function conflictWith(error: unknown) {
  if (!(error instanceof CoreError) || error.code !== "CONFLICT") return undefined;
  return { actionId: error.actionId, answer: failureWith(fail("CONFLICT", "this was already requested", "ALREADY_REQUESTED"), error.actionId === undefined ? {} : { actionId: error.actionId }) };
}

export function freezeOutgoing(ports: ActionPorts): ToolImplementation<ToolInput<Tools["freeze_outgoing"]>> {
  return async (ctx) => {
    const complaint = requiredComplaint(ctx);
    if (complaint.type !== "UNKNOWN_OPERATION") throw new ToolError("NOT_ELIGIBLE", "the wallet is frozen only in an UNKNOWN_OPERATION complaint", "NOT_UNKNOWN_OPERATION");
    const idempotencyKey = keyOf("FREEZE_OUTGOING", complaint.complaintId);
    const result = await ports.core().call("setOutgoingFreeze", coreCtx(ctx as ToolContext<unknown>), {
      params: { customerId: ctx.session.customerId },
      body: { active: true, reason: ctx.input.reason, by: ctx.principal.kind === "HARNESS" ? "AGENT" : "SYSTEM", complaintId: complaint.complaintId, idempotencyKey },
    });
    await recordAction(ctx as ToolContext<unknown>, complaint, { actionId: result.actionId, kind: "FREEZE_OUTGOING", status: "EXECUTED", coreRef: result.actionId, idempotencyKey, atSim: result.atSim });
    await ctx.audit({ action: "FREEZE_OUTGOING", outcome: result.changed ? "FROZEN" : "ALREADY_FROZEN", refs: { actionId: result.actionId }, detail: { reason: ctx.input.reason } });
    return ok({ actionId: result.actionId, frozenAtText: deferredUntilText(result.atSim) });
  };
}

/** How a closure condition reads, to the model and in the confirmation email: one fixed text of copy/ each. */
export const CLOSURE_CONDITION_TEXT: Readonly<Record<ClosureCondition["code"], string>> = {
  ACTIVE_LOAN: EMAIL_TEXT.CLOSURE_ACTIVE_LOAN,
  WALLET_BALANCE: EMAIL_TEXT.CLOSURE_WALLET_BALANCE,
  PENDING_TRANSFER: EMAIL_TEXT.CLOSURE_PENDING_TRANSFER,
};

function conditionText(condition: ClosureCondition): string {
  return CLOSURE_CONDITION_TEXT[condition.code];
}

/** The nonce of the button the customer tapped in the turn's inbound message (channels/whatsapp/inbound-message.ts stores it). */
async function tappedNonceOf(ctx: ToolContext<unknown>): Promise<string | undefined> {
  const { worldId, customerId, inboundMessageId } = ctx.session;
  if (inboundMessageId === undefined) return undefined;
  const message = await ctx.connector.conversations.findMessage(worldId, customerId, inboundMessageId);
  const interactive = message?.direction === "IN" ? message.interactive : undefined;
  const nonce = interactive?.["nonce"];
  return interactive?.["action"] === "CONFIRM_CLOSURE" && typeof nonce === "string" ? nonce : undefined;
}

export function requestAccountClosure(ports: ActionPorts): ToolImplementation<ToolInput<Tools["request_account_closure"]>> {
  return async (ctx) => {
    const complaint = requiredComplaint(ctx);
    const confirmNonce = ctx.input.confirmNonce ?? (await tappedNonceOf(ctx as ToolContext<unknown>));
    const nonce = confirmNonce === undefined ? undefined : await ctx.connector.claims.getNonce(ctx.session.worldId, confirmNonce);
    const tapped = nonce !== undefined && nonce.action === "CONFIRM_CLOSURE" && nonce.customerId === ctx.session.customerId && nonce.usedAtReal !== undefined;
    if (!tapped) {
      await ctx.audit({ action: "DENY", outcome: "CLOSURE_NOT_CONFIRMED", ruleIds: ["LAM-EVIDENCE"], refs: { deniedTool: "REQUEST_ACCOUNT_CLOSURE" } });
      throw new ToolError("EVIDENCE_REQUIRED", "the customer has not tapped the closure confirmation button", "CLOSURE_NOT_CONFIRMED");
    }
    const idempotencyKey = keyOf("ACCOUNT_CLOSURE", ctx.session.customerId, complaint.complaintId);
    let result;
    try {
      result = await ports.core().call("requestClosure", coreCtx(ctx as ToolContext<unknown>), { params: { customerId: ctx.session.customerId }, body: { complaintId: complaint.complaintId, idempotencyKey } });
    } catch (error) {
      const conflict = conflictWith(error);
      if (conflict === undefined) throw error;
      await ctx.audit({ action: "ACCOUNT_CLOSURE", outcome: "CONFLICT", refs: conflict.actionId === undefined ? {} : { actionId: conflict.actionId } });
      return conflict.answer;
    }
    const closureConditions = [...new Set(result.conditions.map((condition) => condition.code))];
    await recordAction(ctx as ToolContext<unknown>, complaint, { actionId: result.actionId, kind: "ACCOUNT_CLOSURE", status: "EXECUTED", coreRef: result.actionId, idempotencyKey, closureConditions, atSim: result.requestedAtSim });
    await ctx.audit({ action: "ACCOUNT_CLOSURE", outcome: "CLOSING", refs: { actionId: result.actionId }, detail: { conditions: result.conditions.map((condition) => condition.code) } });
    return ok({ actionId: result.actionId, accountStatusAfter: result.accountStatusAfter, conditionsText: result.conditions.map(conditionText) });
  };
}

/** A change of this field already waiting for the customer's confirmation in this complaint: replayed, never doubled. */
async function pendingChangeOf(ctx: ToolContext<unknown>, complaint: Complaint, field: DataChangeField): Promise<Action | undefined> {
  const actions = await ctx.connector.caseItems.listActions(ctx.session.worldId, complaint.complaintId);
  return actions.find((action) => action.kind === "DATA_CHANGE" && action.dataChangeField === field && action.status === "PENDING_CONFIRMATION");
}

export function requestDataChange(ports: ActionPorts): ToolImplementation<ToolInput<Tools["request_data_change"]>> {
  return async (ctx) => {
    const complaint = requiredComplaint(ctx);
    const { customerId } = ctx.session;
    const { field } = ctx.input;
    const pending = await pendingChangeOf(ctx as ToolContext<unknown>, complaint, field);
    if (pending !== undefined) {
      await ctx.audit({ action: "DATA_CHANGE", outcome: "ALREADY_PENDING", refs: { actionId: pending.actionId }, detail: { field } });
      return ok({ actionId: pending.actionId, status: pending.status, alreadyRequested: true });
    }
    const sourceMessageId = sourceMessageIdOf(ctx.session, ctx.input.sourceMessageId);
    if (field !== "PHONE" && sourceMessageId === undefined) throw new ToolError("INVALID", "this turn answers no message of the customer: the new value must be in the customer's message", "NO_SOURCE_MESSAGE");
    const found = field === "PHONE" || sourceMessageId === undefined ? undefined : await newValueOf(ctx as ToolContext<unknown>, complaint, field, { messageId: sourceMessageId, named: ctx.input.sourceMessageId !== undefined });
    const newValue = found?.value;
    // A phone is referred once per complaint, whatever message asked for it.
    const idempotencyKey = keyOf("DATA_CHANGE", complaint.complaintId, field, found?.messageId ?? "PHONE");
    let result;
    try {
      result = await ports.core().call("requestDataChange", coreCtx(ctx as ToolContext<unknown>), {
        params: { customerId },
        body: { complaintId: complaint.complaintId, idempotencyKey, field, ...(newValue === undefined ? {} : { newValue }) },
      });
    } catch (error) {
      const conflict = conflictWith(error);
      if (conflict === undefined) throw error;
      return conflict.answer;
    }
    await recordAction(ctx as ToolContext<unknown>, complaint, { actionId: result.actionId, kind: "DATA_CHANGE", status: result.status, coreRef: result.actionId, idempotencyKey, dataChangeField: result.field, atSim: ctx.session.eventAtSim });
    if (result.status === "REFERRED") await referToPerson(ctx as ToolContext<unknown>, ports, complaint);
    await ctx.audit({ action: "DATA_CHANGE", outcome: result.status, refs: { actionId: result.actionId }, detail: { field, valueExtracted: newValue !== undefined } });
    return ok({ actionId: result.actionId, status: result.status, ...(result.confirmationToMasked === undefined ? {} : { confirmationSentTo: result.confirmationToMasked }) });
  };
}

/** A risky change goes to a person by code: `HUMAN_REVIEW` with the reason, whatever the agent says next. */
async function referToPerson(ctx: ToolContext<unknown>, ports: ActionPorts, complaint: Complaint): Promise<void> {
  if (complaint.status === "HUMAN_REVIEW") return;
  await transition(ports.complaints(ctx.log), {
    worldId: ctx.session.worldId,
    complaintId: complaint.complaintId,
    complaint,
    to: "HUMAN_REVIEW",
    cause: "HANDOFF_RISKY_DATA_CHANGE",
    actor: actorOf(ctx.principal),
    atSim: ctx.session.eventAtSim,
    patch: { handoff: { reason: "RISKY_DATA_CHANGE", atSim: ctx.session.eventAtSim } },
  });
}
