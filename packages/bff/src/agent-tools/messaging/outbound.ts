// How the tools of the four effect targets talk to the outbound gate (outbound/gate.ts, ADR-0006): the
// gate is a port (`OutboundGate`), the deployed entries pass the imported `sendThroughGate` and the tests
// a fake. The recipient is never part of a request built here: the gate resolves it from the customer of
// the session. A message the code writes (`SYSTEM`) takes its text from copy/; the model's text (`AGENT`)
// is checked by the gate (G2, verification) against this turn's tool results.
import { type MessageKind, type ToolFailure, fail, ok } from "@reclamo/shared";
import { sha256Hex } from "../../lib/crypto";
import { deadlineText, isoAr } from "../../complaints/sla";
import type { GateOutcome, OutboundButton, OutboundCall, OutboundGate, OutboundRequest } from "../../outbound/types";
import { type ToolContext, type ToolResponse, actorOf } from "../common/context";

/** Who asks the gate: the agent through the Gateway, the code for an in-process caller. */
export function outboundCallOf(ctx: Pick<ToolContext<unknown>, "principal" | "correlationId" | "log">): OutboundCall {
  return { actor: actorOf(ctx.principal), correlationId: ctx.correlationId, log: ctx.log };
}

/** The turn whose results ground the message and the event that opened it. */
export function turnOf(ctx: Pick<ToolContext<unknown>, "session">): Pick<OutboundRequest, "turnId" | "triggerEventId"> {
  return { turnId: ctx.session.turnId, triggerEventId: ctx.session.triggerEventId };
}

/**
 * A message id derived from what it is about (`msg-` + 26 hex), so the same fixed message asked again by
 * a retry of the same call is the same message: the gate's send claim answers the first send.
 */
export function derivedMessageId(...parts: readonly string[]): string {
  return `msg-${sha256Hex(parts.join("\u0000")).slice(0, 26)}`;
}

export interface SystemMessage {
  readonly kind: MessageKind;
  readonly channel?: OutboundRequest["channel"];
  /** Already filled from copy/. */
  readonly text: string;
  readonly complaintId?: string;
  readonly buttons?: readonly OutboundButton[];
  readonly subject?: string;
  readonly attachments?: OutboundRequest["attachments"];
  readonly refs?: Readonly<Record<string, string>>;
  /** Parts the message id derives from (the call it answers); a new id when absent. */
  readonly idParts?: readonly string[];
}

/** A fixed message of the code for the customer of the session. */
export function systemRequest(ctx: Pick<ToolContext<unknown>, "session" | "tool">, message: SystemMessage): OutboundRequest {
  const { session } = ctx;
  return {
    worldId: session.worldId,
    customerId: session.customerId,
    ...(message.complaintId === undefined ? {} : { complaintId: message.complaintId }),
    sender: "SYSTEM",
    channel: message.channel ?? "WHATSAPP",
    kind: message.kind,
    text: message.text,
    ...(message.buttons === undefined ? {} : { buttons: message.buttons }),
    ...(message.subject === undefined ? {} : { subject: message.subject }),
    ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
    refs: { tool: ctx.tool, ...(message.complaintId === undefined ? {} : { complaintId: message.complaintId }), ...(message.refs ?? {}) },
    ...turnOf(ctx),
    ...(message.idParts === undefined ? {} : { messageId: derivedMessageId(session.worldId, message.kind, ...message.idParts) }),
  };
}

export interface SystemSendResult {
  readonly sent: boolean;
  readonly messageId?: string;
  readonly decision?: string;
  readonly ruleIds: readonly string[];
}

/**
 * Sends a fixed message of the code and never throws: the effect the tool already committed (a number, a
 * handoff, a freeze) stands whatever the gate decides, and the decision is on the tape and in the log.
 */
export async function sendSystem(gate: OutboundGate, ctx: Pick<ToolContext<unknown>, "session" | "tool" | "principal" | "correlationId" | "log">, message: SystemMessage): Promise<SystemSendResult> {
  try {
    const outcome = await gate(systemRequest(ctx, message), outboundCallOf(ctx));
    if (outcome.ok) return { sent: outcome.decision === "ALLOWED", messageId: outcome.messageId, decision: outcome.decision, ruleIds: outcome.ruleIds };
    ctx.log.warn("tool.system_message_refused", { kind: message.kind, code: outcome.failure.error.code, decision: outcome.decision, ruleIds: [...outcome.ruleIds] });
    return { sent: false, ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }), ...(outcome.decision === undefined ? {} : { decision: outcome.decision }), ruleIds: outcome.ruleIds };
  } catch (error) {
    ctx.log.error("tool.system_message_failed", { kind: message.kind, error });
    return { sent: false, ruleIds: [] };
  }
}

/** A refusal that carries more than the error (the existing `actionId`, the gate's decision): never thrown. */
export function failureWith(failure: ToolFailure, extra: Readonly<Record<string, unknown>>): ToolResponse {
  return Object.assign({}, extra, failure);
}

/** "jueves 22/10 09:00": a deferred send as the model reads it (the world's local time). */
export function deferredUntilText(instant: string): string {
  return `${deadlineText(instant)} ${isoAr(new Date(instant)).slice(11, 16)}`;
}

/** The tool's answer for a gate decision (the output of `send_whatsapp`, docs/tool-catalog.md). */
export function gateAnswer(outcome: GateOutcome): ToolResponse {
  const ruleIds = [...outcome.ruleIds];
  if (!outcome.ok) {
    return failureWith(fail(outcome.failure.error.code, outcome.failure.error.message, outcome.failure.error.reason), {
      ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
      ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }),
      ruleIds,
      ...(outcome.reroutes === undefined || outcome.reroutes.length === 0 ? {} : { reroutes: outcome.reroutes.map((offer) => offer.route) }),
    });
  }
  const base = { messageId: outcome.messageId, decision: outcome.decision, ruleIds };
  switch (outcome.decision) {
    case "ALLOWED":
      return ok({ ...base, ...(outcome.replayOf === undefined ? {} : { replayOf: outcome.replayOf }) });
    case "DEFERRED":
      return ok({ ...base, deferredUntilText: outcome.deferredUntilText ?? deferredUntilText(outcome.nextAllowedAt) });
    case "REROUTED":
      return ok({ ...base, reroutedTo: outcome.reroutedTo });
  }
}
