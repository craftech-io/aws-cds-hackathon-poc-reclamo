// The fixed replies the inbound adapter decides (channels/whatsapp/ports.ts `FixedReplies`): the
// opt-out confirmation, the ambiguous "baja", an image that cannot be read, the rate limit notice and
// the number without a customer (FL-002, FL-006, FL-029, FL-105). The text is copy/es-AR.ts, the sender
// is `SYSTEM`, and every one leaves through the gate with an id derived from the inbound `wamid`, so a
// redelivery never sends it twice. No model is involved.
//
// The gate addresses a CUSTOMER of the world (it resolves the recipient itself, never from the caller);
// a number that is not a customer goes through outbound/unknown-sender.ts, the same steps for the party
// of its phone hash, and only with the texts it may receive (`UNKNOWN_SENDER`, `RATE_LIMITED`).
import { WHATSAPP_TEXT } from "../copy";
import type { FixedReplies, FixedReplyRequest } from "../channels/whatsapp/ports";
import type { Logger } from "../lib/log";
import type { GateOutcome, OutboundButton, OutboundCall, OutboundGate } from "../outbound/types";
import { type UnknownSenderReply, UnknownSenderTextKey } from "../outbound/unknown-sender";

export interface ReplyDeps {
  readonly gate: OutboundGate;
  /** outbound/unknown-sender.ts: the fixed reply to a number without a customer. */
  readonly unknownSender: (reply: UnknownSenderReply, call: OutboundCall) => Promise<GateOutcome>;
  readonly log: Logger;
}

async function replyToUnknown(deps: ReplyDeps, request: FixedReplyRequest): Promise<void> {
  const textKey = UnknownSenderTextKey.safeParse(request.textKey);
  if (!textKey.success) {
    deps.log.warn("intake.reply_unrouted", { textKey: request.textKey, reason: "NOT_A_CUSTOMER" });
    return;
  }
  await deps.unknownSender(
    { worldId: request.worldId, phoneHash: request.phoneHash, waId: request.waId, textKey: textKey.data, wamid: request.inReplyTo.wamid, atSim: request.atSim, messageId: request.messageId },
    { actor: "SYSTEM", correlationId: deps.log.correlationId, log: deps.log },
  );
}

function buttonsOf(request: FixedReplyRequest): OutboundButton[] | undefined {
  if (request.buttons === undefined) return undefined;
  return request.buttons.map((button) => {
    const ref = button.complaintId ?? button.loanId;
    return { action: button.action, ...(ref === undefined ? {} : { ref }) };
  });
}

export function gateFixedReplies(deps: ReplyDeps): FixedReplies {
  return {
    async send(request) {
      if (request.customerId === undefined) {
        await replyToUnknown(deps, request);
        return;
      }
      const buttons = buttonsOf(request);
      const outcome = await deps.gate(
        {
          worldId: request.worldId,
          customerId: request.customerId,
          sender: "SYSTEM",
          channel: "WHATSAPP",
          kind: request.kind,
          text: WHATSAPP_TEXT[request.textKey],
          ...(buttons === undefined ? {} : { buttons }),
          refs: { source: "INBOUND", textKey: request.textKey, ...(request.inReplyTo.messageId === undefined ? {} : { inReplyTo: request.inReplyTo.messageId }) },
          messageId: request.messageId,
        },
        { actor: "SYSTEM", correlationId: deps.log.correlationId, log: deps.log },
      );
      deps.log.info("intake.fixed_reply", { textKey: request.textKey, ok: outcome.ok, decision: outcome.ok ? outcome.decision : (outcome.decision ?? "UNDECIDED") });
    },
  };
}
