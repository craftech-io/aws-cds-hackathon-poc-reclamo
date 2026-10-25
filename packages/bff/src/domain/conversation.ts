// `Conversations/W#<w>#CONV#<customerId>` (docs/architecture.md §5): one conversation per customer
// with its control (agent or operator), identification window, messages (in and out, normalized and
// masked before they are stored), provider events, turn notes and the emails sent to the customer.
import { z } from "zod";
import { Channel, IsoInstant, MessageKind, Sender, TurnTrigger, WorldId } from "@reclamo/shared";
import { Actor, CustomerId, Id, JsonObject, StaffId, Stamps, Versioned } from "./common";
import { HumanTask } from "./case-items";
import { Control, DeliveryProof } from "./complaint";

export const ControlChange = z.object({ from: Control, to: Control, atSim: IsoInstant, by: Actor });
export type ControlChange = z.infer<typeof ControlChange>;

export const ConversationMeta = z.object({
  worldId: WorldId,
  customerId: CustomerId,
  control: Control,
  controlledBy: StaffId.optional(),
  controlHistory: z.array(ControlChange),
  identifiedAtReal: IsoInstant.optional(),
  /** 30 real minutes: neither a paused world extends it nor a compressed clock shortens it. */
  identifiedUntilReal: IsoInstant.optional(),
  /** End of the 24 h window the customer opened (simulated clock in `simulated` mode). */
  windowOpenUntilSim: IsoInstant.optional(),
  lastInboundAtSim: IsoInstant.optional(),
  sessionEpoch: z.number().int().nonnegative(),
  /** Session epochs whose first outbound already carried the automation disclosure. */
  disclosedEpochs: z.array(z.number().int().nonnegative()),
  openComplaintIds: z.array(Id),
  /** Last event lost to the dead-letter queue (docs/architecture.md §7). */
  processError: z.object({ eventId: Id, type: z.string().max(40), atReal: IsoInstant }).optional(),
  ...Versioned,
});
export type ConversationMeta = z.infer<typeof ConversationMeta>;

export const MessageDirection = z.enum(["IN", "OUT"]);

export const MessageStatus = z.enum(["RECEIVED", "PENDING", "SENT", "DELIVERED", "READ", "FAILED", "BLOCKED", "DEFERRED", "UNKNOWN_DELIVERY"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const MessageMedia = z.object({
  announceKey: z.string().max(512).optional(),
  s3Key: z.string().max(512).optional(),
  scan: z.string().max(40).optional(),
  contentType: z.enum(["image/jpeg", "image/png"]).optional(),
});

export const Message = z.object({
  worldId: WorldId,
  customerId: CustomerId,
  messageId: Id,
  direction: MessageDirection,
  channel: Channel,
  kind: MessageKind.optional(),
  sender: Sender.optional(),
  /** Normalized and masked text (channels/normalizer.ts); never a raw provider payload. */
  body: z.string().max(4_096),
  templateName: z.string().max(80).optional(),
  templateParams: z.array(z.string().max(300)).max(10).optional(),
  interactive: JsonObject.optional(),
  media: MessageMedia.optional(),
  providerMessageId: z.string().min(1).max(256).optional(),
  status: MessageStatus,
  tapeRef: Id.optional(),
  turnId: Id.optional(),
  triggerEventId: Id.optional(),
  complaintId: Id.optional(),
  flags: z.object({ disclosure: z.boolean().optional() }).default({}),
  /** The scores G2 gave the free text it let through (`outbound/prepare.ts`): what calibrates ADR-0008. */
  g2: z.object({ groundingScore: z.number().min(0).max(1).optional(), relevanceScore: z.number().min(0).max(1).optional() }).optional(),
  simulated: z.boolean(),
  /** Simulated instant that orders the thread. */
  atSim: IsoInstant,
  sentAtSim: IsoInstant.optional(),
  ...Versioned,
});
export type Message = z.infer<typeof Message>;

/** A provider event (WhatsApp status, simulated or live) of a message. */
export const MessageEvent = z.object({
  worldId: WorldId,
  customerId: CustomerId,
  eventId: Id,
  messageId: Id.optional(),
  providerMessageId: z.string().min(1).max(256).optional(),
  type: z.string().min(1).max(40),
  atReal: IsoInstant,
  atSim: IsoInstant.optional(),
  detail: JsonObject.optional(),
  ...Stamps,
});
export type MessageEvent = z.infer<typeof MessageEvent>;

/** The final text of a turn: kept for the case view, never sent. */
export const TurnNote = z.object({
  worldId: WorldId,
  customerId: CustomerId,
  turnId: Id,
  atSim: IsoInstant,
  trigger: TurnTrigger.optional(),
  text: z.string().max(8_000),
  refs: z.array(z.string().max(200)).max(50),
  stopReason: z.string().max(40).optional(),
  ...Stamps,
});
export type TurnNote = z.infer<typeof TurnNote>;

/** A human task on a conversation without a complaint (a reroute to the human queue, a handoff before registering). */
export const ConversationTask = z.object({
  worldId: WorldId,
  customerId: CustomerId,
  taskId: Id,
  atSim: IsoInstant,
  author: Actor,
  text: z.string().max(2_000),
  task: HumanTask,
  ...Stamps,
});
export type ConversationTask = z.infer<typeof ConversationTask>;

export const EmailEventType = z.enum(["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "RENDERING_FAILURE"]);
export type EmailEventType = z.infer<typeof EmailEventType>;

export const EmailAttachment = z.object({ docKind: z.string().min(1).max(40), s3Key: z.string().max(512), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** An email sent through SES (`MAIL#`): the raw `.eml` and its view render live in S3 `Emails`. */
export const EmailRecord = z.object({
  worldId: WorldId,
  customerId: CustomerId,
  mailId: Id,
  messageId: Id.optional(),
  complaintId: Id.optional(),
  kind: MessageKind,
  /** Masked recipient; the address in clear never reaches this table. */
  toMasked: z.string().min(1).max(200),
  subject: z.string().max(300),
  s3RawKey: z.string().max(512),
  s3RenderKey: z.string().max(512).optional(),
  rawSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  attachments: z.array(EmailAttachment).max(10),
  providerMessageId: z.string().min(1).max(256).optional(),
  events: z.array(z.object({ type: EmailEventType, atReal: IsoInstant, detail: JsonObject.optional() })),
  deliveryProof: DeliveryProof.optional(),
  sentAtSim: IsoInstant,
  ...Versioned,
});
export type EmailRecord = z.infer<typeof EmailRecord>;
