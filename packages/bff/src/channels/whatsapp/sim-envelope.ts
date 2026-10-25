// The phone simulator's envelope (docs/architecture-integrations.md §3.2, docs/architecture.md §13):
// the BFF (`kid = console`, `SimEnvelopeKey`) and the `QaDriver` (`kid = qa`, `QaSimEnvelopeKey`)
// build exactly the SNS record End User Messaging Social publishes — `from` = the persona's phone,
// `id = wamid.SIM.<…>`, `metaPhoneNumberId = simulated` — with `EventSource = reclamo:sim`, and sign
// `{kid, worldId, ts, sha256(Message)}` with HMAC-SHA256. `InboundWhatsApp` accepts it only when the
// signature verifies with the key of its `kid`, that key is valid for the class of the target world
// (`SIM_KEY_WORLD_MISMATCH` otherwise), `ts` is within five real minutes and the world is simulated.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { WorldId, worldKindOf } from "@reclamo/shared";
import { type SecretKey, hmacSha256Base64Url, safeEqual, sha256Hex, ulid } from "../../lib/crypto";
import { SIMULATED_PHONE_NUMBER_ID, SIM_ATTRIBUTES, SIM_ENVELOPE_MAX_AGE_MS, SIM_EVENT_SOURCE, SIM_WAMID_PREFIX, STAGE_ACCOUNT_ID } from "./config";
import type { ParsedEnvelope, SnsRecord, WhatsAppSnsEvent } from "./payloads";

/** Who signed the envelope: the console's simulator (BFF) or the QA driver. */
export const SimKeyId = z.enum(["console", "qa"]);
export type SimKeyId = z.infer<typeof SimKeyId>;

/** The worlds each key may write to (docs/architecture.md §13); nothing else ever accepts it. */
export function simKeyAllows(kid: SimKeyId, worldId: string): boolean {
  const kind = worldKindOf(worldId);
  if (kid === "console") return kind === "DEMO" || kind === "GUEST" || (kind === "QA" && worldId !== "qamin");
  return kind === "QA" || kind === "SIM";
}

/** `SIM<32 hex>`: alphanumeric like a Meta media id, so the live schema needs no exception. */
export const SIM_MEDIA_ID = /^SIM[0-9a-f]{32}$/;

export function newSimMediaId(random: (size: number) => Uint8Array = randomBytes): string {
  return `SIM${Buffer.from(random(16)).toString("hex")}`;
}

/** What the customer does on the simulated phone, already resolved to nonces and media ids by the caller. */
export type SimulatedContent =
  | { readonly type: "text"; readonly text: string }
  /** Quick reply of a template: the nonce travels as `payload`. */
  | { readonly type: "template_reply"; readonly nonce: string; readonly title: string }
  /** Reply button of an interactive message. */
  | { readonly type: "button_reply"; readonly nonce: string; readonly title: string }
  /** Row of an interactive list (`CHOOSE_LOAN`). */
  | { readonly type: "list_reply"; readonly nonce: string; readonly title: string }
  /** An image whose `SIMMEDIA#<id>` the caller wrote; never downloaded from Meta. */
  | { readonly type: "image"; readonly simMediaId: string; readonly mimeType: "image/jpeg" | "image/png"; readonly caption?: string }
  /** A document the adapter answers with its fixed reply and never downloads (FL-029). */
  | { readonly type: "document"; readonly simMediaId: string; readonly mimeType: "application/pdf" };

export interface SimulatedMessageInput {
  readonly kid: SimKeyId;
  readonly worldId: string;
  /** The persona's phone (E.164). */
  readonly from: string;
  readonly wamid: string;
  readonly content: SimulatedContent;
  /** The `wamid` of our message the customer answers (a button reply). */
  readonly contextWamid?: string;
  /** Real instant of the tap or the text: the `ts` of the signature. */
  readonly at: Date;
}

/** `wamid.SIM.<ULID>` for the console's simulator. */
export function newSimulatedWamid(nowMs: number): string {
  return `${SIM_WAMID_PREFIX}${ulid(nowMs)}`;
}

/** `wamid.SIM.<sha256(idempotencyKey)>` for the `QaDriver`: a retried step sends the same message. */
export function qaSimulatedWamid(idempotencyKey: string): string {
  return `${SIM_WAMID_PREFIX}${sha256Hex(idempotencyKey)}`;
}

function messageOf(input: SimulatedMessageInput): Record<string, unknown> {
  const base = {
    from: input.from.replace(/^\+/, ""),
    id: input.wamid,
    timestamp: String(Math.floor(input.at.getTime() / 1_000)),
    ...(input.contextWamid === undefined ? {} : { context: { from: SIMULATED_PHONE_NUMBER_ID, id: input.contextWamid } }),
  };
  const content = input.content;
  switch (content.type) {
    case "text":
      return { ...base, type: "text", text: { body: content.text } };
    case "template_reply":
      return { ...base, type: "button", button: { payload: content.nonce, text: content.title } };
    case "button_reply":
      return { ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: content.nonce, title: content.title } } };
    case "list_reply":
      return { ...base, type: "interactive", interactive: { type: "list_reply", list_reply: { id: content.nonce, title: content.title } } };
    case "image":
      if (!SIM_MEDIA_ID.test(content.simMediaId)) throw new RangeError("a simulated image needs a SIM<32 hex> media id");
      return { ...base, type: "image", image: { id: content.simMediaId, mime_type: content.mimeType, ...(content.caption === undefined ? {} : { caption: content.caption }) } };
    case "document":
      if (!SIM_MEDIA_ID.test(content.simMediaId)) throw new RangeError("a simulated document needs a SIM<32 hex> media id");
      return { ...base, type: "document", document: { id: content.simMediaId, mime_type: content.mimeType } };
  }
}

/** The EUM envelope (`Sns.Message`) of one simulated message, with the same shape as a live one. */
export function simulatedEnvelopeMessage(input: SimulatedMessageInput): string {
  const entry = {
    id: SIMULATED_PHONE_NUMBER_ID,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: SIMULATED_PHONE_NUMBER_ID },
          contacts: [{ wa_id: input.from.replace(/^\+/, "") }],
          messages: [messageOf(input)],
        },
      },
    ],
  };
  return JSON.stringify({
    context: { MetaWabaIds: [], MetaPhoneNumberIds: [{ metaPhoneNumberId: SIMULATED_PHONE_NUMBER_ID }] },
    whatsAppWebhookEntry: JSON.stringify(entry),
    aws_account_id: STAGE_ACCOUNT_ID,
    message_timestamp: input.at.toISOString(),
    messageId: sha256Hex(input.wamid).slice(0, 32),
  });
}

/** The signed string: `kid`, world, `ts` and the SHA-256 of the message body, one per line. */
export function simSigningString(kid: string, worldId: string, ts: string, message: string): string {
  return `${kid}\n${worldId}\n${ts}\n${sha256Hex(message)}`;
}

export function signSimulated(key: SecretKey, kid: SimKeyId, worldId: string, ts: string, message: string): string {
  return hmacSha256Base64Url(key, simSigningString(kid, worldId, ts, message));
}

/** The Lambda event `simulator.*` (or the `QaDriver`) hands to `InboundWhatsApp` (`Records[].Sns`). */
export function buildSimulatedEvent(key: SecretKey, input: SimulatedMessageInput): WhatsAppSnsEvent {
  if (!WorldId.safeParse(input.worldId).success) throw new RangeError("invalid world id");
  if (!simKeyAllows(input.kid, input.worldId)) throw new RangeError(`the ${input.kid} key cannot write to ${input.worldId}`);
  const message = simulatedEnvelopeMessage(input);
  const ts = input.at.toISOString();
  const record: SnsRecord = {
    EventSource: SIM_EVENT_SOURCE,
    Sns: {
      Type: "Notification",
      MessageId: sha256Hex(`sns#${input.wamid}`).slice(0, 32),
      TopicArn: SIMULATED_PHONE_NUMBER_ID,
      Message: message,
      Timestamp: ts,
      MessageAttributes: {
        [SIM_ATTRIBUTES.kid]: { Type: "String", Value: input.kid },
        [SIM_ATTRIBUTES.worldId]: { Type: "String", Value: input.worldId },
        [SIM_ATTRIBUTES.ts]: { Type: "String", Value: ts },
        [SIM_ATTRIBUTES.signature]: { Type: "String", Value: signSimulated(key, input.kid, input.worldId, ts, message) },
      },
    },
  };
  return { Records: [record] };
}

/** Keys the receiving Lambda has linked; a `kid` without its key is refused (`SIM_KEY_UNKNOWN`). */
export type SimEnvelopeKeys = Partial<Record<SimKeyId, SecretKey>>;

export const SIM_REJECTIONS = ["SIM_MALFORMED", "SIM_KEY_UNKNOWN", "SIM_SIGNATURE_INVALID", "SIM_KEY_WORLD_MISMATCH", "SIM_EXPIRED"] as const;
export type SimRejection = (typeof SIM_REJECTIONS)[number];

export type SimVerification =
  | { readonly ok: true; readonly kid: SimKeyId; readonly worldId: string }
  | { readonly ok: false; readonly reason: SimRejection; readonly worldId?: string };

/**
 * Checks a simulated record: attributes present, a known `kid` whose key verifies the signature, a
 * world that key may write to, and a `ts` within five real minutes of `now`. The world's mode is the
 * caller's check (registry.ts), since it needs the world's settings.
 */
export function verifySimulatedRecord(record: SnsRecord, keys: SimEnvelopeKeys, now: Date): SimVerification {
  const attribute = (name: string) => record.Sns.MessageAttributes[name]?.Value;
  const kid = SimKeyId.safeParse(attribute(SIM_ATTRIBUTES.kid));
  const worldId = attribute(SIM_ATTRIBUTES.worldId);
  const ts = attribute(SIM_ATTRIBUTES.ts);
  const signature = attribute(SIM_ATTRIBUTES.signature);
  if (record.EventSource !== SIM_EVENT_SOURCE || !kid.success || worldId === undefined || ts === undefined || signature === undefined || !WorldId.safeParse(worldId).success) {
    return { ok: false, reason: "SIM_MALFORMED" };
  }
  const key = keys[kid.data];
  if (key === undefined) return { ok: false, reason: "SIM_KEY_UNKNOWN", worldId };
  if (!safeEqual(signature, signSimulated(key, kid.data, worldId, ts, record.Sns.Message))) return { ok: false, reason: "SIM_SIGNATURE_INVALID", worldId };
  if (!simKeyAllows(kid.data, worldId)) return { ok: false, reason: "SIM_KEY_WORLD_MISMATCH", worldId };
  const signedAt = Date.parse(ts);
  if (Number.isNaN(signedAt) || Math.abs(now.getTime() - signedAt) > SIM_ENVELOPE_MAX_AGE_MS) return { ok: false, reason: "SIM_EXPIRED", worldId };
  return { ok: true, kid: kid.data, worldId };
}

/** Any trace of the simulator: its event source, its attributes, its phone id or a simulated message id. */
export function looksSimulated(record: SnsRecord, parsed?: ParsedEnvelope): boolean {
  if (record.EventSource === SIM_EVENT_SOURCE || Object.values(SIM_ATTRIBUTES).some((name) => record.Sns.MessageAttributes[name] !== undefined)) return true;
  if (parsed === undefined) return false;
  if (parsed.envelope.context.MetaPhoneNumberIds.some((phone) => phone.metaPhoneNumberId === SIMULATED_PHONE_NUMBER_ID)) return true;
  return parsed.changes.some(
    (change) =>
      change.metadata.phone_number_id === SIMULATED_PHONE_NUMBER_ID ||
      change.messages.some((message) => message.id.startsWith(SIM_WAMID_PREFIX)) ||
      change.statuses.some((status) => status.id.startsWith(SIM_WAMID_PREFIX)),
  );
}
