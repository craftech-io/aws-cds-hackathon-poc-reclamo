// The `Message OUT` of a send (docs/architecture.md §5): written `PENDING` (or `DEFERRED`) before the
// tape's `ALLOWED`, with the nonces of its buttons and the disclosure mark in one transaction, and
// moved to `SENT`/`DELIVERED`, `FAILED` or `UNKNOWN_DELIVERY` by the dispatch. A blocked send writes no
// message: the tape is its record. The body is what the customer reads (our text, never a provider
// payload), the template's parameters as the caller passed them (a phrase id, not the phrase), and the
// buttons with their nonces, which the phone simulator taps.
import type { NewOf } from "../connector/codec";
import type { MessagePatch } from "../connector/repos/conversations";
import type { Connector } from "../connector/port";
import type { WriteOp } from "../connector/store";
import type { JsonObject } from "../domain/common";
import type { Message, MessageStatus } from "../domain/conversation";
import type { WhatsAppDraft } from "./render/whatsapp";
import type { OutboundRequest } from "./types";

/** `Message.body` holds at most this many characters. */
const BODY_MAX = 4_096;

export interface StagedMessage {
  readonly worldId: string;
  readonly customerId: string;
  readonly messageId: string;
  /** The instant that orders the thread (and the key of the row). */
  readonly atSim: string;
  /** Carried on every later patch: a status update must never drop the disclosure mark. */
  readonly flags: Message["flags"];
}

export interface MessageDraft {
  readonly request: Pick<OutboundRequest, "worldId" | "customerId" | "complaintId" | "channel" | "kind" | "sender" | "template" | "turnId" | "triggerEventId">;
  readonly messageId: string;
  readonly atSim: string;
  readonly status: Extract<MessageStatus, "PENDING" | "DEFERRED" | "BLOCKED">;
  /** The tape entry that decided it (a block, a deferral). */
  readonly tapeRef?: string;
  /** What the customer reads (rendered text, or the email's subject and text). */
  readonly body: string;
  readonly simulated: boolean;
  readonly disclosure?: boolean;
  /** The buttons as rendered, with their nonces (WhatsApp). */
  readonly interactive?: JsonObject;
  /** The scores of the G2 verdict that let the free text through. */
  readonly g2?: Message["g2"];
}

function clip(text: string): string {
  return text.length <= BODY_MAX ? text : text.slice(0, BODY_MAX);
}

/** The row of a new outbound message (put only if absent). */
export function messageRow(draft: MessageDraft): NewOf<typeof Message> {
  const { request } = draft;
  return {
    worldId: request.worldId,
    customerId: request.customerId,
    messageId: draft.messageId,
    direction: "OUT",
    channel: request.channel,
    kind: request.kind,
    sender: request.sender,
    body: clip(draft.body),
    ...(request.template === undefined ? {} : { templateName: request.template.name, templateParams: [...request.template.params] }),
    ...(draft.interactive === undefined ? {} : { interactive: draft.interactive }),
    status: draft.status,
    ...(draft.tapeRef === undefined ? {} : { tapeRef: draft.tapeRef }),
    ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
    ...(request.triggerEventId === undefined ? {} : { triggerEventId: request.triggerEventId }),
    ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }),
    flags: draft.disclosure === true ? { disclosure: true } : {},
    ...(draft.g2 === undefined ? {} : { g2: draft.g2 }),
    simulated: draft.simulated,
    atSim: draft.atSim,
  };
}

/** The buttons of a WhatsApp draft with their nonces, as the thread keeps them. */
export function interactiveOf(draft: WhatsAppDraft, nonces: readonly string[]): JsonObject | undefined {
  if (draft.buttons.length === 0) return undefined;
  const buttons = draft.buttons.map((button, index) => ({ action: button.action, nonce: nonces[index] ?? "", ...("title" in button ? { title: button.title } : {}) }));
  return { shape: draft.shape, ...(draft.shape === "list" ? { menu: draft.menu } : {}), buttons };
}

/** Writes the message: a new row, or, for a deferred message being sent now, its existing row. */
export function stageMessageOp(data: Pick<Connector, "conversations">, draft: MessageDraft, existing: Message | undefined): WriteOp {
  if (existing === undefined) return data.conversations.putMessageOp(messageRow(draft));
  const patch: MessagePatch = { status: draft.status, flags: draft.disclosure === true ? { disclosure: true } : existing.flags };
  return data.conversations.updateMessageOp({ worldId: existing.worldId, customerId: existing.customerId, atSim: existing.atSim, messageId: existing.messageId }, patch, existing.version);
}

/** The key of the row a staged message lives at, and the flags it was staged with. */
export function stagedOf(draft: Pick<MessageDraft, "request" | "messageId" | "atSim" | "disclosure">, existing: Message | undefined): StagedMessage {
  const flags = draft.disclosure === true ? { disclosure: true } : (existing?.flags ?? {});
  return existing === undefined
    ? { worldId: draft.request.worldId, customerId: draft.request.customerId, messageId: draft.messageId, atSim: draft.atSim, flags }
    : { worldId: existing.worldId, customerId: existing.customerId, messageId: existing.messageId, atSim: existing.atSim, flags };
}

/**
 * Moves a staged message forward (status, provider id, dispatch instant, tape entry). The flags go
 * with every patch: the patch schema defaults an absent `flags` to `{}`, which would drop the
 * disclosure mark of the message.
 */
export async function settleMessage(data: Pick<Connector, "conversations">, staged: StagedMessage, patch: MessagePatch): Promise<void> {
  const { worldId, customerId, messageId, atSim } = staged;
  await data.conversations.updateMessage({ worldId, customerId, messageId, atSim }, { flags: staged.flags, ...patch });
}
