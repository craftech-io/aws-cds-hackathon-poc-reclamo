// The worker's fixed messages to the customer (docs/architecture.md §7 and §9.1): the handoff notice,
// the holding notice, the refusals after a guardrail block and the reply to a rejected image. Their text
// is a fixed text of copy/ (sender `SYSTEM`), never the model's, and every one goes through the one exit,
// `sendThroughGate` (ADR-0006): the channel policy, the disclosure, the fence and the tape apply as to
// any other message. Its `messageId` derives from the event and the purpose, so a redelivered event
// never sends it twice (the gate's `SEND#` claim).
import type { MessageKind } from "@reclamo/shared";
import { WHATSAPP_TEXT, fill } from "../copy";
import type { WhatsAppTextKey } from "../copy";
import { deadlineText } from "../complaints/sla";
import type { Complaint } from "../domain/complaint";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { GateOutcome, OutboundButton, OutboundGate } from "../outbound/types";

export interface NoticeEvent {
  readonly worldId: string;
  readonly customerId: string;
  readonly eventId: string;
  readonly correlationId?: string;
}

export interface FixedMessage {
  readonly kind: MessageKind;
  readonly text: string;
  /** What the message is, so its id differs from the event's other fixed messages. */
  readonly purpose: string;
  readonly complaintId?: string;
  readonly buttons?: readonly OutboundButton[];
  readonly turnId?: string;
  /** The customer's inbound message the notice answers (outbound/types.ts `answers`). */
  readonly answers?: string;
}

/** `m-<32 hex>` of the event and the purpose: the same notice of the same event is one message. */
export function derivedMessageId(eventId: string, purpose: string): string {
  return `m-${sha256Hex(`${purpose}#${eventId}`).slice(0, 32)}`;
}

/** Sends one fixed message by WhatsApp through the gate; the gate decides and records. */
export async function sendFixed(gate: OutboundGate, log: Logger, event: NoticeEvent, message: FixedMessage): Promise<GateOutcome> {
  const outcome = await gate(
    {
      worldId: event.worldId,
      customerId: event.customerId,
      ...(message.complaintId === undefined ? {} : { complaintId: message.complaintId }),
      sender: "SYSTEM",
      channel: "WHATSAPP",
      kind: message.kind,
      text: message.text,
      ...(message.buttons === undefined ? {} : { buttons: message.buttons }),
      refs: { eventId: event.eventId, purpose: message.purpose, ...(message.complaintId === undefined ? {} : { complaintId: message.complaintId }) },
      triggerEventId: event.eventId,
      ...(message.answers === undefined ? {} : { answers: message.answers }),
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      messageId: derivedMessageId(event.eventId, message.purpose),
    },
    { actor: "SYSTEM", correlationId: event.correlationId ?? event.eventId, log },
  );
  log.info("worker.fixed_message", { kind: message.kind, purpose: message.purpose, ok: outcome.ok, decision: outcome.ok ? outcome.decision : outcome.decision ?? "UNDECIDED" });
  return outcome;
}

export function whatsappText(key: WhatsAppTextKey, params: Readonly<Record<string, string>> = {}): string {
  return fill(WHATSAPP_TEXT[key], params);
}

/** `HANDOFF_NOTICE` with the complaint's number and deadline, or the one without a complaint. */
export function handoffText(complaint: Complaint | undefined): string {
  if (complaint === undefined) return whatsappText("HANDOFF_NOTICE_NO_COMPLAINT");
  return whatsappText("HANDOFF_NOTICE", { complaintNumber: complaint.complaintNumber, deadlineText: deadlineText(complaint.deadlineSim) });
}

/** `HOLDING_NOTICE` with the complaint's number, or the one without a complaint. */
export function holdingText(complaint: Complaint | undefined): string {
  if (complaint === undefined) return whatsappText("HOLDING_NOTICE_NO_COMPLAINT");
  return whatsappText("HOLDING_NOTICE", { complaintNumber: complaint.complaintNumber });
}
