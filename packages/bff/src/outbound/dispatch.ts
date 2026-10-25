// Steps 5 to 9 of the gate (docs/architecture-integrations.md §4, ADR-0006), for a message the policy
// allowed and the content checks passed:
//
//   5  fence      the strict recipient fence (recipient-fence.ts) and, in a self-signup world, the daily
//                 email cap (mail-cap.ts); a refusal is a `BLOCKED` entry and nothing is sent
//      stage      the `Message OUT` `PENDING` with its button nonces and the disclosure mark, in one
//                 transaction (of two racing senders only one carries the disclosure line)
//   6  tape       `ALLOWED` with the SHA-256 of the exact rendered body, BEFORE the transport
//   7  claim      `SEND#<messageId>`: an earlier send answers the same message; a claim without a
//                 provider id is `UNKNOWN_DELIVERY` (never a blind resend: a person decides)
//   8  transport  SES through its single client, or End User Messaging Social / the phone simulator
//   9  tape       `DISPATCH` with `SENT` (and the provider id), `FAILED` or `UNKNOWN_DELIVERY`
//
// A transport that timed out may have delivered: the claim stays and the message is UNKNOWN_DELIVERY.
// A transport that refused before sending frees the claim, so the event's retry may send.
import { ChannelError, type DispatchResult, ToolError, fail } from "@reclamo/shared";
import { senderClassOf } from "../channel-policy/kinds";
import type { PolicyDecision } from "../channel-policy/types";
import { transportFor } from "../channels/whatsapp/registry";
import { nonceOps } from "../channels/whatsapp/nonces";
import { TransactionCancelledError } from "../connector/errors";
import { keys } from "../connector/keys";
import { cond, type WriteOp } from "../connector/store";
import { newIdOf } from "../complaints/deps";
import type { Message } from "../domain/conversation";
import { sha256Hex } from "../lib/crypto";
import { attachmentsOf } from "./attachments";
import { recordBlock } from "./block";
import type { SendContext } from "./context";
import type { AttachableDocument, DebtDetail, OutboundDeps } from "./deps";
import { takeMailCap } from "./mail-cap";
import type { G2Verdict } from "./g2";
import { type MessageDraft, type StagedMessage, interactiveOf, settleMessage, stageMessageOp, stagedOf } from "./persist";
import type { Prepared } from "./prepare";
import { RECIPIENT_FENCE_RULE, emailFence, whatsappFence } from "./recipient-fence";
import { disclosureOps } from "./render/disclosure";
import { renderWhatsApp, toWaOutbound } from "./render/whatsapp";
import { appendTape, payloadHashOf } from "./tape";
import { GATE_AUDIT, GATE_REASON, GATE_RULE, type GateOutcome, type GateRefused, type OutboundCall, type OutboundRequest } from "./types";

export interface DispatchInput {
  readonly request: OutboundRequest;
  readonly ctx: SendContext;
  readonly decision: PolicyDecision;
  readonly prepared: Prepared;
  readonly messageId: string;
  /** The row of a deferred message being sent now. */
  readonly existing?: Message;
  readonly debt?: DebtDetail;
  /** The G2 verdict of the free text (none for a template or a text without free text). */
  readonly g2?: G2Verdict;
}

/** The scores a sent message keeps of its G2 verdict. */
function g2Scores(verdict: G2Verdict | undefined): Message["g2"] {
  if (verdict === undefined || (verdict.groundingScore === undefined && verdict.relevanceScore === undefined)) return undefined;
  return { ...(verdict.groundingScore === undefined ? {} : { groundingScore: verdict.groundingScore }), ...(verdict.relevanceScore === undefined ? {} : { relevanceScore: verdict.relevanceScore }) };
}

/** `mail-<24 hex>`: the email of a message, the same on every retry (EmailTags accept only `[A-Za-z0-9_-]`). */
export function mailIdOf(worldId: string, messageId: string): string {
  return `mail-${sha256Hex(`${worldId}#${messageId}`).slice(0, 24)}`;
}

function blockWith(deps: OutboundDeps, input: DispatchInput, call: OutboundCall, rule: string, code: "RECIPIENT_NOT_ALLOWED" | "UNAVAILABLE", reason: string, message: string): Promise<GateRefused> {
  const { request, ctx, decision, messageId, prepared } = input;
  return recordBlock(deps, { request, ctx, messageId, ruleIds: [rule], evaluated: decision.evaluated, ruleSetVersion: decision.ruleSetVersion, code, reason, message, attempted: prepared.rendered }, call);
}

/** Step 5: the strict fence; `undefined` when the recipient may be reached. */
async function fenced(deps: OutboundDeps, input: DispatchInput, call: OutboundCall): Promise<GateRefused | undefined> {
  const { request, ctx } = input;
  const verdict =
    request.channel === "EMAIL"
      ? emailFence((intent) => deps.email.checkRecipient(intent), { worldId: request.worldId, to: ctx.to })
      : whatsappFence({ worldId: request.worldId, mode: ctx.mode, to: ctx.to, demoPhones: deps.demoRecipients().phones, stageModes: deps.stageModes });
  if (verdict.allowed) return undefined;
  return blockWith(deps, input, call, RECIPIENT_FENCE_RULE, "RECIPIENT_NOT_ALLOWED", verdict.reason, "the recipient is outside the fence of this world");
}

interface Staged {
  readonly staged: StagedMessage;
  readonly prepared: Prepared;
  readonly nonces: readonly string[];
}

/** The message row, its nonces and the disclosure mark; a lost disclosure race renders it again without the line. */
async function stage(deps: OutboundDeps, input: DispatchInput, phoneE164: string | undefined): Promise<Staged> {
  const { request, ctx, messageId, existing } = input;
  const { connector } = deps.chains;
  const phoneHash = phoneE164 === undefined ? undefined : await deps.phoneHash(phoneE164);
  let prepared = input.prepared;
  const scores = g2Scores(input.g2);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const disclosure = prepared.channel === "WHATSAPP" && prepared.draft.disclosure;
    const issued =
      prepared.channel === "WHATSAPP" && phoneHash !== undefined
        ? nonceOps(connector, { worldId: request.worldId, customerId: request.customerId, phoneHash, messageId, buttons: prepared.draft.buttons, now: ctx.realNow, ...(deps.newNonce === undefined ? {} : { generate: deps.newNonce }) })
        : { nonces: [] as string[], ops: [] as WriteOp[] };
    const interactive = prepared.channel === "WHATSAPP" ? interactiveOf(prepared.draft, issued.nonces) : undefined;
    const draft: MessageDraft = {
      request,
      messageId,
      atSim: ctx.simNow.toISOString(),
      status: "PENDING",
      body: prepared.channel === "WHATSAPP" ? prepared.rendered : `${prepared.draft.subject}\n\n${prepared.draft.text}`,
      simulated: request.channel === "WHATSAPP" && ctx.mode === "simulated",
      disclosure,
      ...(interactive === undefined ? {} : { interactive }),
      ...(scores === undefined ? {} : { g2: scores }),
    };
    const marks = disclosure ? disclosureOps(connector, ctx.meta) : [];
    try {
      await connector.transact([...marks, stageMessageOp(connector, draft, existing), ...issued.ops]);
      return { staged: stagedOf(draft, existing), prepared, nonces: issued.nonces };
    } catch (error) {
      const lostDisclosure = error instanceof TransactionCancelledError && marks.length > 0 && error.failedConditions().includes(0);
      if (!lostDisclosure || prepared.channel !== "WHATSAPP") throw error;
      // Another outbound of this epoch carried the line first: this one goes without it.
      const draftAgain = renderWhatsApp({ request, senderClass: senderClassOf(request.sender), disclose: false, loans: ctx.customer?.loans ?? [] });
      prepared = { channel: "WHATSAPP", draft: draftAgain, rendered: draftAgain.text };
    }
  }
  throw new ToolError("CONFLICT", "the conversation kept changing while the message was staged");
}

function renderedPayload(prepared: Prepared, attachments: readonly AttachableDocument[]): string {
  if (prepared.channel === "WHATSAPP") return JSON.stringify({ text: prepared.draft.text, buttons: prepared.draft.buttons.map((button) => ("title" in button ? button.title : button.action)) });
  return JSON.stringify({ subject: prepared.draft.subject, text: prepared.draft.text, html: prepared.draft.html, attachments: attachments.map((file) => file.sha256) });
}

interface Transported {
  readonly result: DispatchResult;
  readonly providerMessageId?: string;
  readonly mailId?: string;
  readonly status?: "SENT" | "DELIVERED";
  readonly refusal?: { readonly code: "RECIPIENT_NOT_ALLOWED" | "UNAVAILABLE"; readonly reason: string };
}

async function transport(deps: OutboundDeps, input: DispatchInput, staged: Staged, attachments: readonly AttachableDocument[], phone: string | undefined): Promise<Transported> {
  const { request, ctx, messageId } = input;
  const { prepared } = staged;
  try {
    if (prepared.channel === "WHATSAPP") {
      const record = { worldId: request.worldId, customerId: request.customerId, messageId, ...(phone === undefined || ctx.mode !== "simulated" ? {} : { to: phone }) };
      const sent = await transportFor(deps.whatsapp, ctx.mode).send({ record, outbound: toWaOutbound(prepared.draft, staged.nonces) });
      return { result: "SENT", providerMessageId: sent.providerMessageId, status: sent.status };
    }
    const sent = await deps.email.send({
      worldId: request.worldId,
      epoch: ctx.epoch,
      customerId: request.customerId,
      ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }),
      messageId,
      kind: request.kind,
      to: ctx.to ?? "",
      subject: prepared.draft.subject,
      text: prepared.draft.text,
      html: prepared.draft.html,
      attachments: attachments.map((file) => ({ filename: file.fileName, docKind: file.docKind, s3Key: file.s3Key, bytes: new Uint8Array(file.bytes) })),
      sentAtSim: ctx.simNow.toISOString(),
      mailId: mailIdOf(request.worldId, messageId),
    });
    if (sent.status === "SENT") return { result: "SENT", providerMessageId: sent.providerMessageId, mailId: sent.mailId, status: "SENT" };
    if (sent.status === "UNKNOWN_DELIVERY") return { result: "UNKNOWN_DELIVERY", mailId: sent.mailId };
    return { result: "FAILED", refusal: sent.code === "RECIPIENT_NOT_ALLOWED" ? { code: "RECIPIENT_NOT_ALLOWED", reason: sent.reason } : { code: "UNAVAILABLE", reason: sent.reason } };
  } catch (error) {
    if (error instanceof ChannelError && error.code === "TIMEOUT") return { result: "UNKNOWN_DELIVERY" };
    const code = error instanceof ToolError && error.code === "RECIPIENT_NOT_ALLOWED" ? "RECIPIENT_NOT_ALLOWED" : "UNAVAILABLE";
    return { result: "FAILED", refusal: { code, reason: error instanceof ChannelError ? `${error.channel}_${error.code}` : GATE_REASON.SEND_FAILED } };
  }
}

/** Frees the claim of a send that never reached the provider (a retry of the event may send). */
function releaseClaimOp(worldId: string, messageId: string): WriteOp {
  return { kind: "delete", table: "Runtime", key: keys.runtime(worldId, "SEND", messageId), condition: cond.notExists("providerMessageId") };
}

async function unknownDelivery(deps: OutboundDeps, input: DispatchInput, staged: StagedMessage, call: OutboundCall, tapeId: string): Promise<GateRefused> {
  const { request, ctx, messageId } = input;
  await settleMessage(deps.chains.connector, staged, { status: "UNKNOWN_DELIVERY", tapeRef: tapeId });
  await deps.chains.connector.audit.append({
    worldId: request.worldId,
    epoch: ctx.epoch,
    auditId: newIdOf(deps.chains, "aud"),
    ts: ctx.realNow.toISOString(),
    atSim: ctx.simNow.toISOString(),
    action: GATE_AUDIT.UNKNOWN_DELIVERY,
    actor: call.actor,
    refs: { messageId, channel: request.channel, kind: request.kind },
    primaryRef: request.complaintId === undefined ? `CUS#${request.customerId}` : `CMP#${request.complaintId}`,
    outcome: "HUMAN_REVIEW",
  });
  call.log.error("outbound.unknown_delivery", { channel: request.channel, kind: request.kind });
  return { ok: false, messageId, tapeId, ruleIds: [], failure: fail("UNKNOWN_DELIVERY", "this message may have gone out already: a person checks it, it is never sent again blindly") };
}

/** Steps 5 to 9. */
export async function dispatch(deps: OutboundDeps, input: DispatchInput, call: OutboundCall): Promise<GateOutcome> {
  const { request, ctx, decision, messageId } = input;
  const { connector } = deps.chains;
  const refused = await fenced(deps, input, call);
  if (refused !== undefined) return refused;
  if (request.channel === "EMAIL" && !(await takeMailCap(connector, request.worldId, ctx.realNow))) {
    call.log.warn("outbound.mail_cap", { metric: "GuestMailCapHits" });
    return blockWith(deps, input, call, GATE_RULE.MAIL_CAP, "UNAVAILABLE", GATE_REASON.MAIL_CAP, "this environment reached its email limit for today; a person follows up");
  }
  const attachments = await attachmentsOf(deps, request, ctx, input.debt);
  const phone = request.channel === "WHATSAPP" ? await deps.recipients.whatsAppNumber(request.worldId, request.customerId, ctx.mode) : undefined;
  if (request.channel === "WHATSAPP" && phone === undefined) return blockWith(deps, input, call, RECIPIENT_FENCE_RULE, "RECIPIENT_NOT_ALLOWED", GATE_REASON.NO_RECIPIENT, "the customer has no WhatsApp number in this world");
  const staged = await stage(deps, input, phone);
  const allowed = await appendTape(
    deps,
    {
      worldId: request.worldId,
      epoch: ctx.epoch,
      atSim: ctx.simNow.toISOString(),
      decision: "ALLOWED",
      ruleIds: decision.ruleIds,
      evaluated: decision.evaluated,
      ruleSetVersion: decision.ruleSetVersion,
      sender: request.sender,
      channel: request.channel,
      kind: request.kind,
      customerId: request.customerId,
      payloadHash: payloadHashOf(renderedPayload(staged.prepared, attachments)),
      messageId,
      ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }),
      ...(request.rerouteOf === undefined ? {} : { rerouteOf: request.rerouteOf }),
    },
    call.log,
  );
  const claim = await connector.claims.claimSend(request.worldId, messageId, request.channel);
  if (claim.status === "SENT") {
    await settleMessage(connector, staged.staged, { status: "SENT", providerMessageId: claim.providerMessageId, tapeRef: allowed.tapeId });
    return { ok: true, decision: "ALLOWED", messageId, tapeId: allowed.tapeId, ruleIds: decision.ruleIds, providerMessageId: claim.providerMessageId };
  }
  if (claim.status === "UNKNOWN_DELIVERY") return unknownDelivery(deps, input, staged.staged, call, allowed.tapeId);
  const sent = await transport(deps, input, staged, attachments, phone);
  const dispatchEntry = { worldId: request.worldId, epoch: ctx.epoch, atSim: ctx.simNow.toISOString(), decision: "DISPATCH" as const, ruleIds: [], ruleSetVersion: decision.ruleSetVersion, sender: request.sender, channel: request.channel, kind: request.kind, customerId: request.customerId, messageId, ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }) };
  if (sent.result === "UNKNOWN_DELIVERY") {
    await appendTape(deps, { ...dispatchEntry, result: "UNKNOWN_DELIVERY" }, call.log);
    return unknownDelivery(deps, input, staged.staged, call, allowed.tapeId);
  }
  if (sent.result === "FAILED" || sent.providerMessageId === undefined) {
    await connector.write(releaseClaimOp(request.worldId, messageId));
    await settleMessage(connector, staged.staged, { status: "FAILED", tapeRef: allowed.tapeId });
    await appendTape(deps, { ...dispatchEntry, result: "FAILED" }, call.log);
    call.log.error("outbound.send_failed", { channel: request.channel, kind: request.kind, reason: sent.refusal?.reason });
    const code = sent.refusal?.code ?? "UNAVAILABLE";
    return { ok: false, messageId, tapeId: allowed.tapeId, ruleIds: [], failure: fail(code, "the message could not be sent; try again later or escalate", sent.refusal?.reason ?? GATE_REASON.SEND_FAILED) };
  }
  await connector.write(connector.claims.recordSendOp(request.worldId, messageId, sent.providerMessageId));
  await settleMessage(connector, staged.staged, { status: sent.status ?? "SENT", providerMessageId: sent.providerMessageId, sentAtSim: ctx.simNow.toISOString(), tapeRef: allowed.tapeId });
  await appendTape(deps, { ...dispatchEntry, result: "SENT", providerMessageId: sent.providerMessageId }, call.log);
  return { ok: true, decision: "ALLOWED", messageId, tapeId: allowed.tapeId, ruleIds: decision.ruleIds, providerMessageId: sent.providerMessageId, ...(sent.mailId === undefined ? {} : { mailId: sent.mailId }) };
}
