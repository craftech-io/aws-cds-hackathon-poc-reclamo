// The fixed tables the rules read (docs/design-brief.md §3 and §7): the order of the rules, which
// channel and which senders each `MessageKind` has (`CH-KIND-CHANNEL`), what `SYSTEM` may send
// (`CH-SENDER`), which kinds only exist as an answer to the customer, which kinds count as proactive
// contacts when nobody asked for them, and which statuses mean a message left the building.
import type { Channel, MessageKind, TurnTrigger } from "@reclamo/shared";
import { ChannelRuleId } from "../copy/types";
import type { MessageStatus } from "../domain/conversation";

/** The rules in the order of docs/design-brief.md §7: the first one that blocks decides. */
export const CHANNEL_RULES: readonly ChannelRuleId[] = ChannelRuleId.options;

/** Version of the rule set; a change of a rule's meaning bumps it (`TapeEntry.ruleSetVersion`). */
export const RULE_SET_VERSION = "ch-2026.10.06";

export type SenderClass = "AGENT" | "OPERATOR" | "SYSTEM";

export interface KindRoute {
  readonly channels: readonly Channel[];
  readonly senders: readonly SenderClass[];
  /** The kind only exists as the child of a reroute (`rerouteOf`) on this channel. */
  readonly rerouteOnly?: readonly Channel[];
  /** The kind only goes out from the `demo` world. */
  readonly demoOnly?: boolean;
}

const ANY: readonly SenderClass[] = ["AGENT", "OPERATOR", "SYSTEM"];
const WA: readonly Channel[] = ["WHATSAPP"];
const EMAIL: readonly Channel[] = ["EMAIL"];

/** Kind → channel and senders (docs/design-brief.md §3). */
export const KIND_ROUTES: Readonly<Record<MessageKind, KindRoute>> = {
  COMPLAINT_ACK: { channels: WA, senders: ["SYSTEM"] },
  ACK_EMAIL: { channels: EMAIL, senders: ["SYSTEM"] },
  IDENTITY_CHALLENGE: { channels: WA, senders: ["AGENT"] },
  // SYSTEM: the fixed replies of copy/ the inbound adapter and the worker answer inside the window
  // (rate limit, ambiguous "baja", a number without a customer, an image that could not be taken).
  REPLY: { channels: WA, senders: ["AGENT", "OPERATOR", "SYSTEM"] },
  RECEIPT_REQUEST: { channels: WA, senders: ["AGENT", "SYSTEM"] },
  // By email only as the "novedad por email" a blocked WhatsApp update is rerouted to (CH-OPTIN, CH-OPTOUT).
  COMPLAINT_UPDATE: { channels: ["WHATSAPP", "EMAIL"], senders: ANY, rerouteOnly: EMAIL },
  RESOLUTION_NOTICE: { channels: WA, senders: ["AGENT", "SYSTEM"] },
  FORMAL_ANSWER: { channels: EMAIL, senders: ["AGENT", "OPERATOR"] },
  HANDOFF_NOTICE: { channels: WA, senders: ["SYSTEM"] },
  HOLDING_NOTICE: { channels: WA, senders: ["SYSTEM"] },
  OPERATOR_MESSAGE: { channels: WA, senders: ["OPERATOR"] },
  SAFETY_GUIDANCE: { channels: WA, senders: ["SYSTEM"] },
  OUT_OF_SCOPE_REFUSAL: { channels: WA, senders: ["AGENT", "SYSTEM"] },
  OPT_OUT_CONFIRMATION: { channels: WA, senders: ["SYSTEM"] },
  DATA_CHANGE_CONFIRMATION: { channels: EMAIL, senders: ["SYSTEM"] },
  CLOSURE_CONFIRMATION: { channels: EMAIL, senders: ["SYSTEM"] },
  SUPERVISOR_ALERT: { channels: EMAIL, senders: ["SYSTEM"], demoOnly: true },
  // A type of its own so the attempt lands on the tape: CH-WA-NO-COLLECTION always blocks it.
  COLLECTION_REMINDER: { channels: WA, senders: ANY },
  // Started by a person, only by rerouting a blocked collection attempt, and rendered by code.
  COLLECTION_NOTICE_EMAIL: { channels: EMAIL, senders: ["OPERATOR"], rerouteOnly: EMAIL },
};

/** What `SYSTEM` may send: the kinds its deterministic handlers produce (`CH-SENDER`). */
export const SYSTEM_KINDS: ReadonlySet<MessageKind> = new Set(
  (Object.entries(KIND_ROUTES) as [MessageKind, KindRoute][]).filter(([, route]) => route.senders.includes("SYSTEM")).map(([kind]) => kind),
);

/** Staff roles that may write to a customer from the console; `COMPLIANCE` is read-only. */
export const SENDING_ROLES = ["OPERATOR", "SUPERVISOR", "GUEST"] as const;

/** Kinds an operator writes as free text: only with the conversation taken (`CH-CONTROL`). */
export const OPERATOR_FREE_TEXT_KINDS: ReadonlySet<MessageKind> = new Set(["REPLY", "OPERATOR_MESSAGE"]);

/** Collection kinds: never by WhatsApp (`CH-WA-NO-COLLECTION`). */
export const COLLECTION_KINDS: ReadonlySet<MessageKind> = new Set(["COLLECTION_REMINDER", "COLLECTION_NOTICE_EMAIL"]);

/** The only WhatsApp that follows an opt-out (`CH-OPTOUT`). */
export const OPT_OUT_CONFIRMATION: MessageKind = "OPT_OUT_CONFIRMATION";

/** Turns opened by a WhatsApp message of the customer (a text, a button or a receipt image). */
export const REPLY_TRIGGERS: readonly TurnTrigger[] = ["CUSTOMER_MESSAGE", "RECEIPT_RECEIVED"];

/**
 * Kinds that only exist inside a conversation the customer is having: the acknowledgement of what
 * the customer just wrote, the conversational asks and answers of the agent, the fixed refusal and
 * safety texts, and the free text of an operator who took the conversation. Inside the window they
 * are replies; a template of the same kind is not.
 */
export const ANSWER_KINDS: ReadonlySet<MessageKind> = new Set([
  "COMPLAINT_ACK",
  "OPT_OUT_CONFIRMATION",
  "REPLY",
  "IDENTITY_CHALLENGE",
  "RECEIPT_REQUEST",
  "OUT_OF_SCOPE_REFUSAL",
  "SAFETY_GUIDANCE",
  "OPERATOR_MESSAGE",
]);

/**
 * Emails that are never a proactive contact: the acknowledgement and the written answer the
 * regulation demands, the confirmations of what the customer asked for, and the staff alert. They are
 * exempt from `CH-CONTACT-HOURS` and `CH-MAX-PER-DAY`: deferring one could push the written answer
 * past the regulatory deadline.
 */
export const EXEMPT_EMAIL_KINDS: ReadonlySet<MessageKind> = new Set(["ACK_EMAIL", "FORMAL_ANSWER", "DATA_CHANGE_CONFIRMATION", "CLOSURE_CONFIRMATION", "SUPERVISOR_ALERT"]);

/** The formal debt notice: its own hours (Mon-Fri 09:00-18:00) and one every 7 days. */
export const FORMAL_NOTICE: MessageKind = "COLLECTION_NOTICE_EMAIL";

/** WhatsApp kinds that are proactive by nature when a stored message does not say (`HistoryMessage.proactive`). */
const PROACTIVE_BY_DEFAULT: ReadonlySet<MessageKind> = new Set(["COMPLAINT_UPDATE", "RESOLUTION_NOTICE", "HANDOFF_NOTICE", "COLLECTION_REMINDER"]);

/** Statuses of an outbound message that left (or may have left) the building: they count against the caps. */
const WENT_OUT: ReadonlySet<MessageStatus> = new Set(["PENDING", "SENT", "DELIVERED", "READ", "UNKNOWN_DELIVERY"]);

export function wentOut(message: { readonly direction: "IN" | "OUT"; readonly status: MessageStatus }): boolean {
  return message.direction === "OUT" && WENT_OUT.has(message.status);
}

/** Whether a stored outbound message was a proactive contact: what its decision said, or its kind. */
export function wasProactive(message: { readonly channel: Channel; readonly kind?: MessageKind | undefined; readonly proactive?: boolean | undefined; readonly templateName?: string | undefined }): boolean {
  if (message.kind === undefined) return message.proactive === true;
  if (message.channel === "EMAIL") return !EXEMPT_EMAIL_KINDS.has(message.kind);
  if (message.proactive !== undefined) return message.proactive;
  return PROACTIVE_BY_DEFAULT.has(message.kind) || (message.kind === "OPERATOR_MESSAGE" && message.templateName !== undefined);
}

/** `AGENT`, `OPERATOR` or `SYSTEM`, from a `Sender`. */
export function senderClassOf(sender: string): SenderClass {
  if (sender === "AGENT" || sender === "SYSTEM") return sender;
  return "OPERATOR";
}

/** The staff id of an `OPERATOR:<staffId>` sender. */
export function staffIdOf(sender: string): string | undefined {
  return sender.startsWith("OPERATOR:") ? sender.slice("OPERATOR:".length) : undefined;
}
