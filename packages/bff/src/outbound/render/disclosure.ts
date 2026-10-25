// The automation disclosure (docs/design-brief.md §3, CONTEXT.md "Aviso de automatización", FL-001):
// the first outbound WhatsApp of each conversation and of each `sessionEpoch`, whoever sends it,
// starts with the fixed line `AUTOMATED_DISCLOSURE` of copy/es-AR.ts and is stored with
// `flags.disclosure = true`. It never depends on the model. The epoch is marked with the message in
// one transaction (`markDisclosedOp`, conditional on the epoch not being there yet): of two senders
// racing, one carries the line and the other is rendered again without it. A template's body is
// Meta's and cannot carry it: the next free text does.
import { AUTOMATED_DISCLOSURE } from "../../copy";
import type { Connector } from "../../connector/port";
import type { WriteOp } from "../../connector/store";
import type { ConversationMeta, Message } from "../../domain/conversation";

/** What goes before the body: the line and a blank line. */
export const DISCLOSURE_PREFIX = `${AUTOMATED_DISCLOSURE}\n\n`;

/**
 * Whether the next outbound free text of the conversation carries the disclosure: no conversation yet,
 * or a session epoch whose first outbound did not carry it.
 */
export function needsDisclosure(meta: Pick<ConversationMeta, "sessionEpoch" | "disclosedEpochs"> | undefined): boolean {
  return meta === undefined || !meta.disclosedEpochs.includes(meta.sessionEpoch);
}

export function withDisclosure(body: string): string {
  return `${DISCLOSURE_PREFIX}${body}`;
}

/** The body the sender wrote, without the line the gate put before it. */
export function withoutDisclosure(message: Pick<Message, "body" | "flags">): string {
  return message.flags.disclosure === true && message.body.startsWith(DISCLOSURE_PREFIX) ? message.body.slice(DISCLOSURE_PREFIX.length) : message.body;
}

/** The mark of the epoch, to commit with the message that carries the line (none without a conversation). */
export function disclosureOps(data: Pick<Connector, "conversations">, meta: Pick<ConversationMeta, "worldId" | "customerId" | "sessionEpoch"> | undefined): WriteOp[] {
  return meta === undefined ? [] : [data.conversations.markDisclosedOp(meta.worldId, meta.customerId, meta.sessionEpoch)];
}
