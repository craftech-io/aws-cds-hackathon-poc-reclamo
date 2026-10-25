// `sendThroughGate`: the only way a message leaves the system (ADR-0006, docs/architecture-integrations.md
// §4), whoever asks — the agent's send tools, the inbound adapter's fixed replies, the workers (operator,
// milestones, obligations, fallbacks, deferred sends). In order:
//
//   0  repeat     the same WhatsApp asked twice in one turn answers the message already sent (repeat.ts)
//   1  policy     every `CH-*` rule (channel-policy/engine.ts) on the facts of context.ts
//   2  render     template or text with the automation disclosure and the buttons, or the email (render/)
//   3  G2         over the free text an agent or an operator wrote (g2.ts, query of g2-query.ts)
//   4  verify     figures, template parameters, lexicons, links, sensitive asks, language (verify.ts)
//   5-9           fence, `ALLOWED`, claim, transport, `DISPATCH` (dispatch.ts)
//
// Every evaluation leaves a tape entry: `BLOCKED` (block.ts; a system message with a permitted path is
// rerouted at once, reroute.ts), `DEFERRED` (defer.ts) or `ALLOWED` + `DISPATCH`. A request whose message
// already exists (a redelivered event, the same `messageId`) answers what was decided and never sends
// twice; a deferred message whose timer fired is decided again. Refusals are answers, not exceptions:
// only an invalid shape (`ToolError INVALID`) or an unexpected failure throws.
import { ToolError, fail } from "@reclamo/shared";
import { evaluate } from "../channel-policy/engine";
import { senderClassOf } from "../channel-policy/kinds";
import { renderTemplateBody } from "../copy";
import { newIdOf } from "../complaints/deps";
import type { Message } from "../domain/conversation";
import { recordBlock } from "./block";
import { type SendContext, loadContext, policyInputOf } from "./context";
import { DEFERRED_REF, contentWasChecked, deferSend, deferredUntilText } from "./defer";
import type { OutboundDeps } from "./deps";
import { dispatch } from "./dispatch";
import { prepareContent } from "./prepare";
import { needsDisclosure } from "./render/disclosure";
import { repeatedInTurn } from "./repeat";
import { rerouteBlocked, systemRoute } from "./reroute";
import { stageOutboundDeps } from "./stage";
import { GATE_AUDIT, GATE_REASON, type GateOutcome, type OutboundCall, type OperatorReroute, type OutboundGate, type OutboundRequest, OutboundRequestSchema } from "./types";

/** Statuses a message is decided in for good: a redelivered request answers them. */
const DECIDED: ReadonlySet<Message["status"]> = new Set(["SENT", "DELIVERED", "READ", "BLOCKED", "DEFERRED", "UNKNOWN_DELIVERY"]);

function parseRequest(asked: OutboundRequest): OutboundRequest {
  const parsed = OutboundRequestSchema.safeParse(asked);
  if (!parsed.success) throw new ToolError("INVALID", "the outbound request is not valid", GATE_REASON.CONTENT_INVALID);
  return parsed.data;
}

/** What the customer would have read, kept on the `BLOCKED` row (a template only when it renders). */
function attemptedText(request: OutboundRequest): string {
  if (request.template === undefined) return request.text ?? "";
  try {
    return renderTemplateBody(request.template.name, request.template.params);
  } catch {
    return request.template.name;
  }
}

/** The answer to a request whose message was already decided (a redelivered event never sends twice). */
async function replayExisting(deps: OutboundDeps, message: Message): Promise<GateOutcome> {
  const { messageId } = message;
  const tapeId = message.tapeRef === undefined ? {} : { tapeId: message.tapeRef };
  if (message.status === "BLOCKED") return { ok: false, decision: "BLOCKED", messageId, ...tapeId, ruleIds: [], failure: fail("CONFLICT", "this message was already decided and did not go out", GATE_REASON.ALREADY_DECIDED) };
  if (message.status === "UNKNOWN_DELIVERY") return { ok: false, messageId, ...tapeId, ruleIds: [], failure: fail("UNKNOWN_DELIVERY", "this message may have gone out already: a person checks it") };
  if (message.status === "DEFERRED") {
    const entries = await deps.chains.connector.chains.listTapeByMessage(messageId);
    const deferred = entries.filter((entry) => entry.decision === "DEFERRED" && entry.nextAllowedAt !== undefined).at(-1);
    const nextAllowedAt = deferred?.nextAllowedAt ?? message.atSim;
    return { ok: true, decision: "DEFERRED", messageId, ...tapeId, ruleIds: [...(deferred?.ruleIds ?? [])], nextAllowedAt, timerKey: "", deferredUntilText: deferredUntilText(nextAllowedAt) };
  }
  return { ok: true, decision: "ALLOWED", messageId, ...tapeId, ruleIds: [], ...(message.providerMessageId === undefined ? {} : { providerMessageId: message.providerMessageId }) };
}

/** Step 0: the WhatsApp already sent in this turn, audited `OUTBOUND_REPLAYED`; nothing evaluated, nothing sent. */
async function replayInTurn(deps: OutboundDeps, request: OutboundRequest, ctx: SendContext, original: Message, call: OutboundCall): Promise<GateOutcome> {
  await deps.chains.connector.audit.append({
    worldId: request.worldId,
    epoch: ctx.epoch,
    auditId: newIdOf(deps.chains, "aud"),
    ts: ctx.realNow.toISOString(),
    atSim: ctx.simNow.toISOString(),
    action: GATE_AUDIT.REPLAYED,
    actor: call.actor,
    refs: { messageId: original.messageId, ...(request.turnId === undefined ? {} : { turnId: request.turnId }) },
    primaryRef: request.turnId === undefined ? `CUS#${request.customerId}` : `TURN#${request.turnId}`,
    outcome: "REPLAYED",
  });
  call.log.warn("outbound.repeated_in_turn", { messageId: original.messageId, kind: request.kind });
  return {
    ok: true,
    decision: "ALLOWED",
    messageId: original.messageId,
    replayOf: original.messageId,
    ruleIds: [],
    ...(original.tapeRef === undefined ? {} : { tapeId: original.tapeRef }),
    ...(original.providerMessageId === undefined ? {} : { providerMessageId: original.providerMessageId }),
  };
}

async function runGate(deps: OutboundDeps, gate: OutboundGate, asked: OutboundRequest, call: OutboundCall): Promise<GateOutcome> {
  const request = parseRequest(asked);
  const log = call.log.child({ service: "outbound", channel: request.channel, kind: request.kind, senderClass: senderClassOf(request.sender) });
  const scoped: OutboundCall = { ...call, log };
  const { connector } = deps.chains;
  const existing = request.messageId === undefined ? undefined : await connector.conversations.findMessage(request.worldId, request.customerId, request.messageId);
  const resuming = existing?.status === "DEFERRED" && request.refs[DEFERRED_REF.timerId] !== undefined;
  if (existing !== undefined && !resuming && DECIDED.has(existing.status)) return replayExisting(deps, existing);
  const messageId = request.messageId ?? newIdOf(deps.chains, "msg");
  const ctx = await loadContext(deps, request, scoped);

  const repeated = repeatedInTurn(request, ctx.history);
  if (repeated !== undefined) return replayInTurn(deps, request, ctx, repeated, scoped);
  // The written answer was claimed with its `FINAL_ANSWER` entry (complaints/answer.ts): a second send collides.
  if (request.kind === "FORMAL_ANSWER" && ctx.complaint?.answer?.inFlight !== messageId) throw new ToolError("CONFLICT", "the written answer is not claimed by this message", GATE_REASON.ANSWER_NOT_CLAIMED);

  const debt = request.kind === "COLLECTION_NOTICE_EMAIL" ? await deps.debts.overdue(request.worldId, request.customerId, ctx.simNow, call.correlationId) : undefined;
  const decision = evaluate(policyInputOf(request, ctx, { messageId, ...(debt === undefined ? {} : { debt }), demoRecipients: deps.demoRecipients() }));
  const common = { request, ctx, messageId, evaluated: decision.evaluated, ruleSetVersion: decision.ruleSetVersion, attempted: attemptedText(request) };
  if (decision.decision === "BLOCKED") {
    const code = decision.errorCode === undefined || decision.errorCode === "DEFERRED" ? "POLICY_DENIED" : decision.errorCode;
    const refused = await recordBlock(deps, { ...common, ruleIds: decision.ruleIds, code, reason: decision.ruleIds[0] ?? "POLICY", message: decision.reason ?? "the channel policy blocked the message", ...(decision.reroutes === undefined ? {} : { reroutes: decision.reroutes }), ...(decision.collectionCategories === undefined ? {} : { categories: decision.collectionCategories }) }, scoped);
    const route = request.sender === "SYSTEM" ? systemRoute(decision.reroutes ?? []) : undefined;
    if (route === undefined || refused.tapeId === undefined) return refused;
    return rerouteBlocked(deps, gate, { worldId: request.worldId, customerId: request.customerId, tapeId: refused.tapeId, route, by: "SYSTEM", messageId: `rr-${messageId}` }, scoped);
  }

  const disclose = request.channel === "WHATSAPP" && request.template === undefined && needsDisclosure(ctx.meta);
  const content = await prepareContent(deps, request, ctx, { disclose, ...(debt === undefined ? {} : { debt }), checked: resuming && contentWasChecked(request) }, log);
  if (!content.ok) return recordBlock(deps, { ...common, ruleIds: content.ruleIds, code: content.code, reason: content.reason, message: content.message, ...(content.g2 === undefined ? {} : { g2: content.g2 }), ...(content.categories === undefined ? {} : { categories: content.categories }) }, scoped);
  const kept = resuming ? { existing } : {};
  if (decision.decision === "DEFERRED") return deferSend(deps, { request, ctx, decision: { ...decision, nextAllowedAt: decision.nextAllowedAt ?? ctx.simNow.toISOString() }, prepared: content.prepared, messageId, ...kept }, scoped);
  const restaged = existing !== undefined && !DECIDED.has(existing.status) ? { existing } : kept;
  return dispatch(deps, { request, ctx, decision, prepared: content.prepared, messageId, ...restaged, ...(debt === undefined ? {} : { debt }), ...(content.g2 === undefined ? {} : { g2: content.g2 }) }, scoped);
}

/** The gate over the given ports (tests, local flows, the QA driver's probe). */
export function createOutboundGate(deps: OutboundDeps): OutboundGate {
  const gate: OutboundGate = (request, call) => runGate(deps, gate, request, call);
  return gate;
}

/** Picks a permitted path for a blocked message (the console's `conversation.reroute`, run by the worker). */
export function rerouteThroughGate(deps: OutboundDeps): OperatorReroute {
  const gate = createOutboundGate(deps);
  return (input, call) => rerouteBlocked(deps, gate, input, call);
}

let stageGate: OutboundGate | undefined;
let stageReroute: OperatorReroute | undefined;

/** The gate of a deployed function, over what SST links into it (outbound/stage.ts). */
export const sendThroughGate: OutboundGate = (request, call) => {
  stageGate ??= createOutboundGate(stageOutboundDeps(call.log));
  return stageGate(request, call);
};

/** The reroute of a deployed worker, over the same linked ports. */
export const rerouteThroughStageGate: OperatorReroute = (input, call) => {
  stageReroute ??= rerouteThroughGate(stageOutboundDeps(call.log));
  return stageReroute(input, call);
};
