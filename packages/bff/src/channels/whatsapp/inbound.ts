// The WhatsApp adapter's entry for `InboundWhatsApp` (docs/architecture-integrations.md §3,
// docs/architecture.md §13): one call per Lambda event, live (SNS from End User Messaging Social) or
// simulated (the phone simulator's signed envelope, same shape). Every record proves its origin first
// (registry.ts); a record that does not is refused and audited (`INBOUND_REJECTED`) in the world it
// names when that world exists, logged otherwise. Then the `statuses[]` of the entry update our
// messages and each of its `messages[]` goes through inbound-message.ts. `handlers/inbound-whatsapp.ts`
// builds the deps and returns the summary (the simulator reads which message a tap became).
import { WorldId } from "@reclamo/shared";
import { applyStatuses, type StatusOutcome } from "./events";
import { processInboundMessage } from "./inbound-message";
import { WhatsAppSnsEvent } from "./payloads";
import type { MessageResult, WhatsAppInboundDeps } from "./ports";
import { recordDecision } from "./records";
import { type InboundRejection, checkRecordOrigin, worldWhatsAppMode } from "./registry";

export const ENVELOPE_REJECTED_METRIC = "WhatsAppEnvelopeRejected";

export interface RecordResult {
  readonly accepted: boolean;
  readonly origin?: "LIVE" | "SIMULATED";
  readonly reason?: InboundRejection;
  readonly messages: readonly MessageResult[];
  readonly statuses: readonly StatusOutcome[];
}

export interface InboundSummary {
  readonly records: readonly RecordResult[];
}

/** `INBOUND_REJECTED` in the world a refused record names, when it exists; a metric line always. */
async function rejected(deps: WhatsAppInboundDeps, origin: "LIVE" | "SIMULATED", reason: InboundRejection, recordId: string, worldId: string | undefined, now: Date): Promise<RecordResult> {
  deps.log.warn("inbound_whatsapp.rejected", { metric: ENVELOPE_REJECTED_METRIC, reason, origin });
  if (worldId !== undefined && WorldId.safeParse(worldId).success) {
    const world = await deps.data.worlds.getMeta(worldId);
    if (world !== undefined) await recordDecision(deps.data, { worldId, epoch: world.epoch, action: "INBOUND_REJECTED", outcome: reason, wamid: recordId, at: now, detail: { origin } });
  }
  return { accepted: false, origin, reason, messages: [], statuses: [] };
}

export async function processWhatsAppEvent(event: unknown, deps: WhatsAppInboundDeps): Promise<InboundSummary> {
  const parsed = WhatsAppSnsEvent.safeParse(event);
  if (!parsed.success) {
    deps.log.warn("inbound_whatsapp.rejected", { metric: ENVELOPE_REJECTED_METRIC, reason: "INVALID_EVENT" });
    return { records: [{ accepted: false, reason: "INVALID_EVENT", messages: [], statuses: [] }] };
  }
  const records: RecordResult[] = [];
  for (const record of parsed.data.Records) {
    const now = await deps.realClock.now();
    const origin = await checkRecordOrigin(record, { topicArn: deps.topicArn, sns: deps.sns, simKeys: deps.keys.simEnvelope, now });
    if (!origin.accepted) {
      records.push(await rejected(deps, origin.origin, origin.reason, record.Sns.MessageId, origin.worldId, now));
      continue;
    }
    const isLiveWorld = async (worldId: string) => worldWhatsAppMode(worldId, await deps.data.worlds.getSettings(worldId), deps.stageModes) === "live";
    const scope = origin.origin === "SIMULATED" ? ({ simulated: true, worldId: origin.worldId } as const) : ({ simulated: false, isLiveWorld } as const);
    const envelopeAt = origin.parsed.envelope.message_timestamp;
    const context = { deps, origin: origin.origin, ...(origin.origin === "SIMULATED" ? { envelopeWorldId: origin.worldId } : {}), ...(envelopeAt === undefined ? {} : { envelopeAt }) };
    const messages: MessageResult[] = [];
    const statuses: StatusOutcome[] = [];
    for (const change of origin.parsed.changes) {
      statuses.push(...(await applyStatuses(change.statuses, { data: deps.data, log: deps.log }, scope)));
      for (const message of change.messages) messages.push(await processInboundMessage(context, message));
    }
    records.push({ accepted: true, origin: origin.origin, messages, statuses });
  }
  return { records };
}
