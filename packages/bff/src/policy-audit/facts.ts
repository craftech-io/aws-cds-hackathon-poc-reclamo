// What `PolicyAudit` reads to look at the past (checks a and b): one conversation at a time — its
// `META` (control history), its whole thread (the window and the daily counts are rebuilt from it at the
// send's own instant), the trigger each agent turn recorded, the customer's dated consent from the core,
// and the complaints the messages belong to. `asOfFactsOf` turns that into the input of
// channel-policy/as-of.ts, the same engine the gate ran, evaluated at the instant the message went out.
import type { AsOfFacts, AsOfMessage } from "../channel-policy/as-of";
import type { WhatsAppConsentState } from "../channel-policy/consent";
import type { Connector } from "../connector/port";
import type { Complaint } from "../domain/complaint";
import type { ConversationMeta, Message, MessageStatus } from "../domain/conversation";
import type { WorldSettings } from "../domain/world";
import type { CustomerFacts } from "../outbound/deps";

/** Statuses of an outbound message that may have reached the customer (a `PENDING` one may have: a timeout after the provider accepted). */
export const WENT_OUT: ReadonlySet<MessageStatus> = new Set<MessageStatus>(["PENDING", "SENT", "DELIVERED", "READ", "UNKNOWN_DELIVERY"]);

export interface ConversationFacts {
  readonly worldId: string;
  readonly customerId: string;
  readonly meta?: ConversationMeta;
  /** The whole thread, oldest first. */
  readonly messages: readonly Message[];
  /** `turnId` → the trigger its turn note recorded. */
  readonly triggers: ReadonlyMap<string, string>;
  readonly customer?: CustomerFacts;
}

export interface WorldFacts {
  readonly settings: WorldSettings;
  readonly holidays: readonly string[];
  readonly complaints: ReadonlyMap<string, Complaint>;
}

/** Customer ids of every conversation of the world (`WorldIndex` of `Conversations`, keys only). */
export async function conversationCustomers(connector: Connector, worldId: string): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await connector.worldItems.listKeys("Conversations", worldId, { limit: 500, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      if (key.sk !== "META") continue;
      const customerId = key.pk.split("#CONV#")[1];
      if (customerId) ids.add(customerId);
    }
    cursor = page.cursor;
  } while (cursor);
  return [...ids].sort();
}

/** Every complaint of the world, open and closed (the inbox index of each state). */
export async function worldComplaints(connector: Connector, worldId: string): Promise<Complaint[]> {
  const all: Complaint[] = [];
  for (const state of ["OPEN", "CLOSED"] as const) {
    let cursor: string | undefined;
    do {
      const page = await connector.complaints.listInbox(worldId, { state, limit: 200, ...(cursor ? { cursor } : {}) });
      all.push(...page.complaints);
      cursor = page.cursor;
    } while (cursor);
  }
  return all;
}

/** One conversation's rows, and the core's customer as `customer` reads it for that thread. */
export async function loadConversation(
  connector: Connector,
  worldId: string,
  customerId: string,
  customer: (messages: readonly Message[]) => Promise<CustomerFacts | undefined>,
): Promise<ConversationFacts> {
  const [meta, messages, notes] = await Promise.all([
    connector.conversations.getMeta(worldId, customerId),
    connector.conversations.listMessages(worldId, customerId),
    connector.conversations.listTurnNotes(worldId, customerId),
  ]);
  const facts = await customer(messages);
  const triggers = new Map<string, string>();
  for (const note of notes) if (note.trigger !== undefined) triggers.set(note.turnId, note.trigger);
  return { worldId, customerId, ...(meta === undefined ? {} : { meta }), messages, triggers, ...(facts === undefined ? {} : { customer: facts }) };
}

function consentOf(customer: CustomerFacts | undefined): WhatsAppConsentState | undefined {
  if (customer === undefined) return undefined;
  const { whatsapp } = customer;
  return {
    optedIn: whatsapp.optedIn,
    optedOut: whatsapp.optedOut,
    ...(whatsapp.optedInAtSim === undefined ? {} : { optedInAtSim: whatsapp.optedInAtSim }),
    ...(whatsapp.optInMedium === undefined ? {} : { optInMedium: whatsapp.optInMedium }),
    ...(whatsapp.optInTextVersion === undefined ? {} : { optInTextVersion: whatsapp.optInTextVersion }),
    ...(whatsapp.optedOutAtSim === undefined ? {} : { optedOutAtSim: whatsapp.optedOutAtSim }),
  };
}

/** The stored outbound message as the as-of engine reads it; `undefined` when it lacks a kind or a sender. */
export function asOfMessageOf(message: Message): AsOfMessage | undefined {
  if (message.kind === undefined || message.sender === undefined) return undefined;
  return {
    messageId: message.messageId,
    channel: message.channel,
    kind: message.kind,
    sender: message.sender,
    body: message.body,
    ...(message.templateName === undefined ? {} : { templateName: message.templateName }),
    ...(message.complaintId === undefined ? {} : { complaintId: message.complaintId }),
    sentAtSim: message.sentAtSim ?? message.atSim,
    ...(message.createdAt === undefined ? {} : { sentAtReal: message.createdAt }),
    simulated: message.simulated,
  };
}

function complaintFacts(complaint: Complaint | undefined): AsOfFacts["complaint"] {
  if (complaint === undefined) return undefined;
  return {
    complaintId: complaint.complaintId,
    customerId: complaint.customerId,
    complaintNumber: complaint.complaintNumber,
    type: complaint.type,
    status: complaint.status,
    filedAtSim: complaint.filedAtSim,
    statusHistory: complaint.statusHistory.map((change) => ({ from: change.from, to: change.to, atSim: change.atSim })),
  };
}

/** The as-of input of one outbound message (`undefined` when the stored row cannot be re-evaluated). */
export function asOfFactsOf(conversation: ConversationFacts, message: Message, world: WorldFacts): AsOfFacts | undefined {
  const stored = asOfMessageOf(message);
  if (stored === undefined) return undefined;
  const { meta } = conversation;
  const trigger = message.turnId === undefined ? undefined : conversation.triggers.get(message.turnId);
  const consent = consentOf(conversation.customer);
  const complaint = complaintFacts(message.complaintId === undefined ? undefined : world.complaints.get(message.complaintId));
  return {
    worldId: conversation.worldId,
    customerId: conversation.customerId,
    message: stored,
    ...(trigger === undefined ? {} : { trigger }),
    ...(consent === undefined ? {} : { consent }),
    conversation: meta === undefined ? { control: "AGENT", controlHistory: [] } : { control: meta.control, ...(meta.controlledBy === undefined ? {} : { controlledBy: meta.controlledBy }), controlHistory: [...meta.controlHistory] },
    ...(complaint === undefined ? {} : { complaint }),
    history: conversation.messages.map((entry) => ({
      messageId: entry.messageId,
      direction: entry.direction,
      channel: entry.channel,
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      status: entry.status,
      ...(entry.templateName === undefined ? {} : { templateName: entry.templateName }),
      // As the gate read the thread when it decided (outbound/context.ts `policyInputOf`).
      atSim: entry.atSim,
      ...(entry.createdAt === undefined ? {} : { atReal: entry.createdAt }),
    })),
    settings: { contactHours: world.settings.contactHours, maxProactivePerDay: world.settings.maxProactivePerDay, holidays: [...world.holidays] },
  };
}
