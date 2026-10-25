// What a turn's envelope says (docs/design-brief.md §8.2), read from the connector by code: the facts of
// the customer's complaints and conversation, the untrusted text of the turn and the receipt images it is
// about. agent/envelope.ts renders it.
//
//   facts         the conversation (control, identification, 24 h window, channel mode), the open
//                 complaints (number, type, status, deadline: `current` for those of the event), the last
//                 closed ones with their outcome (from `Complaints`, never from Memory), and what the
//                 event is about (an obligation, a decided approval, a published batch), and the reply
//                 button the customer tapped, when the inbound message is a tap
//   inbound       CUSTOMER_MESSAGE and RECEIPT_RECEIVED: the body of the inbound message the event names
//                 (normalized and masked when it was stored); OPERATOR_RELEASED: what the operator wrote
//                 since taking the conversation, by the ids the event carries (FL-086). Nothing else.
//   attachments   the receipt image of a RECEIPT_RECEIVED, with whether it was read already
import type { WorldSettings } from "../domain/world";
import type { FactLine, InboundBlock, AttachmentLine } from "../agent/envelope";
import { deadlineText, isoAr } from "../complaints/sla";
import { normalizeInboundText } from "../channels/normalizer";
import type { Connector } from "../connector/port";
import { receiptImageEvidenceId } from "../media-intake/intake";
import type { Complaint } from "../domain/complaint";
import type { ConversationMeta, Message } from "../domain/conversation";
import type { TurnEvent } from "../worker/events";

/** Statuses of a complaint that is still the customer's open matter (its session lists it). */
export const OPEN_FOR_SESSION: ReadonlySet<Complaint["status"]> = new Set([
  "REGISTERED",
  "INVESTIGATING",
  "AWAITING_CUSTOMER",
  "AWAITING_SETTLEMENT",
  "AWAITING_NETWORK",
  "AWAITING_APPROVAL",
  "HUMAN_REVIEW",
  "RESOLVED",
]);

/** Closed complaints the facts carry, newest first. */
export const PREVIOUS_COMPLAINTS = 5;

export interface TurnInbound extends Omit<InboundBlock, "delimiter"> {
  /** `CUSTOMER` text goes through the G1 pre-filter; an operator's summary does not. */
  readonly source: "CUSTOMER" | "OPERATOR";
  /** The inbound message the turn answers, when there is one. */
  readonly message?: Message;
}

export interface TurnContextData {
  readonly conversation?: ConversationMeta;
  readonly complaints: readonly Complaint[];
  readonly settings?: WorldSettings;
}

/** The customer's complaints, the conversation and the world settings: what the facts are built from. */
export async function loadTurnContext(data: Pick<Connector, "complaints" | "conversations" | "worlds">, event: TurnEvent): Promise<TurnContextData> {
  const [conversation, complaints, settings] = await Promise.all([
    data.conversations.getMeta(event.worldId, event.customerId, { consistent: true }),
    data.complaints.listByCustomer(event.worldId, event.customerId, 50),
    data.worlds.getSettings(event.worldId),
  ]);
  return { ...(conversation === undefined ? {} : { conversation }), complaints, ...(settings === undefined ? {} : { settings }) };
}

/** The complaints the event names: its payload's, or the open ones the classifier registered for it. */
export function eventComplaintIds(event: TurnEvent): string[] {
  if (event.type === "CUSTOMER_MESSAGE") return [...event.payload.complaintIds];
  if ("complaintId" in event.payload && event.payload.complaintId !== undefined) return [event.payload.complaintId];
  return [];
}

/** The complaints of the session: the customer's open ones plus those the event names. */
export function sessionComplaintIds(event: TurnEvent, context: TurnContextData): string[] {
  const open = context.complaints.filter((complaint) => OPEN_FOR_SESSION.has(complaint.status)).map((complaint) => complaint.complaintId);
  return [...new Set([...eventComplaintIds(event), ...open])];
}

/** The customer has an open `UNRECOGNIZED_CHARGE` complaint: the turn preloads its charges (preload.ts). */
export function chargeComplaintOpen(context: TurnContextData): boolean {
  return context.complaints.some((complaint) => complaint.type === "UNRECOGNIZED_CHARGE" && OPEN_FOR_SESSION.has(complaint.status));
}

export function isIdentified(conversation: ConversationMeta | undefined, realNow: Date): boolean {
  const until = conversation?.identifiedUntilReal;
  return until !== undefined && Date.parse(until) > realNow.getTime();
}

function complaintFact(name: "complaint" | "previousComplaint", complaint: Complaint, current: boolean): FactLine {
  return {
    name,
    attributes: {
      id: complaint.complaintId,
      number: complaint.complaintNumber,
      kind: complaint.kind,
      type: complaint.type,
      status: complaint.status,
      ...(name === "complaint" ? { deadline: isoAr(new Date(complaint.deadlineSim)), deadlineText: deadlineText(complaint.deadlineSim), slaState: complaint.slaState, current } : {}),
      ...(complaint.outcome === undefined ? {} : { outcome: complaint.outcome }),
      answered: complaint.answer?.messageId !== undefined,
      emailConsent: complaint.emailAnswerConsent.status,
    },
  };
}

function eventFacts(event: TurnEvent): FactLine[] {
  switch (event.type) {
    case "ANSWER_DUE":
      return [{ name: "obligation", attributes: { kind: "ANSWER_DUE", task: "send the written answer of the complaint that is due, and nothing else" } }];
    case "RECONCILE_DUE":
      return [{ name: "obligation", attributes: { kind: "RECONCILE_DUE", task: "the settlement matched: apply the payment and answer" } }];
    case "APPROVAL_DECIDED":
      return [{ name: "approval", attributes: { status: "EXECUTED", task: "tell the customer and send the written answer" } }];
    case "SETTLEMENT_PUBLISHED":
      return [{ name: "settlement", attributes: { status: "PUBLISHED" } }];
    case "TRANSFER_STATUS_CHANGED":
      if (event.payload.followUp === true) return [{ name: "followUp", attributes: { status: "DUE", task: "check again what the complaint is waiting for and tell the customer" } }];
      return [{ name: "transfer", attributes: { status: "CHANGED" } }];
    default:
      return [];
  }
}

/** State of the customer by code; every value is an id, an enum, a count, a flag or an instant. */
export function envelopeFacts(event: TurnEvent, context: TurnContextData, identified: boolean, realNow: Date): FactLine[] {
  const current = new Set(eventComplaintIds(event));
  const { conversation, complaints, settings } = context;
  const windowOpen = conversation?.windowOpenUntilSim !== undefined && Date.parse(conversation.windowOpenUntilSim) > Date.parse(event.eventAtSim);
  const open = complaints.filter((complaint) => OPEN_FOR_SESSION.has(complaint.status));
  const previous = complaints.filter((complaint) => !OPEN_FOR_SESSION.has(complaint.status)).slice(0, PREVIOUS_COMPLAINTS);
  return [
    {
      name: "conversation",
      attributes: {
        control: conversation?.control ?? "AGENT",
        identified,
        ...(identified && conversation?.identifiedUntilReal !== undefined ? { identifiedForMinutes: Math.max(0, Math.floor((Date.parse(conversation.identifiedUntilReal) - realNow.getTime()) / 60_000)) } : {}),
        windowOpen,
        whatsappMode: settings?.channelModes.whatsapp ?? "simulated",
      },
    },
    ...open.map((complaint) => complaintFact("complaint", complaint, current.has(complaint.complaintId))),
    ...previous.map((complaint) => complaintFact("previousComplaint", complaint, false)),
    { name: "complaints", attributes: { open: open.length, previous: previous.length } },
    ...eventFacts(event),
  ];
}

/** The reply button the turn's inbound message tapped (`inbound button="CONFIRM_CLOSURE"`): an action, never its nonce. */
export function inboundFacts(inbound: TurnInbound | undefined): FactLine[] {
  const action = inbound?.source === "CUSTOMER" ? inbound.message?.interactive?.["action"] : undefined;
  return typeof action === "string" && /^[A-Z_]{1,40}$/.test(action) ? [{ name: "inbound", attributes: { button: action } }] : [];
}

async function customerMessage(data: Pick<Connector, "conversations">, event: TurnEvent & { readonly payload: { readonly messageId: string } }): Promise<TurnInbound | undefined> {
  const message = await data.conversations.findMessage(event.worldId, event.customerId, event.payload.messageId);
  // Only an inbound message of this customer is the turn's text; anything else is a producer's bug.
  if (message === undefined || message.direction !== "IN" || message.customerId !== event.customerId || message.body.trim() === "") return undefined;
  return { text: message.body, channel: message.channel, fromRole: "CUSTOMER", truncated: false, source: "CUSTOMER", message };
}

async function operatorSummary(data: Pick<Connector, "conversations">, event: Extract<TurnEvent, { type: "OPERATOR_RELEASED" }>): Promise<TurnInbound | undefined> {
  const wanted = new Set(event.payload.messageIds);
  if (wanted.size === 0) return undefined;
  const written = (await data.conversations.listMessages(event.worldId, event.customerId, { limit: 200 }))
    .filter((message) => wanted.has(message.messageId) && message.direction === "OUT" && message.sender?.startsWith("OPERATOR:") === true)
    .sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim));
  if (written.length === 0) return undefined;
  const lines = written.map((message) => `${isoAr(new Date(message.atSim))} ${message.channel}${message.kind === undefined ? "" : ` ${message.kind}`}: ${message.templateName === undefined ? message.body : `template ${message.templateName}`}`);
  const normalized = normalizeInboundText(lines.join("\n"), event.worldId);
  return { text: normalized.text, channel: "CONSOLE", fromRole: "OPERATOR", truncated: normalized.truncated, source: "OPERATOR" };
}

/** The untrusted text of the turn, or `undefined` when the event brings none. */
export async function loadInbound(data: Pick<Connector, "conversations">, event: TurnEvent): Promise<TurnInbound | undefined> {
  if (event.type === "CUSTOMER_MESSAGE" || event.type === "RECEIPT_RECEIVED") return customerMessage(data, event);
  if (event.type === "OPERATOR_RELEASED") return operatorSummary(data, event);
  return undefined;
}

/** The receipt image of a RECEIPT_RECEIVED, only of the event's complaint. */
export async function envelopeAttachments(data: Pick<Connector, "caseItems">, event: TurnEvent): Promise<AttachmentLine[]> {
  if (event.type !== "RECEIPT_RECEIVED" || event.payload.complaintId === undefined) return [];
  const evidence = await data.caseItems.listEvidence(event.worldId, event.payload.complaintId);
  const imageId = receiptImageEvidenceId(event.payload.messageId);
  const image = evidence.find((item) => item.evidenceId === imageId && item.kind === "RECEIPT_IMAGE");
  if (image === undefined) return [];
  const read = evidence.some((item) => item.kind === "RECEIPT_READING" && item.details["imageEvidenceId"] === image.evidenceId);
  return [{ evidenceId: image.evidenceId, kind: "RECEIPT_IMAGE", status: read ? "READ" : "PENDING_READ" }];
}
