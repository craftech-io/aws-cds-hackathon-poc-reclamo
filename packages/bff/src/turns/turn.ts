// One turn of the Harness for an event that already passed the control, kill and cap gates
// (worker/run-turn.ts). In order (docs/architecture.md §9.1):
//
//   1. the untrusted text of the turn (turns/facts.ts); a customer's text goes through the G1 pre-filter:
//      a BLOCKED assessment ends the turn here (the worker answers by code), an anonymization goes on
//      with G1's text, masked again by the normalizer, and `GUARDRAIL_MASK`;
//   2. a QA order for this conversation (turns/forced.ts), only in QA worlds;
//   3. the session and the open turn (turns/session.ts), with the customer's open complaints;
//   4. in parallel: the preloaded reads with the turn's token (turns/preload.ts), the long-term memory
//      validated by the worker (agent/memory.ts) and the receipt attachments;
//   5. the envelope inside a new random delimiter, named by the turn's system prompt, and the Harness;
//   6. the turn is closed whatever happens (its token dies with it), then the note and the usage.
//
//   end_turn / stop_sequence                  COMPLETED: the worker runs the obligations
//   content_filtered / guardrail_intervened   BLOCKED (origin HARNESS): the sentinel never leaves
//   max_tokens, any other stop, a timeout     FAILED: `TurnErrors`, the worker's fallback
//   a throttled call out of retries           the turn closes and the event goes back to the queue
import { buildSystemPrompt } from "../agent/system-prompt";
import { renderEnvelope } from "../agent/envelope";
import { type HarnessTurnResult, HarnessError } from "../agent/harness-client";
import { newTurnDelimiter, normalizeInboundText } from "../channels/normalizer";
import { isoAr } from "../complaints/sla";
import { WORKER_ACTIONS, auditOnce } from "../worker/audit";
import type { TurnEvent } from "../worker/events";
import type { TurnContext, TurnDeps, TurnFailureCause, TurnOutcome } from "./deps";
import { type TurnContextData, type TurnInbound, chargeComplaintOpen, envelopeAttachments, envelopeFacts, inboundFacts, isIdentified, loadInbound, sessionComplaintIds } from "./facts";
import { takeForcedTurn } from "./forced";
import { type HarnessIdentity, harnessIdentity } from "./identity";
import { preloadReads } from "./preload";
import { FIXED_NOTES, logTurnError, logTurnLatency, recordUsage, writeTurnNote } from "./record";
import { type OpenedTurn, closeTurnSession, openTurnSession } from "./session";

/** The memory search of a turn without a question: a fixed status question (ADR-0021 §10). */
export const STATUS_QUERY = "¿Cómo están mi cuenta y mi reclamo?";

type Prefiltered = { readonly blocked: TurnOutcome } | { readonly inbound: TurnInbound | undefined };

async function prefilter(deps: TurnDeps, event: TurnEvent, ctx: TurnContext, inbound: TurnInbound | undefined): Promise<Prefiltered> {
  if (inbound === undefined || inbound.source !== "CUSTOMER") return { inbound };
  const verdict = await deps.prefilter.check(inbound.text);
  if (verdict.action === "NONE") return { inbound };
  if (verdict.action === "BLOCKED") return { blocked: { kind: "BLOCKED", origin: "PREFILTER", policy: verdict.policy, topics: verdict.topics, inbound } };
  const masked = normalizeInboundText(verdict.text, event.worldId);
  await auditOnce(
    { data: deps.data, now: ctx.now, log: ctx.log },
    { action: WORKER_ACTIONS.guardrailMask, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, ruleIds: ["G1"], refs: { customerId: event.customerId, ...(inbound.message === undefined ? {} : { messageId: inbound.message.messageId }) }, detail: { kinds: [...verdict.kinds] } },
  );
  return { inbound: { ...inbound, text: masked.text, truncated: inbound.truncated || masked.truncated } };
}

interface Prepared {
  readonly envelope: string;
  readonly systemPrompt: string;
  readonly withImage: boolean;
}

async function prepare(deps: TurnDeps, event: TurnEvent, ctx: TurnContext, context: TurnContextData, turn: { readonly session: OpenedTurn; readonly identity: HarnessIdentity }, inbound: TurnInbound | undefined, identified: boolean): Promise<Prepared> {
  const { session, identity } = turn;
  const delimiter = newTurnDelimiter(deps.random);
  const [preloaded, memory, attachments] = await Promise.all([
    deps.reads === undefined ? [] : preloadReads(deps.reads, { sessionToken: session.token, worldId: event.worldId, eventId: event.eventId, identified, eventAtSim: event.eventAtSim, chargeComplaintOpen: chargeComplaintOpen(context) }, ctx.log),
    deps.memory.recall({ actorId: identity.actorId, runtimeSessionId: identity.runtimeSessionId, query: inbound?.source === "CUSTOMER" ? inbound.text : STATUS_QUERY }, ctx.log),
    envelopeAttachments(deps.data, event),
  ]);
  if (memory.discarded > 0) {
    await auditOnce(
      { data: deps.data, now: ctx.now, log: ctx.log },
      { action: WORKER_ACTIONS.memoryDiscarded, worldId: event.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, refs: { customerId: event.customerId }, detail: { discarded: memory.discarded } },
    );
  }
  const envelope = renderEnvelope({
    sessionToken: session.token,
    event: { type: event.type, id: event.eventId, at: isoAr(new Date(event.eventAtSim)) },
    facts: [...envelopeFacts(event, context, identified, ctx.now()), ...inboundFacts(inbound)],
    delimiter,
    ...(inbound === undefined ? {} : { inbound: { text: inbound.text, channel: inbound.channel, fromRole: inbound.fromRole, truncated: inbound.truncated } }),
    memory: memory.lines,
    attachments,
    preloaded,
  });
  return { envelope, systemPrompt: buildSystemPrompt({ delimiter }), withImage: attachments.length > 0 };
}

type Invocation = { readonly ran: true; readonly result: HarnessTurnResult; readonly latencyMs: number; readonly withImage: boolean } | { readonly ran: false; readonly cause: TurnFailureCause } | { readonly ran: false; readonly silent: true };

async function invoke(deps: TurnDeps, event: TurnEvent, ctx: TurnContext, context: TurnContextData, session: OpenedTurn, inbound: TurnInbound | undefined, identified: boolean): Promise<Invocation> {
  const forced = await takeForcedTurn(deps.data, event.worldId, event.customerId);
  if (forced === "FAILURE") return { ran: false, cause: "FORCED" };
  if (forced === "NO_OUTBOUND") return { ran: false, silent: true };
  const identity = harnessIdentity(deps.sessionKey(), { worldId: event.worldId, customerId: event.customerId, worldEpoch: event.epoch, sessionEpoch: context.conversation?.sessionEpoch ?? 0 });
  const prepared = await prepare(deps, event, ctx, context, { session, identity }, inbound, identified);
  const started = ctx.now().getTime();
  try {
    const result = await deps.harness.invoke({ ...identity, envelope: prepared.envelope, systemPrompt: prepared.systemPrompt, deadlineMs: ctx.deadlineMs });
    return { ran: true, result, latencyMs: ctx.now().getTime() - started, withImage: prepared.withImage };
  } catch (error) {
    if (!(error instanceof HarnessError) || error.kind === "THROTTLED") throw error;
    const cause = error.cause instanceof Error ? { causeName: error.cause.name } : {};
    ctx.log.warn("turn.harness_failed", { kind: error.kind, turnId: session.turnId, ...cause });
    return { ran: false, cause: error.kind === "TIMEOUT" ? "TIMEOUT" : "HARNESS_ERROR" };
  }
}

/** What the note of a turn refers to: the operator's messages of a release (FL-086), or the event. */
function noteRefs(event: TurnEvent): string[] {
  return event.type === "OPERATOR_RELEASED" ? [...event.payload.messageIds] : [event.eventId];
}

export async function runTurn(deps: TurnDeps, event: TurnEvent, ctx: TurnContext, context: TurnContextData): Promise<TurnOutcome> {
  if (context.conversation === undefined) {
    ctx.log.warn("turn.no_conversation");
    return { kind: "SKIPPED", reason: "NO_CONVERSATION" };
  }
  const filtered = await prefilter(deps, event, ctx, await loadInbound(deps.data, event));
  if ("blocked" in filtered) return filtered.blocked;
  const { inbound } = filtered;
  const identified = isIdentified(context.conversation, ctx.now());
  const complaintIds = sessionComplaintIds(event, context);
  const sessionDeps = { data: deps.data, sessionKey: deps.sessionKey(), now: ctx.now, ...(deps.random === undefined ? {} : { random: deps.random }) };
  const inboundMessageId = inbound?.source === "CUSTOMER" ? inbound.message?.messageId : undefined;
  const session = await openTurnSession(sessionDeps, {
    worldId: event.worldId,
    customerId: event.customerId,
    complaintIds,
    identified,
    trigger: event.type,
    triggerEventId: event.eventId,
    ...(inboundMessageId === undefined ? {} : { inboundMessageId }),
    eventAtSim: event.eventAtSim,
  });
  let invocation: Invocation;
  try {
    invocation = await invoke(deps, event, ctx, context, session, inbound, identified);
  } finally {
    await closeTurnSession(sessionDeps, event.worldId, session.turnId);
  }
  const record = { data: deps.data, agentMode: deps.agentMode, log: ctx.log };
  const base = { event, turnId: session.turnId, refs: noteRefs(event) };
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (!invocation.ran) {
    if ("silent" in invocation) {
      await writeTurnNote(record, { ...base, text: FIXED_NOTES.silent });
      return { kind: "COMPLETED", turnId: session.turnId, usage, stopReason: "forced_silence", toolUses: 0, complaintIds, forcedSilent: true };
    }
    await writeTurnNote(record, { ...base, text: FIXED_NOTES.failed });
    logTurnError(ctx.log, { trigger: event.type, cause: invocation.cause });
    return { kind: "FAILED", turnId: session.turnId, cause: invocation.cause, complaintIds };
  }
  const { result } = invocation;
  const complaint = context.complaints.find((candidate) => candidate.complaintId === complaintIds[0]);
  await recordUsage(record, event, complaint, result.usage);
  logTurnLatency(ctx.log, invocation.latencyMs, { trigger: event.type, withImage: invocation.withImage, toolUses: result.toolUses, outcome: result.outcome });
  if (result.outcome === "GUARDRAIL") {
    await writeTurnNote(record, { ...base, text: FIXED_NOTES.guardrail, stopReason: result.stopReason });
    return { kind: "BLOCKED", origin: "HARNESS", policy: "HARNESS", topics: [], turnId: session.turnId, stopReason: result.stopReason, ...(inbound === undefined ? {} : { inbound }) };
  }
  if (result.outcome === "INCOMPLETE") {
    await writeTurnNote(record, { ...base, text: result.note || FIXED_NOTES.failed, stopReason: result.stopReason });
    logTurnError(ctx.log, { trigger: event.type, cause: "INCOMPLETE", stopReason: result.stopReason });
    return { kind: "FAILED", turnId: session.turnId, cause: "INCOMPLETE", stopReason: result.stopReason, complaintIds };
  }
  await writeTurnNote(record, { ...base, text: result.note, stopReason: result.stopReason });
  return { kind: "COMPLETED", turnId: session.turnId, usage: result.usage, stopReason: result.stopReason, toolUses: result.toolUses, complaintIds };
}
