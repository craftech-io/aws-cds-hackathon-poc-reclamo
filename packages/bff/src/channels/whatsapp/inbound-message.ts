// One message of a customer, in the order docs/design-brief.md §5 fixes for `CUSTOMER_MESSAGE`, all of
// it without the model: the world (the simulated envelope's, or `LIVEPHONE#` for a live sender, never
// anything else), the world's mode, idempotency by `wamid` (FL-106), identity by the linked phone
// (FL-002), the world's limit per REAL hour (FL-105), the customer's window (FL-001), button nonces
// (FL-005, FL-060), opt-out and the ambiguous "baja" (FL-006), media into `Media` (FL-029, FL-103) and
// the text masked by channels/normalizer.ts before it is stored. What follows goes to the ports: the
// intake (classifier, number, acknowledgement, turn), a fixed reply through the gate, a button effect.
import { addressHash } from "@reclamo/shared";
import type { WorldMeta } from "../../domain/world";
import { worldClock } from "../../lib/clock";
import { normalizeInboundText } from "../normalizer";
import { DEFAULT_RATE_LIMIT_PER_HOUR, type InboundDelivery, admitInbound, completeInbound, firstNoticeOfHour } from "../rate-limit";
import { commandOf } from "./buttons";
import { INBOUND_IDEMPOTENCY_SOURCE, RATE_NOTICE_SOURCE } from "./config";
import { fetchLiveImage, imageOf, resolveSimulatedImage, type MediaOutcome } from "./media";
import { consumeNonce, resolveNonce } from "./nonces";
import { BAJA_CHOICE, keywordIntent } from "./opt-out";
import { type WaInboundMessage, e164Of, instantOf, tappedButtonOf } from "./payloads";
import type { FixedReplyRequest, InboundCustomerMessage, MessageResult, WhatsAppInboundDeps } from "./ports";
import { appendInbound, derivedMessageId, openWindow, receiptInstant, recordDecision } from "./records";
import { worldModeRejection, worldWhatsAppMode } from "./registry";

export interface MessageContext {
  readonly deps: WhatsAppInboundDeps;
  readonly origin: "LIVE" | "SIMULATED";
  /** The envelope's world (simulated only). */
  readonly envelopeWorldId?: string;
  /** `message_timestamp` of the envelope: when the provider (or the simulator) handed the message over. */
  readonly envelopeAt?: string;
}

/** A sender resolved to a customer of a world, at one simulated instant. */
interface Sender {
  readonly world: WorldMeta;
  readonly customerId: string;
  readonly phoneHash: string;
  readonly atSim: string;
  readonly now: Date;
  readonly messageId: string;
}

const deliveryOf = (message: WaInboundMessage): InboundDelivery => ({ source: INBOUND_IDEMPOTENCY_SOURCE, id: message.id });

async function worldOf(ctx: MessageContext, phoneHash: string, now: Date): Promise<string | undefined> {
  if (ctx.origin === "SIMULATED") return ctx.envelopeWorldId;
  // Live: only `LIVEPHONE#` (the same hash exists in `demo` and in every guest world).
  const live = await ctx.deps.data.claims.getLivePhone(phoneHash);
  if (live === undefined || (live.leaseUntilReal !== undefined && Date.parse(live.leaseUntilReal) <= now.getTime())) return undefined;
  return live.worldId;
}

type ReplyInput = Omit<FixedReplyRequest, "messageId" | "inReplyTo" | "kind"> & { readonly kind?: FixedReplyRequest["kind"]; readonly wamid: string; readonly sourceMessageId?: string };

/** A fixed reply to the message `wamid`; its id is derived, so a redelivery never sends it twice. */
function reply(ctx: MessageContext, input: ReplyInput): Promise<void> {
  const { wamid, sourceMessageId, kind, ...request } = input;
  return ctx.deps.replies.send({
    ...request,
    kind: kind ?? "REPLY",
    messageId: derivedMessageId(input.worldId, wamid, "re"),
    inReplyTo: { wamid, ...(sourceMessageId === undefined ? {} : { messageId: sourceMessageId }) },
  });
}

interface StoreExtra {
  readonly interactive?: Record<string, string>;
  readonly media?: Extract<MediaOutcome, { accepted: true }>;
  /** Why an image or a file was not taken (`UNSUPPORTED_TYPE`, `TOO_LARGE`…). */
  readonly rejectedMedia?: string;
}

async function store(ctx: MessageContext, sender: Sender, message: WaInboundMessage, body: string, extra: StoreExtra = {}): Promise<void> {
  await appendInbound(ctx.deps.data, {
    worldId: sender.world.worldId,
    customerId: sender.customerId,
    messageId: sender.messageId,
    wamid: message.id,
    body,
    simulated: ctx.origin === "SIMULATED",
    atSim: sender.atSim,
    ...(extra.interactive === undefined ? {} : { interactive: extra.interactive }),
    ...(extra.media === undefined ? {} : { media: { announceKey: extra.media.announceKey, s3Key: extra.media.s3Key, contentType: extra.media.contentType, scan: "PENDING" } }),
    ...(extra.rejectedMedia === undefined ? {} : { media: { scan: extra.rejectedMedia } }),
  });
}

function result(sender: Sender, message: WaInboundMessage, outcome: MessageResult["outcome"], more: Partial<MessageResult> = {}): MessageResult {
  return { wamid: message.id, outcome, worldId: sender.world.worldId, customerId: sender.customerId, messageId: sender.messageId, ...more };
}

async function media(ctx: MessageContext, sender: Sender, message: WaInboundMessage, image: { id: string; contentType: "image/jpeg" | "image/png" }): Promise<MediaOutcome> {
  const { deps } = ctx;
  const worldId = sender.world.worldId;
  if (ctx.origin === "SIMULATED") return resolveSimulatedImage({ bucket: deps.bucket, data: deps.data, realClock: deps.realClock }, { worldId, messageId: sender.messageId, simMediaId: image.id });
  if (deps.liveMedia === undefined) return { accepted: false, reply: "IMAGE_NOT_PROCESSED", reason: "MEDIA_KEY_UNRESOLVED" };
  return fetchLiveImage({ ...deps.liveMedia, bucket: deps.bucket, data: deps.data, realClock: deps.realClock }, { worldId, wamid: message.id, mediaId: image.id, contentType: image.contentType });
}

/** Text, buttons, keywords and media of an admitted message of a known customer. */
async function content(ctx: MessageContext, sender: Sender, message: WaInboundMessage): Promise<MessageResult> {
  const { deps } = ctx;
  const worldId = sender.world.worldId;
  const base = { worldId, customerId: sender.customerId, sourceMessageId: sender.messageId, atSim: sender.atSim };
  const replyBase = { worldId, customerId: sender.customerId, phoneHash: sender.phoneHash, waId: message.from, atSim: sender.atSim, wamid: message.id, sourceMessageId: sender.messageId };
  const tapped = tappedButtonOf(message);
  let refusedButton = false;
  if (tapped !== undefined) {
    const resolution = await resolveNonce(deps.data, { worldId, value: tapped.nonce, phoneHash: sender.phoneHash, customerId: sender.customerId, now: sender.now });
    if (resolution.ok) {
      const command = commandOf(resolution.nonce);
      await store(ctx, sender, message, normalizeInboundText(tapped.title, worldId).text, { interactive: { action: resolution.nonce.action, resolved: "true", nonce: resolution.nonce.nonce } });
      let outcome: MessageResult;
      if (command.kind === "HANDOFF") {
        await deps.effects.handoff({ ...base, reason: command.reason, ...(command.complaintId === undefined ? {} : { complaintId: command.complaintId }) });
        outcome = result(sender, message, "HANDOFF");
      } else if (command.kind === "OPT_OUT") {
        await deps.effects.optOut({ ...base, via: "BUTTON" });
        await reply(ctx, { ...replyBase, kind: "OPT_OUT_CONFIRMATION", textKey: "OPT_OUT_CONFIRMATION" });
        outcome = result(sender, message, "OPTED_OUT");
      } else if (command.kind === "EMAIL_CONSENT") {
        await deps.effects.emailConsent({ ...base, accepted: command.accepted, ...(command.complaintId === undefined ? {} : { complaintId: command.complaintId }) });
        outcome = result(sender, message, "EMAIL_CONSENT");
      } else {
        const button = { action: command.action, ...(command.complaintId === undefined ? {} : { complaintId: command.complaintId }), ...(command.loanId === undefined ? {} : { loanId: command.loanId }) };
        const intake = await deps.intake.accept(intakeMessage(ctx, sender, message, normalizeInboundText(tapped.title, worldId), { button }));
        outcome = result(sender, message, "INTAKE", { intake: intake.outcome });
      }
      await consumeNonce(deps.data, resolution.nonce);
      return outcome;
    }
    refusedButton = true;
    await recordDecision(deps.data, { worldId, epoch: sender.world.epoch, action: "DENY", outcome: resolution.reason, wamid: message.id, at: sender.now, atSim: sender.atSim, customerId: sender.customerId });
  }
  const raw = tapped?.title ?? message.text?.body ?? message.image?.caption ?? "";
  const text = normalizeInboundText(raw, worldId);
  if (tapped !== undefined || message.type === "text") {
    const intent = keywordIntent(raw);
    if (intent === "OPT_OUT") {
      await store(ctx, sender, message, text.text);
      await deps.effects.optOut({ ...base, via: "KEYWORD" });
      await reply(ctx, { ...replyBase, kind: "OPT_OUT_CONFIRMATION", textKey: "OPT_OUT_CONFIRMATION" });
      return result(sender, message, "OPTED_OUT");
    }
    if (intent === "BAJA_AMBIGUOUS") {
      await store(ctx, sender, message, text.text);
      await reply(ctx, { ...replyBase, textKey: "BAJA_AMBIGUOUS", buttons: BAJA_CHOICE });
      return result(sender, message, "BAJA_CHOICE");
    }
    await store(ctx, sender, message, text.text);
    const intake = await deps.intake.accept(intakeMessage(ctx, sender, message, text, refusedButton ? { refusedButton } : {}));
    return result(sender, message, "INTAKE", { intake: intake.outcome });
  }
  const image = imageOf(message);
  if (image === undefined && message.type === "reaction") return result(sender, message, "IGNORED");
  const outcome: MediaOutcome = image === undefined || image === "UNSUPPORTED" ? { accepted: false, reply: "MEDIA_UNSUPPORTED", reason: "UNSUPPORTED_TYPE" } : await media(ctx, sender, message, image);
  if (!outcome.accepted) {
    await store(ctx, sender, message, text.text, { rejectedMedia: outcome.reason });
    if (outcome.reason === "MEDIA_KEY_UNRESOLVED") await recordDecision(deps.data, { worldId, epoch: sender.world.epoch, action: "MEDIA_KEY_UNRESOLVED", outcome: "IMAGE_NOT_PROCESSED", wamid: message.id, at: sender.now, customerId: sender.customerId, messageId: sender.messageId });
    await reply(ctx, { ...replyBase, kind: "RECEIPT_REQUEST", textKey: outcome.reply });
    return result(sender, message, "MEDIA_REJECTED", { reason: outcome.reason });
  }
  await store(ctx, sender, message, text.text, { media: outcome });
  const intake = await deps.intake.accept(intakeMessage(ctx, sender, message, text, { media: outcome }));
  return result(sender, message, "INTAKE", { intake: intake.outcome });
}

function intakeMessage(ctx: MessageContext, sender: Sender, message: WaInboundMessage, text: InboundCustomerMessage["text"], extra: Pick<InboundCustomerMessage, "button" | "refusedButton" | "media">): InboundCustomerMessage {
  return {
    worldId: sender.world.worldId,
    epoch: sender.world.epoch,
    customerId: sender.customerId,
    phoneHash: sender.phoneHash,
    origin: ctx.origin,
    wamid: message.id,
    messageId: sender.messageId,
    atSim: sender.atSim,
    receivedAtReal: sender.now.toISOString(),
    eventAtReal: ctx.envelopeAt !== undefined && !Number.isNaN(Date.parse(ctx.envelopeAt)) ? new Date(ctx.envelopeAt).toISOString() : instantOf(message.timestamp),
    text,
    ...extra,
  };
}

/** Everything up to an admitted message of a known customer; the rest is `content`. */
async function admit(ctx: MessageContext, message: WaInboundMessage, now: Date): Promise<MessageResult> {
  const { deps } = ctx;
  const phoneHash = await addressHash("WHATSAPP", e164Of(message.from), deps.keys.phoneHash);
  const worldId = await worldOf(ctx, phoneHash, now);
  if (worldId === undefined) {
    deps.log.warn("inbound_whatsapp.no_live_world", { metric: "WhatsAppNoLiveWorld" });
    return { wamid: message.id, outcome: "NO_LIVE_WORLD" };
  }
  const [world, settings] = await Promise.all([deps.data.worlds.getMeta(worldId, { consistent: true }), deps.data.worlds.getSettings(worldId)]);
  if (world === undefined) {
    deps.log.warn("inbound_whatsapp.rejected", { metric: "WhatsAppInboundRejected", reason: "WORLD_UNKNOWN" });
    return { wamid: message.id, outcome: "REJECTED", reason: "WORLD_UNKNOWN" };
  }
  const mode = worldWhatsAppMode(worldId, settings, deps.stageModes);
  const decision = { worldId, epoch: world.epoch, wamid: message.id, at: now };
  const modeRejection = worldModeRejection(ctx.origin, mode);
  if (modeRejection !== undefined) {
    await recordDecision(deps.data, { ...decision, action: "INBOUND_REJECTED", outcome: modeRejection });
    return { wamid: message.id, outcome: "REJECTED", worldId, mode, reason: modeRejection };
  }
  if (world.status !== "READY") {
    await recordDecision(deps.data, { ...decision, action: world.status === "RESETTING" ? "WORLD_RESETTING" : "WORLD_NOT_READY", outcome: "DISCARDED" });
    return { wamid: message.id, outcome: "DISCARDED", worldId, mode, reason: world.status };
  }
  const admission = await admitInbound(deps.data, { worldId, delivery: deliveryOf(message), phoneHash, realNow: now, limitPerHour: settings?.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR });
  if (admission.outcome === "DUPLICATE") return { wamid: message.id, outcome: "DUPLICATE", worldId, mode };
  const simNow = await worldClock(worldId, deps.data.runtime.clockState, deps.realClock).now();
  const atSim = await receiptInstant(deps.data, worldId, message.id, simNow);
  const customer = await deps.customers.findByPhoneHash(worldId, phoneHash);
  const replyBase = { worldId, phoneHash, waId: message.from, atSim, wamid: message.id, ...(customer === undefined ? {} : { customerId: customer.customerId }) };
  if (admission.outcome === "RATE_LIMITED") {
    await recordDecision(deps.data, { ...decision, action: "DENY", outcome: "RATE_LIMIT", atSim, ...(customer === undefined ? {} : { customerId: customer.customerId }), detail: { limit: admission.limit, realHour: admission.realHour } });
    if (await firstNoticeOfHour(deps.data, worldId, RATE_NOTICE_SOURCE, phoneHash, admission.realHour)) await reply(ctx, { ...replyBase, textKey: "RATE_LIMITED" });
    return { wamid: message.id, outcome: "RATE_LIMITED", worldId, mode, ...(customer === undefined ? {} : { customerId: customer.customerId }) };
  }
  if (customer === undefined) {
    await recordDecision(deps.data, { ...decision, action: "DENY", outcome: "UNKNOWN_SENDER", atSim });
    await reply(ctx, { ...replyBase, textKey: "UNKNOWN_SENDER" });
    return { wamid: message.id, outcome: "UNKNOWN_SENDER", worldId, mode };
  }
  await openWindow(deps.data, { worldId, customerId: customer.customerId, atSim });
  const sender: Sender = { world, customerId: customer.customerId, phoneHash, atSim, now, messageId: derivedMessageId(worldId, message.id, "in") };
  return { ...(await content(ctx, sender, message)), mode };
}

/**
 * Processes one inbound message; the same `wamid` does nothing a second time. The `wamid` is marked
 * processed only after its effect is on record: if anything on the way fails, the Lambda fails and the
 * redelivery runs the message again (every write on the way is keyed by the `wamid`).
 */
export async function processInboundMessage(ctx: MessageContext, message: WaInboundMessage): Promise<MessageResult> {
  const now = await ctx.deps.realClock.now();
  const outcome = await admit(ctx, message, now);
  if (outcome.worldId !== undefined && !["DUPLICATE", "REJECTED", "DISCARDED"].includes(outcome.outcome)) {
    await completeInbound(ctx.deps.data, outcome.worldId, deliveryOf(message), { outcome: outcome.outcome, ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }) });
  }
  return outcome;
}
