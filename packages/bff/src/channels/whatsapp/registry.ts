// Modes of WhatsApp per world (ADR-0002, docs/architecture-integrations.md §3, FL-104). A world runs
// `live` only when its `SETTINGS.channelModes.whatsapp` says so AND the stage lets it (the world is
// listed in `ChannelModes.whatsapp.liveWorlds` and its class may ever be live: `demo` and `qa-live-*`);
// every guest, `gtest`, `qa-*` and `sim-*` world stays `simulated`, so its phone simulator keeps
// working when WhatsApp goes live for the demo. The same mode picks the transport of an outbound
// message and decides whether an inbound record may enter the world:
//
//   live record       SNS from the app's topic with a valid signature (sns-signature.ts), no trace of
//                     the simulator, and later only for a live world (`LIVE_IN_SIMULATED_WORLD`)
//   simulated record  the simulator's signed envelope (sim-envelope.ts), only for a simulated world
//                     (`SIM_IN_LIVE_WORLD`)
import { ChannelError, type ChannelMode } from "@reclamo/shared";
import type { WorldSettings } from "../../domain/world";
import { type ChannelModes, stageAllowsLiveWhatsApp } from "../../lib/resource";
import { SIMULATED_PHONE_NUMBER_ID, SIM_WAMID_PREFIX, STAGE_ACCOUNT_ID } from "./config";
import { type ParsedEnvelope, PayloadError, type SnsRecord, parseEnvelope } from "./payloads";
import { type SimEnvelopeKeys, type SimKeyId, type SimRejection, looksSimulated, verifySimulatedRecord } from "./sim-envelope";
import type { SnsRejection, SnsVerifier } from "./sns-signature";
import type { WhatsAppTransport } from "./transport";

/** The effective WhatsApp mode of a world: `live` only with both the world and the stage saying so. */
export function worldWhatsAppMode(worldId: string, settings: Pick<WorldSettings, "channelModes"> | undefined, stage: ChannelModes): ChannelMode {
  return settings?.channelModes.whatsapp === "live" && stageAllowsLiveWhatsApp(worldId, stage) ? "live" : "simulated";
}

export interface WhatsAppTransports {
  readonly simulated: WhatsAppTransport;
  /** Absent while the phone number is `not-connected` (whatsappLiveApproval in infra/channel-modes.ts). */
  readonly live?: WhatsAppTransport;
}

/** The transport of a mode; a live world without a connected number fails instead of falling back. */
export function transportFor(transports: WhatsAppTransports, mode: ChannelMode): WhatsAppTransport {
  const transport = mode === "live" ? transports.live : transports.simulated;
  if (transport === undefined) throw new ChannelError("UNAVAILABLE", "WHATSAPP", "WhatsApp live transport is not configured (WhatsAppPhoneNumberId is not-connected)");
  if (transport.mode !== mode) throw new ChannelError("INVALID", "WHATSAPP", `a ${transport.mode} transport answered for ${mode}`);
  return transport;
}

/** Why a record never enters any world (`INBOUND_REJECTED` with this reason). */
export type InboundRejection = SnsRejection | SimRejection | "INVALID_EVENT" | "PAYLOAD_INVALID" | "ACCOUNT_MISMATCH" | "SIM_MARKERS_IN_LIVE" | "SIM_IN_LIVE_WORLD" | "LIVE_IN_SIMULATED_WORLD";

export type RecordOrigin =
  | { readonly accepted: true; readonly origin: "LIVE"; readonly parsed: ParsedEnvelope }
  | { readonly accepted: true; readonly origin: "SIMULATED"; readonly kid: SimKeyId; readonly worldId: string; readonly parsed: ParsedEnvelope }
  | { readonly accepted: false; readonly origin: "LIVE" | "SIMULATED"; readonly reason: InboundRejection; readonly worldId?: string };

export interface OriginExpectations {
  /** The app's topic (`aws-cds-hackathon-poc-reclamo-wa-inbound`, a linked resource). */
  readonly topicArn: string;
  readonly sns: SnsVerifier;
  /** The keys linked to the receiving Lambda; `InboundWhatsApp` has both. */
  readonly simKeys: SimEnvelopeKeys;
  /** Real time (the five-minute window of a simulated envelope). */
  readonly now: Date;
}

function parse(record: SnsRecord): ParsedEnvelope | undefined {
  try {
    return parseEnvelope(record.Sns.Message);
  } catch (error) {
    if (error instanceof PayloadError) return undefined;
    throw error;
  }
}

/** A simulated envelope must look simulated all the way through: phone id and every message id. */
function simulatedThroughout(parsed: ParsedEnvelope): boolean {
  return parsed.changes.every(
    (change) =>
      change.metadata.phone_number_id === SIMULATED_PHONE_NUMBER_ID &&
      change.messages.every((message) => message.id.startsWith(SIM_WAMID_PREFIX)) &&
      change.statuses.every((status) => status.id.startsWith(SIM_WAMID_PREFIX)),
  );
}

/**
 * Verifies where a record comes from. The world's mode is checked afterwards with `assertWorldMode`
 * (simulated: the envelope's world; live: the world `LIVEPHONE#` resolves the sender to).
 */
export async function checkRecordOrigin(record: SnsRecord, expect: OriginExpectations): Promise<RecordOrigin> {
  if (looksSimulated(record)) {
    const verdict = verifySimulatedRecord(record, expect.simKeys, expect.now);
    if (!verdict.ok) return { accepted: false, origin: "SIMULATED", reason: verdict.reason, ...(verdict.worldId === undefined ? {} : { worldId: verdict.worldId }) };
    const parsed = parse(record);
    if (parsed === undefined || !simulatedThroughout(parsed)) return { accepted: false, origin: "SIMULATED", reason: "PAYLOAD_INVALID", worldId: verdict.worldId };
    return { accepted: true, origin: "SIMULATED", kid: verdict.kid, worldId: verdict.worldId, parsed };
  }
  const verdict = await expect.sns.verify(record, expect.topicArn);
  if (!verdict.ok) return { accepted: false, origin: "LIVE", reason: verdict.reason };
  const parsed = parse(record);
  if (parsed === undefined) return { accepted: false, origin: "LIVE", reason: "PAYLOAD_INVALID" };
  if (parsed.envelope.aws_account_id !== STAGE_ACCOUNT_ID) return { accepted: false, origin: "LIVE", reason: "ACCOUNT_MISMATCH" };
  if (looksSimulated(record, parsed)) return { accepted: false, origin: "LIVE", reason: "SIM_MARKERS_IN_LIVE" };
  return { accepted: true, origin: "LIVE", parsed };
}

/** A record enters a world only through that world's mode; `undefined` when it may. */
export function worldModeRejection(origin: "LIVE" | "SIMULATED", mode: ChannelMode): InboundRejection | undefined {
  if (origin === "SIMULATED" && mode === "live") return "SIM_IN_LIVE_WORLD";
  if (origin === "LIVE" && mode === "simulated") return "LIVE_IN_SIMULATED_WORLD";
  return undefined;
}
