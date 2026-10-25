// Every event of the customer queues (docs/architecture.md §7), validated with zod at both edges: the
// producer (worker/enqueue.ts, the only one) refuses a malformed event before it becomes a message, and
// the worker parses every body it receives. An event names its world, its customer (the FIFO group is
// `<worldId>#<customerId>`), the world epoch it belongs to (a late event of a reset world is discarded
// against its tombstone) and the simulated instant of its cause (`eventAtSim`, ADR-0011).
//
//   CUSTOMER_MESSAGE         InboundWhatsApp (already identified, classified and acknowledged)
//   RECEIPT_RECEIVED         MediaIntake or InboundWhatsApp (a checked image): the worker files it as
//                            `RECEIPT_IMAGE` evidence of the open complaint, then a turn (worker/receipt.ts)
//   MEDIA_REJECTED           MediaIntake or InboundWhatsApp (threat, failed check, scan not completed,
//                            120 s deadline): the fixed reply the payload names, no turn
//   TIMER                    ScheduleDispatch, advance_clock, console: `fire_timer` by kind
//   SETTLEMENT_PUBLISHED     ScheduleDispatch on a batch publication: reconcile, then a turn
//   TRANSFER_STATUS_CHANGED  a NETWORK_TRANSITION timer: a turn to communicate it; or a FOLLOW_UP timer
//                            of a waiting complaint (`followUp`): a turn to check it again
//   OPERATOR_SEND            Bff: the gate with `sender OPERATOR:<staffId>`, or the reroute it picked
//   OPERATOR_ANSWER          Bff: the operator's written answer (PDF + SES) through the gate
//   APPROVAL_DECIDED         Bff: ONLY the approval's locator; the worker re-reads everything (§8.5)
//   OPERATOR_RELEASED        Bff: a turn with the operator's messages since the take-over
//   ANSWER_DUE, RECONCILE_DUE  the worker itself (obligations after a turn)
//   EMAIL_EVENT              EmailEvents (only enqueues): delivery proof, bounce, complaint
//   WA_STATUS                InboundWhatsApp (live statuses) or the simulated transport
//   HEALTH_PROBE, POISON     QaDriver (`SMK`, FL-108), QA queue only
import { z } from "zod";
import { Channel, CustomerId, Id, IsoInstant, MessageKind, Reroute, StaffId, TimerKind, TurnTrigger, WorldId } from "@reclamo/shared";
import { AnswerAttachment } from "../complaints/answer";
import { TemplateName } from "../copy/types";
import { Epoch } from "../domain/common";
import { EmailEventPayload } from "../email-events/schema";
import { MediaRejectedPayload, ReceiptReceivedPayload } from "../media-intake/schema";
import { WaStatus } from "../channels/whatsapp/payloads";

export const CustomerEventType = z.enum([
  "CUSTOMER_MESSAGE",
  "RECEIPT_RECEIVED",
  "MEDIA_REJECTED",
  "TIMER",
  "SETTLEMENT_PUBLISHED",
  "TRANSFER_STATUS_CHANGED",
  "OPERATOR_SEND",
  "OPERATOR_ANSWER",
  "APPROVAL_DECIDED",
  "OPERATOR_RELEASED",
  "ANSWER_DUE",
  "RECONCILE_DUE",
  "EMAIL_EVENT",
  "WA_STATUS",
  "HEALTH_PROBE",
  "POISON",
]);
export type CustomerEventType = z.infer<typeof CustomerEventType>;

export { EVENT_MAX_LIFE_MS, MAX_RECEIVE_COUNT } from "./queue-limits";

/** `evt-…`, `wa-…`, `email-…`: an id safe in a key and as a `MessageDeduplicationId` (≤ 128). */
export const EventId = Id.refine((value) => value.length <= 128, "an event id has at most 128 characters");

const Common = {
  eventId: EventId,
  worldId: WorldId,
  customerId: CustomerId,
  /** World epoch the event belongs to (a reset raises it and tombstones the old one). */
  epoch: Epoch,
  /** Simulated instant of the cause: every rule of the event is evaluated here (ADR-0011). */
  eventAtSim: IsoInstant,
  /** Born at the inbound edge and carried by every log line of the event. */
  correlationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/).optional(),
};

const event = <T extends string, P extends z.ZodType>(type: T, payload: P) => z.object({ type: z.literal(type), ...Common, payload }).strict();

const OutboundTemplate = z.object({ name: TemplateName, params: z.array(z.string().min(1).max(300)).max(5) }).strict();

/** `recipient_id` is the customer's phone: it never travels in a queue message. */
export const QueuedWaStatus = WaStatus.omit({ recipient_id: true });

export const CustomerMessageEvent = event(
  "CUSTOMER_MESSAGE",
  z.object({ messageId: Id, messageAtSim: IsoInstant, complaintIds: z.array(Id).max(10).default([]) }).strict(),
);
export const ReceiptReceivedEvent = event("RECEIPT_RECEIVED", ReceiptReceivedPayload);
export const MediaRejectedEvent = event("MEDIA_REJECTED", MediaRejectedPayload);
export const TimerEvent = event("TIMER", z.object({ kind: TimerKind, timerId: Id, version: z.number().int().positive(), dueAtSim: IsoInstant }).strict());
export const SettlementPublishedEvent = event("SETTLEMENT_PUBLISHED", z.object({ complaintId: Id, batchKey: z.string().min(1).max(120).optional() }).strict());
/** `followUp`: a `FOLLOW_UP` timer of the complaint fired (worker/follow-up.ts), not a network transition. */
export const TransferStatusChangedEvent = event("TRANSFER_STATUS_CHANGED", z.object({ complaintId: Id, transferId: Id.optional(), followUp: z.literal(true).optional() }).strict());
export const OperatorSendEvent = event(
  "OPERATOR_SEND",
  z
    .object({
      staffId: StaffId,
      messageId: Id,
      channel: Channel,
      kind: MessageKind,
      text: z.string().min(1).max(4_000).optional(),
      template: OutboundTemplate.optional(),
      subject: z.string().min(1).max(200).optional(),
      complaintId: Id.optional(),
      rerouteOf: Id.optional(),
      /** A permitted path for the blocked entry `rerouteOf` (`conversation.reroute`); the child is rendered by code. */
      route: Reroute.optional(),
    })
    .strict()
    .refine(operatorSendBody, { message: "text or template, exactly one; a reroute names the blocked entry and carries neither", path: ["text"] }),
);

/** A message: text or template, exactly one. A reroute: `rerouteOf` and neither (outbound/reroute.ts renders it). */
function operatorSendBody(payload: { readonly text?: string | undefined; readonly template?: unknown; readonly rerouteOf?: string | undefined; readonly route?: Reroute | undefined }): boolean {
  if (payload.route !== undefined) return payload.rerouteOf !== undefined && payload.text === undefined && payload.template === undefined;
  return (payload.text === undefined) !== (payload.template === undefined);
}
export const OperatorAnswerEvent = event(
  "OPERATOR_ANSWER",
  z
    .object({
      staffId: StaffId,
      messageId: Id,
      complaintId: Id,
      outcome: z.enum(["IN_FAVOUR", "PARTIALLY_IN_FAVOUR", "NOT_IN_FAVOUR", "INFORMATIONAL", "WITHDRAWN"]),
      draftBody: z.string().min(1).max(5_000),
      requestedAttachments: z.array(AnswerAttachment).max(3).default([]),
    })
    .strict(),
);
/** The locator of the approval and nothing else: decision, amount and action are re-read (§8.5). */
export const ApprovalDecidedEvent = event("APPROVAL_DECIDED", z.object({ approvalId: Id, complaintId: Id }).strict());
export const OperatorReleasedEvent = event("OPERATOR_RELEASED", z.object({ staffId: StaffId, messageIds: z.array(Id).max(50) }).strict());
export const AnswerDueEvent = event("ANSWER_DUE", z.object({ complaintId: Id, sourceEventId: EventId }).strict());
export const ReconcileDueEvent = event("RECONCILE_DUE", z.object({ complaintId: Id, sourceEventId: EventId }).strict());
export const EmailEventEvent = event("EMAIL_EVENT", EmailEventPayload);
export const WaStatusEvent = event("WA_STATUS", z.object({ status: QueuedWaStatus, simulated: z.boolean() }).strict());
export const HealthProbeEvent = event("HEALTH_PROBE", z.object({ probeId: Id }).strict());
export const PoisonEvent = event("POISON", z.object({}).strict());

export const CustomerEvent = z.discriminatedUnion("type", [
  CustomerMessageEvent,
  ReceiptReceivedEvent,
  MediaRejectedEvent,
  TimerEvent,
  SettlementPublishedEvent,
  TransferStatusChangedEvent,
  OperatorSendEvent,
  OperatorAnswerEvent,
  ApprovalDecidedEvent,
  OperatorReleasedEvent,
  AnswerDueEvent,
  ReconcileDueEvent,
  EmailEventEvent,
  WaStatusEvent,
  HealthProbeEvent,
  PoisonEvent,
]);
export type CustomerEvent = z.infer<typeof CustomerEvent>;
export type CustomerEventInput = z.input<typeof CustomerEvent>;
export type EventOf<T extends CustomerEventType> = Extract<CustomerEvent, { type: T }>;

/** The events that open a turn of the Harness, and the trigger each one gives the session. */
export const TURN_EVENT_TYPES = [
  "CUSTOMER_MESSAGE",
  "RECEIPT_RECEIVED",
  "SETTLEMENT_PUBLISHED",
  "TRANSFER_STATUS_CHANGED",
  "APPROVAL_DECIDED",
  "OPERATOR_RELEASED",
  "ANSWER_DUE",
  "RECONCILE_DUE",
] as const satisfies readonly TurnTrigger[];
export type TurnEventType = (typeof TURN_EVENT_TYPES)[number];
export type TurnEvent = EventOf<TurnEventType>;

export function isTurnEvent(event: CustomerEvent): event is TurnEvent {
  return (TURN_EVENT_TYPES as readonly string[]).includes(event.type);
}

/** The complaint an event is about, when its payload names one. */
export function complaintIdOf(event: CustomerEvent): string | undefined {
  const payload: Record<string, unknown> = event.payload;
  return typeof payload["complaintId"] === "string" ? payload["complaintId"] : undefined;
}

/** The customer's WhatsApp message a notice of the event answers: the text or the receipt that opened the turn. */
export function answersOf(event: CustomerEvent): { readonly answers?: string } {
  return event.type === "CUSTOMER_MESSAGE" || event.type === "RECEIPT_RECEIVED" ? { answers: event.payload.messageId } : {};
}

/** `<worldId>#<customerId>`: the events of a customer run one at a time, in order. */
export function messageGroupOf(event: Pick<CustomerEvent, "worldId" | "customerId">): string {
  return `${event.worldId}#${event.customerId}`;
}

/** Separator of the real add time in an `inFlight` token: never a character of an id. */
const ADDED_AT = "~";

function tokenBase(event: Pick<CustomerEvent, "customerId" | "eventId">): string {
  return `${event.customerId}#${event.eventId}`;
}

/**
 * `<customerId>#<eventId>~<addedAtMs>`: the token of `WORLDSTATE.inFlight` while the event is queued or
 * running. The real add time lets the busy check report a token nobody will ever remove as stale.
 */
export function inFlightToken(event: Pick<CustomerEvent, "customerId" | "eventId">, addedAt: Date): string {
  return `${tokenBase(event)}${ADDED_AT}${addedAt.getTime()}`;
}

/** Whether a token (with its add time, or an older one without it) belongs to this event. */
export function isInFlightTokenOf(token: string, event: Pick<CustomerEvent, "customerId" | "eventId">): boolean {
  const base = tokenBase(event);
  return token === base || token.startsWith(`${base}${ADDED_AT}`);
}

/** The event id and, when the token carries it, the real instant the event entered `inFlight`. */
export function parseInFlightToken(token: string): { readonly eventId: string; readonly addedAtMs?: number } {
  const rest = token.slice(token.indexOf("#") + 1);
  const at = rest.lastIndexOf(ADDED_AT);
  const addedAtMs = at < 0 ? Number.NaN : Number(rest.slice(at + 1));
  return Number.isSafeInteger(addedAtMs) ? { eventId: rest.slice(0, at), addedAtMs } : { eventId: rest };
}

/** The bare `<customerId>#<eventId>`: what a settle removes when the world's row holds no token of the event. */
export function legacyInFlightToken(event: Pick<CustomerEvent, "customerId" | "eventId">): string {
  return tokenBase(event);
}

/** What can be read of a body that does not parse: enough to log it and to take it out of `inFlight`. */
export interface LooseIdentity {
  readonly type?: string;
  readonly eventId?: string;
  readonly worldId?: string;
  readonly customerId?: string;
  readonly epoch?: number;
  readonly correlationId?: string;
}

export function looseIdentity(body: string): LooseIdentity {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const read = (key: string): string | undefined => {
    const value: unknown = Reflect.get(raw, key);
    return typeof value === "string" && value.length <= 200 ? value : undefined;
  };
  const epoch: unknown = Reflect.get(raw, "epoch");
  const identity: Record<string, string | number | undefined> = {
    type: read("type"),
    eventId: EventId.safeParse(read("eventId")).success ? read("eventId") : undefined,
    worldId: WorldId.safeParse(read("worldId")).success ? read("worldId") : undefined,
    customerId: CustomerId.safeParse(read("customerId")).success ? read("customerId") : undefined,
    epoch: typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 ? epoch : undefined,
    correlationId: read("correlationId"),
  };
  return Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined)) as LooseIdentity;
}
