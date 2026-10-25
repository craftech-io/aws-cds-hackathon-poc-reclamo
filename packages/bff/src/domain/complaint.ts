// `Complaints/…/META` (docs/architecture.md §5, §8): the current state of a registered presentation.
// Its status changes only through `transition()` (complaints/state-machine.ts), a conditional update
// on `version` and on the allowed origin states, written in the same transaction as its register
// entry; the connector carries the condition, the state machine decides what is allowed.
import { z } from "zod";
import { Channel, ComplaintOrigin, ComplaintOutcome, ComplaintStatus, ComplaintType, HandoffReason, IsoInstant, PresentationKind, SlaState, WorldId } from "@reclamo/shared";
import { Actor, ComplaintNumber, CustomerId, Epoch, Id, Versioned } from "./common";

export const Priority = z.enum(["NORMAL", "HIGH"]);
export type Priority = z.infer<typeof Priority>;

/** Who holds a conversation: the agent, or an operator after a take-over. */
export const Control = z.enum(["AGENT", "OPERATOR"]);
export type Control = z.infer<typeof Control>;

/** Delivery proof of an email, from the configuration-set events (docs/architecture-integrations.md §2). */
export const DeliveryProof = z.enum(["SENT", "DELIVERED", "BOUNCED", "COMPLAINED", "REJECTED"]);
export type DeliveryProof = z.infer<typeof DeliveryProof>;

/** The written answer: `inFlight` while it is being sent (a second send collides), then the sent message. */
export const ComplaintAnswer = z.object({
  inFlight: Id.optional(),
  messageId: Id.optional(),
  mailId: Id.optional(),
  sentAtSim: IsoInstant.optional(),
  deliveryProof: DeliveryProof.optional(),
});
export type ComplaintAnswer = z.infer<typeof ComplaintAnswer>;

export const EmailAnswerConsent = z.object({
  status: z.enum(["PENDING", "ACCEPTED", "DECLINED"]),
  atSim: IsoInstant.optional(),
  /** Version of the consent text the customer accepted (copy/consent.ts). */
  textVersion: z.string().max(40).optional(),
});
export type EmailAnswerConsent = z.infer<typeof EmailAnswerConsent>;

export const Handoff = z.object({ reason: HandoffReason, atSim: IsoInstant, summary: z.string().max(500).optional() });
export type Handoff = z.infer<typeof Handoff>;

export const StatusChange = z.object({
  from: ComplaintStatus.nullable(),
  to: ComplaintStatus,
  atSim: IsoInstant,
  cause: z.string().min(1).max(120),
  actor: Actor,
});
export type StatusChange = z.infer<typeof StatusChange>;

/** What the complaint is about, so an open one of the same type and object is found again. */
export const ComplaintSubject = z.object({
  loanId: Id.optional(),
  instalment: z.number().int().positive().optional(),
  chargeId: Id.optional(),
  transferId: Id.optional(),
  operationCode: Id.optional(),
});
export type ComplaintSubject = z.infer<typeof ComplaintSubject>;

export const Complaint = z.object({
  worldId: WorldId,
  complaintId: Id,
  complaintNumber: ComplaintNumber,
  /** World epoch at filing: its register entries live in `REG#e<epoch>`. */
  epoch: Epoch,
  customerId: CustomerId,
  kind: PresentationKind,
  type: ComplaintType,
  status: ComplaintStatus,
  outcome: ComplaintOutcome.optional(),
  priority: Priority,
  origin: ComplaintOrigin,
  /** Mirror of the conversation's control, for the inbox. */
  control: Control,
  channel: Channel,
  /** One sentence, masked (lib/mask.ts) before it is stored. */
  summary: z.string().max(200),
  subject: ComplaintSubject.optional(),
  sourceMessageId: Id.optional(),
  filedAtSim: IsoInstant,
  deadlineSim: IsoInstant,
  slaState: SlaState,
  emailAnswerConsent: EmailAnswerConsent,
  answer: ComplaintAnswer.optional(),
  handoff: Handoff.optional(),
  statusHistory: z.array(StatusChange),
  ...Versioned,
});
export type Complaint = z.infer<typeof Complaint>;

/** Statuses that leave the inbox: the written answer went out (the regulatory clock stopped) or the case is closed. */
export const INBOX_CLOSED_STATUSES: ReadonlySet<ComplaintStatus> = new Set<ComplaintStatus>(["ANSWERED", "CLOSED"]);

export function inboxStateOf(status: ComplaintStatus): "OPEN" | "CLOSED" {
  return INBOX_CLOSED_STATUSES.has(status) ? "CLOSED" : "OPEN";
}
