// The fixed reply to a number that is not a customer of the world (FL-002, docs/design-brief.md §5): the
// `UNKNOWN_SENDER` text of copy/ (or the hour's `RATE_LIMITED` notice), with no Harness, no classifier and
// no complaint, through the same nine steps of the gate (outbound/gate.ts) as any other message: tape
// `ALLOWED` before the transport, the `SEND#` claim, `DISPATCH`.
//
// The gate decides about a party of the world; a number without a customer is the party
// `cus-unk-<24 hex of its phone hash>` (the hash is keyed: the number never appears), whose facts are
// the honest ones of an unknown number:
//
//   customer   no WhatsApp consent recorded (no opt-in, no opt-out) and no loans: the reply is answered
//              inside the window the number just opened, so no opt-in is needed (`CH-OPTIN`)
//   thread     the message it answers, stored with an EMPTY body: what an unknown number wrote is never
//              kept; it is what opens the 24-hour window (`CH-WA-24H`)
//   number     the one it wrote from, and only in a simulated world (the phone simulator, the QA reserve
//              phones); a live world resolves none, so the fence blocks it on the tape and nothing reaches
//              End User Messaging Social for a number the lender does not know
//
// The reply's id derives from the inbound `wamid`: a redelivery answers what was decided and never
// sends twice.
import { z } from "zod";
import { Id, IsoInstant, WorldId } from "@reclamo/shared";
import { appendInbound, derivedMessageId } from "../channels/whatsapp/records";
import { worldWhatsAppMode } from "../channels/whatsapp/registry";
import { WHATSAPP_TEXT } from "../copy";
import type { CustomerFacts, OutboundDeps } from "./deps";
import { createOutboundGate } from "./gate";
import { stageOutboundDeps } from "./stage";
import type { GateOutcome, OutboundCall } from "./types";

export const UNKNOWN_PARTY_PREFIX = "cus-unk-";

/** The texts a number without a customer may receive. */
export const UnknownSenderTextKey = z.enum(["UNKNOWN_SENDER", "RATE_LIMITED"]);

export const UnknownSenderReply = z
  .object({
    worldId: WorldId,
    /** `PhoneHashKey` HMAC of the sender's number (hex). */
    phoneHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** The sender's number as Meta writes it (digits only). */
    waId: z.string().regex(/^\d{8,15}$/),
    textKey: UnknownSenderTextKey,
    /** The inbound message it answers. */
    wamid: z.string().min(1).max(256),
    atSim: IsoInstant,
    /** Derived from the `wamid` (`re`): a redelivery never sends twice. */
    messageId: Id,
  })
  .strict();
export type UnknownSenderReply = z.infer<typeof UnknownSenderReply>;

/** The party of a number without a customer: `cus-unk-<24 hex>`, never the number. */
export function unknownPartyOf(phoneHash: string): string {
  return `${UNKNOWN_PARTY_PREFIX}${phoneHash.slice(0, 24)}`;
}

export function isUnknownParty(customerId: string): boolean {
  return customerId.startsWith(UNKNOWN_PARTY_PREFIX);
}

function partyFacts(party: string): CustomerFacts {
  return { customerId: party, firstName: "", emailMasked: "", whatsapp: { optedIn: false, optedOut: false }, loans: [] };
}

/** The gate's ports for one unknown party; every other customer resolves as before. */
export function unknownPartyDeps(deps: OutboundDeps, party: string, number: string): OutboundDeps {
  return {
    ...deps,
    customers: {
      get: (worldId, customerId, simNow, correlationId) => (customerId === party ? Promise.resolve(partyFacts(party)) : deps.customers.get(worldId, customerId, simNow, correlationId)),
    },
    recipients: {
      whatsAppNumber: (worldId, customerId, mode) => (customerId === party ? Promise.resolve(mode === "simulated" ? number : undefined) : deps.recipients.whatsAppNumber(worldId, customerId, mode)),
    },
  };
}

/** Steps 0 to 9 of the gate for the fixed reply to a number that is not a customer. */
export async function replyToUnknownSender(deps: OutboundDeps, input: UnknownSenderReply, call: OutboundCall): Promise<GateOutcome> {
  const reply = UnknownSenderReply.parse(input);
  const party = unknownPartyOf(reply.phoneHash);
  const { connector } = deps.chains;
  const mode = worldWhatsAppMode(reply.worldId, await connector.worlds.getSettings(reply.worldId), deps.stageModes);
  await appendInbound(connector, { worldId: reply.worldId, customerId: party, messageId: derivedMessageId(reply.worldId, reply.wamid, "in"), wamid: reply.wamid, body: "", simulated: mode === "simulated", atSim: reply.atSim });
  const gate = createOutboundGate(unknownPartyDeps(deps, party, `+${reply.waId}`));
  const outcome = await gate(
    {
      worldId: reply.worldId,
      customerId: party,
      sender: "SYSTEM",
      channel: "WHATSAPP",
      kind: "REPLY",
      text: WHATSAPP_TEXT[reply.textKey],
      refs: { source: "INBOUND", textKey: reply.textKey, party: "UNKNOWN_SENDER" },
      messageId: reply.messageId,
    },
    call,
  );
  call.log.info("outbound.unknown_sender_reply", { textKey: reply.textKey, ok: outcome.ok, decision: outcome.ok ? outcome.decision : (outcome.decision ?? "UNDECIDED") });
  return outcome;
}

let stageDeps: OutboundDeps | undefined;

/** The fixed reply to an unknown number in a deployed function (`PIPELINE`), over outbound/stage.ts. */
export function sendToUnknownSender(input: UnknownSenderReply, call: OutboundCall): Promise<GateOutcome> {
  stageDeps ??= stageOutboundDeps(call.log);
  return replyToUnknownSender(stageDeps, input, call);
}
