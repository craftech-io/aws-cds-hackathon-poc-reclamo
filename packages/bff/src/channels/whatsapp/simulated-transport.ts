// `SimulatedWhatsAppTransport` (docs/architecture-integrations.md §3.2): validates the same Meta JSON
// with the same schema as the live transport, keeps it, and records the statuses Meta would send with
// the same `statuses[]` shape: `sent` at once, `delivered` one second later, `read` when the phone
// simulator marks the thread read. A template renders from `Reference/TEMPLATE#WHATSAPP` even while it
// is `LOCAL_ONLY` (it only has to exist). Only a simulated world ever reaches it (registry.ts).
import { ChannelError } from "@reclamo/shared";
import type { Connector } from "../../connector/port";
import type { JsonObject } from "../../domain/common";
import { isConflict } from "../../connector/errors";
import type { Clock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import { SIM_DELIVERED_AFTER_MS } from "./config";
import { applyStatuses, messageEventOf } from "./events";
import { toMetaMessage } from "./meta-message";
import type { WaStatus, WaStatusValue } from "./payloads";
import { newSimulatedWamid } from "./sim-envelope";
import type { RecipientResolver, TemplateStatusReader, WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from "./transport";

export interface SimulatedTransportDeps {
  readonly data: Pick<Connector, "conversations" | "write">;
  readonly recipients: RecipientResolver;
  readonly templates: TemplateStatusReader;
  /** Real time: the synthetic statuses carry real timestamps, as Meta's do. */
  readonly realClock: Clock;
  readonly log: Logger;
  /** Test seam for the `wamid.SIM.<id>` of each send. */
  readonly newWamid?: (nowMs: number) => string;
}

export interface SimulatedWhatsAppTransport extends WhatsAppTransport {
  readonly mode: "simulated";
  /** "Marcar leído": `read` for every delivered simulated message of the customer; answers how many changed. */
  markRead(worldId: string, customerId: string): Promise<number>;
}

/** `recipient_id` of a synthetic `read`: the event never stores it, and the thread is already known. */
const READ_RECIPIENT = "5490000000000";

function syntheticStatus(wamid: string, to: string, status: WaStatusValue, atMs: number): WaStatus {
  return { id: wamid, status, timestamp: String(Math.floor(atMs / 1_000)), recipient_id: to };
}

function invalid(message: string): ChannelError {
  return new ChannelError("INVALID", "WHATSAPP", message);
}

export function simulatedWhatsAppTransport(deps: SimulatedTransportDeps): SimulatedWhatsAppTransport {
  const newWamid = deps.newWamid ?? newSimulatedWamid;

  return {
    mode: "simulated",

    async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
      const { record, outbound } = request;
      const number = record.to ?? (await deps.recipients.whatsAppNumber(record.worldId, record.customerId, "simulated"));
      if (number === undefined) throw invalid("the customer has no WhatsApp number in this world");
      if (outbound.kind === "template" && (await deps.templates.status(outbound.name)) === undefined) {
        throw invalid(`template ${outbound.name} is not in Reference`);
      }
      const message = toMetaMessage(outbound, number);
      const sentAt = await deps.realClock.now();
      const wamid = newWamid(sentAt.getTime());
      const statuses: ReadonlyArray<readonly [WaStatusValue, number]> = [
        ["sent", sentAt.getTime()],
        ["delivered", sentAt.getTime() + SIM_DELIVERED_AFTER_MS],
      ];
      for (const [status, atMs] of statuses) {
        // `sent` keeps the exact Meta JSON, the contract both modes share (ADR-0002).
        const extra: JsonObject = status === "sent" ? { payload: JSON.parse(JSON.stringify(message)) as JsonObject } : {};
        try {
          await deps.data.write(deps.data.conversations.putEventOp(messageEventOf(syntheticStatus(wamid, message.to, status, atMs), record, true, extra)));
        } catch (error) {
          if (!isConflict(error)) throw error;
        }
      }
      return { providerMessageId: wamid, simulated: true, status: "DELIVERED", payload: message, sentAtReal: sentAt.toISOString() };
    },

    async markRead(worldId, customerId) {
      const at = (await deps.realClock.now()).getTime();
      const messages = await deps.data.conversations.listMessages(worldId, customerId);
      const statuses = messages
        .filter((message) => message.direction === "OUT" && message.channel === "WHATSAPP" && message.simulated && message.providerMessageId !== undefined && (message.status === "SENT" || message.status === "DELIVERED"))
        .map((message) => syntheticStatus(message.providerMessageId ?? "", READ_RECIPIENT, "read", at));
      const outcomes = await applyStatuses(statuses, { data: deps.data, log: deps.log }, { simulated: true, worldId });
      return outcomes.filter((outcome) => outcome.outcome === "APPLIED").length;
    },
  };
}
