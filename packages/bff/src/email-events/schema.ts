// The edge of `EmailEvents` (docs/architecture-integrations.md §2): the SES configuration-set event
// as EventBridge delivers it, validated with zod, and the `EMAIL_EVENT` payload the worker receives.
// Only the fields this app uses are read; recipients and headers never leave this module (PII).
import { z } from "zod";
import { IsoInstant, WorldId } from "@reclamo/shared";
import { type EmailEventType, EmailEventType as EmailEventTypeSchema } from "../domain/conversation";
import { CustomerId, Epoch, Id } from "../domain/common";

/** `detail-type` of each configuration-set event this app publishes (no `Open` nor `Click`). */
export const DETAIL_TYPES: Readonly<Record<string, EmailEventType>> = {
  "Email Sent": "SEND",
  "Email Delivered": "DELIVERY",
  "Email Bounced": "BOUNCE",
  "Email Complaint Received": "COMPLAINT",
  "Email Rejected": "REJECT",
  "Email Delivery Delayed": "DELIVERY_DELAY",
  "Email Rendering Failed": "RENDERING_FAILURE",
};

export const BounceType = z.enum(["Permanent", "Transient", "Undetermined"]);
export type BounceType = z.infer<typeof BounceType>;

/** An SES message id: what `SendEmail` returned and `ByProviderMessageId` indexes. */
export const SesMessageId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);

const Tags = z.record(z.string().max(256), z.array(z.string().max(256)).max(5)).default({});

export const SesEventBridgeEvent = z.looseObject({
  source: z.literal("aws.ses"),
  account: z.string().regex(/^\d{12}$/),
  "detail-type": z.string().max(80),
  time: IsoInstant,
  detail: z.looseObject({
    mail: z.looseObject({
      messageId: SesMessageId,
      sendingAccountId: z.string().regex(/^\d{12}$/).optional(),
      tags: Tags,
    }),
    bounce: z.looseObject({ bounceType: BounceType, timestamp: IsoInstant.optional() }).optional(),
    complaint: z.looseObject({ timestamp: IsoInstant.optional() }).optional(),
    delivery: z.looseObject({ timestamp: IsoInstant.optional(), smtpResponse: z.string().optional() }).optional(),
    deliveryDelay: z.looseObject({ timestamp: IsoInstant.optional(), delayType: z.string().max(80).optional() }).optional(),
  }),
});
export type SesEventBridgeEvent = z.infer<typeof SesEventBridgeEvent>;

export interface SesMailEvent {
  readonly type: EmailEventType;
  readonly account: string;
  readonly sendingAccountId?: string;
  readonly providerMessageId: string;
  readonly bounceType?: BounceType;
  readonly occurredAtReal: string;
  readonly smtpResponse?: string;
  readonly tags: Readonly<Record<string, readonly string[]>>;
}

export type SesEventParse = { readonly ok: true; readonly event: SesMailEvent } | { readonly ok: false; readonly reason: "INVALID_EVENT" | "UNSUPPORTED_TYPE" };

/** One tag value, or `undefined` when the tag is absent or carries more than one value. */
export function singleTag(tags: Readonly<Record<string, readonly string[]>>, name: string): string | undefined {
  const values = tags[name];
  return values !== undefined && values.length === 1 ? values[0] : undefined;
}

const SMTP_RESPONSE_MAX = 200;

export function parseSesEvent(raw: unknown): SesEventParse {
  const parsed = SesEventBridgeEvent.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "INVALID_EVENT" };
  const event = parsed.data;
  const type = DETAIL_TYPES[event["detail-type"]];
  if (type === undefined) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  const { detail } = event;
  if (type === "BOUNCE" && detail.bounce === undefined) return { ok: false, reason: "INVALID_EVENT" };
  const stamp = detail.bounce?.timestamp ?? detail.complaint?.timestamp ?? detail.delivery?.timestamp ?? detail.deliveryDelay?.timestamp ?? event.time;
  const smtp = type === "DELIVERY" ? detail.delivery?.smtpResponse : undefined;
  return {
    ok: true,
    event: {
      type,
      account: event.account,
      ...(detail.mail.sendingAccountId === undefined ? {} : { sendingAccountId: detail.mail.sendingAccountId }),
      providerMessageId: detail.mail.messageId,
      ...(type === "BOUNCE" && detail.bounce !== undefined ? { bounceType: detail.bounce.bounceType } : {}),
      occurredAtReal: new Date(stamp).toISOString(),
      ...(smtp === undefined ? {} : { smtpResponse: smtp.slice(0, SMTP_RESPONSE_MAX) }),
      tags: detail.mail.tags,
    },
  };
}

/** The payload of an `EMAIL_EVENT` in a customer queue: ids and facts, never an address. */
export const EmailEventPayload = z
  .object({
    worldId: WorldId,
    epoch: Epoch,
    customerId: CustomerId,
    complaintId: Id.optional(),
    mailId: Id,
    /** Sort part of the record's key (`MAIL#<sentAtSim>#<mailId>`). */
    sentAtSim: IsoInstant,
    providerMessageId: SesMessageId,
    type: EmailEventTypeSchema,
    bounceType: BounceType.optional(),
    occurredAtReal: IsoInstant,
    smtpResponse: z.string().max(SMTP_RESPONSE_MAX).optional(),
  })
  .strict();
export type EmailEventPayload = z.infer<typeof EmailEventPayload>;

/** What `EmailEvents` hands the single queue producer (worker/enqueue.ts `enqueueCustomerEvent`). */
export interface EmailEventMessage {
  readonly type: "EMAIL_EVENT";
  readonly eventId: string;
  readonly worldId: string;
  readonly customerId: string;
  readonly payload: EmailEventPayload;
}

export type EmailEventEnqueue = (message: EmailEventMessage) => Promise<void>;
