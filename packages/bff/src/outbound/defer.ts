// A send the policy deferred (docs/architecture-integrations.md §4, docs/architecture.md §10 timer
// `DEFERRED_SEND`): a time rule (`CH-CONTACT-HOURS`, `CH-MAX-PER-DAY`) allows it only at
// `nextAllowedAt`. The tape gets `DEFERRED` with that instant, and in one transaction the timer
// `DEFERRED_SEND` keeps the request (timers/events.ts `DeferredSendPayload`, with the message id, so
// the same message is sent later and never twice) and the `Message OUT` waits as `DEFERRED`. The
// content was already rendered, put through G2 and verified: the kept request carries the hash of that
// content, and when the timer fires an unchanged request skips those checks (the turn's results that
// grounded it are gone by then) while the policy, the fence and the transport decide again.
import { localTimeAr } from "../channel-policy/checks";
import type { PolicyDecision } from "../channel-policy/types";
import { newIdOf } from "../complaints/deps";
import { deadlineText } from "../complaints/sla";
import { keys } from "../connector/keys";
import type { JsonObject } from "../domain/common";
import type { Message } from "../domain/conversation";
import { sha256Hex } from "../lib/crypto";
import type { DeferredSendPayload } from "../timers/events";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import { stageMessageOp } from "./persist";
import type { Prepared } from "./prepare";
import { appendTape } from "./tape";
import type { GateDeferred, OutboundCall, OutboundRequest } from "./types";

/** `refs` keys the gate itself writes on a kept request. */
export const DEFERRED_REF = { contentHash: "contentHash", timerId: "deferredTimerId" } as const;

/** The hash of what was checked: text, template and attachments, as the request names them. */
export function contentHashOf(request: Pick<OutboundRequest, "kind" | "text" | "template" | "attachments">): string {
  return sha256Hex(JSON.stringify({ kind: request.kind, text: request.text ?? null, template: request.template ?? null, attachments: (request.attachments ?? []).map((file) => file.sha256) }));
}

/** Whether a fired request is the very content that was checked when it was deferred. */
export function contentWasChecked(request: OutboundRequest): boolean {
  return request.refs[DEFERRED_REF.timerId] !== undefined && request.refs[DEFERRED_REF.contentHash] === contentHashOf(request);
}

/** "jueves 08/10 a las 08:00". */
export function deferredUntilText(nextAllowedAt: string): string {
  return `${deadlineText(nextAllowedAt)} a las ${localTimeAr(new Date(nextAllowedAt))}`;
}

/** The request as the timer keeps it: the message id fixed, the content hash added, nothing of a past fire. */
function keptRequest(request: OutboundRequest, messageId: string): JsonObject {
  const { [DEFERRED_REF.timerId]: _fired, ...refs } = request.refs;
  return JSON.parse(JSON.stringify({ ...request, messageId, refs: { ...refs, [DEFERRED_REF.contentHash]: contentHashOf(request) } })) as JsonObject;
}

export interface DeferInput {
  readonly request: OutboundRequest;
  readonly ctx: SendContext;
  readonly decision: PolicyDecision & { readonly nextAllowedAt: string };
  readonly prepared: Prepared;
  readonly messageId: string;
  readonly existing?: Message;
}

export async function deferSend(deps: OutboundDeps, input: DeferInput, call: OutboundCall): Promise<GateDeferred> {
  const { request, ctx, decision, messageId, prepared } = input;
  const { connector } = deps.chains;
  const entry = await appendTape(
    deps,
    {
      worldId: request.worldId,
      epoch: ctx.epoch,
      atSim: ctx.simNow.toISOString(),
      decision: "DEFERRED",
      ruleIds: decision.ruleIds,
      evaluated: decision.evaluated,
      ruleSetVersion: decision.ruleSetVersion,
      sender: request.sender,
      channel: request.channel,
      kind: request.kind,
      customerId: request.customerId,
      messageId,
      nextAllowedAt: decision.nextAllowedAt,
      ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }),
      ...(request.rerouteOf === undefined ? {} : { rerouteOf: request.rerouteOf }),
    },
    call.log,
  );
  const timerId = newIdOf(deps.chains, "ds");
  const payload: DeferredSendPayload = {
    customerId: request.customerId,
    ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }),
    request: keptRequest(request, messageId),
    actor: call.actor,
    tapeId: entry.tapeId,
  };
  const body = prepared.channel === "WHATSAPP" ? prepared.rendered : `${prepared.draft.subject}\n\n${prepared.draft.text}`;
  await connector.transact([
    connector.timers.putOp({
      worldId: request.worldId,
      kind: "DEFERRED_SEND",
      timerId,
      dueAtSim: decision.nextAllowedAt,
      seq: 0,
      status: "SCHEDULED",
      epoch: ctx.epoch,
      ownerKey: request.complaintId === undefined ? `CONV#${request.customerId}` : `CMP#${request.complaintId}`,
      payload: payload as unknown as JsonObject,
      reason: decision.ruleIds[0] ?? "DEFERRED",
    }),
    stageMessageOp(
      connector,
      { request, messageId, atSim: ctx.simNow.toISOString(), status: "DEFERRED", tapeRef: entry.tapeId, body, simulated: request.channel === "WHATSAPP" && ctx.mode === "simulated", disclosure: prepared.channel === "WHATSAPP" && prepared.draft.disclosure },
      input.existing,
    ),
  ]);
  try {
    await deps.chains.milestones?.schedule(request.worldId, [{ kind: "DEFERRED_SEND", timerId }]);
  } catch (error) {
    // The timer is in the clock's due list: a paused world dispatches it when the clock moves.
    call.log.error("outbound.defer_schedule_failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }
  call.log.info("outbound.deferred", { rule: decision.ruleIds[0], kind: request.kind });
  return {
    ok: true,
    decision: "DEFERRED",
    messageId,
    tapeId: entry.tapeId,
    ruleIds: decision.ruleIds,
    nextAllowedAt: decision.nextAllowedAt,
    timerKey: keys.timerKey(request.worldId, "DEFERRED_SEND", timerId),
    deferredUntilText: deferredUntilText(decision.nextAllowedAt),
  };
}
