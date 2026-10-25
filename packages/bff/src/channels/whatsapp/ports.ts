// What the inbound WhatsApp adapter needs from the rest of the system. `handlers/inbound-whatsapp.ts`
// (WP-32) builds these from the real modules: the core client (the customer of a phone hash), the
// outbound gate for the fixed replies (`sendThroughGate`, sender `SYSTEM`), the deterministic button
// handlers and the intake (classifier, acknowledgement, enqueue). The adapter decides the order and
// what happens; the ports only do it.
import type { ChannelMode, HandoffReason, MessageKind, WaButtonAction } from "@reclamo/shared";
import type { WhatsAppTextKey } from "../../copy";
import type { Connector } from "../../connector/port";
import type { Clock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import type { ChannelModes } from "../../lib/resource";
import type { NormalizedText } from "../normalizer";
import type { LiveMediaDeps, MediaOutcome } from "./media";
import type { ButtonToIssue } from "./nonces";
import type { SimEnvelopeKeys } from "./sim-envelope";
import type { SnsVerifier } from "./sns-signature";
import type { MediaBucket } from "./transport";

/** `phoneHash` → the customer of the world (unique by `PHONE#`), from the core (`getCustomerByPhone`). */
export interface CustomerDirectory {
  findByPhoneHash(worldId: string, phoneHash: string): Promise<{ readonly customerId: string } | undefined>;
}

/** A fixed text of copy/es-AR.ts the system (`SYSTEM`, never the model) sends back through the gate. */
export interface FixedReplyRequest {
  readonly worldId: string;
  /** Absent for a number that is not a customer of the world (FL-002). */
  readonly customerId?: string;
  readonly phoneHash: string;
  /** The sender's number as Meta writes it (digits): the simulator's thread of an unknown number. */
  readonly waId: string;
  readonly kind: MessageKind;
  readonly textKey: WhatsAppTextKey;
  /** Interactive reply buttons (the ambiguous "baja"); the gate issues their nonces. */
  readonly buttons?: readonly ButtonToIssue[];
  /** Id of the `Message OUT`, derived from the inbound `wamid`: a redelivery never sends twice. */
  readonly messageId: string;
  /** The customer's message it answers: it opened the window. */
  readonly inReplyTo: { readonly wamid: string; readonly messageId?: string };
  readonly atSim: string;
}

export interface FixedReplies {
  send(request: FixedReplyRequest): Promise<void>;
}

interface EffectBase {
  readonly worldId: string;
  readonly customerId: string;
  /** The `Message IN` that carried the button or the keyword. */
  readonly sourceMessageId: string;
  readonly atSim: string;
}

/** Effects decided by code, without a turn (docs/tool-catalog.md "Handlers de invocación directa"). */
export interface ButtonEffects {
  /** `escalate_to_human(CUSTOMER_ASKED)`: the open complaint to `HUMAN_REVIEW`, or a task of the conversation. */
  handoff(input: EffectBase & { readonly reason: HandoffReason; readonly complaintId?: string }): Promise<void>;
  /** `Customer.optOut` with its history; the confirmation goes as a fixed reply. */
  optOut(input: EffectBase & { readonly via: "BUTTON" | "KEYWORD" }): Promise<void>;
  /** `record_email_consent` (nonce `ACCEPT_EMAIL` / `DECLINE_EMAIL`). */
  emailConsent(input: EffectBase & { readonly accepted: boolean; readonly complaintId?: string }): Promise<void>;
}

/** A customer's message, verified, admitted, stored and masked: what the intake classifies (WP-32). */
export interface InboundCustomerMessage {
  readonly worldId: string;
  readonly epoch: number;
  readonly customerId: string;
  readonly phoneHash: string;
  readonly origin: "LIVE" | "SIMULATED";
  readonly wamid: string;
  /** The stored `Message IN`. */
  readonly messageId: string;
  readonly atSim: string;
  /** When the adapter received it (real), and when the provider says it was sent (`ackLatencyMs`). */
  readonly receivedAtReal: string;
  readonly eventAtReal: string;
  readonly text: NormalizedText;
  /** A button whose nonce resolved and that needs the agent (`CHOOSE_LOAN`, `SEE_DETAIL`…). */
  readonly button?: { readonly action: WaButtonAction; readonly complaintId?: string; readonly loanId?: string };
  /** A tap whose nonce did not resolve: its title is read as free text. */
  readonly refusedButton?: boolean;
  /** An image announced and in `Media`, waiting for its scan (media-intake/resolve.ts binds it). */
  readonly media?: Extract<MediaOutcome, { accepted: true }>;
}

export interface InboundIntake {
  accept(message: InboundCustomerMessage): Promise<{ readonly outcome: string }>;
}

export interface WhatsAppKeys {
  /** `PhoneHashKey` subkey `phone-hash` (lib/crypto.ts `deriveSubkey`). */
  readonly phoneHash: Uint8Array;
  /** `SimEnvelopeKey` (`console`) and `QaSimEnvelopeKey` (`qa`), as linked to `InboundWhatsApp`. */
  readonly simEnvelope: SimEnvelopeKeys;
}

export interface WhatsAppInboundDeps {
  readonly data: Connector;
  readonly keys: WhatsAppKeys;
  /** The app's topic, live records must come from. */
  readonly topicArn: string;
  readonly sns: SnsVerifier;
  /** `ChannelModes` of the stage (lib/resource.ts): which worlds may ever be live. */
  readonly stageModes: ChannelModes;
  readonly customers: CustomerDirectory;
  readonly replies: FixedReplies;
  readonly effects: ButtonEffects;
  readonly intake: InboundIntake;
  /** Live media (absent while the number is not configured, whatsappLiveApproval in infra/channel-modes.ts: a live image is then not processed). */
  readonly liveMedia?: Omit<LiveMediaDeps, "data" | "realClock" | "bucket">;
  readonly bucket: MediaBucket;
  /** Real time: abuse caps, nonce ages, the simulated envelope's window, audit stamps. */
  readonly realClock: Clock;
  readonly log: Logger;
}

/** What one message became, for the handler's summary (the simulator reads the message id). */
export type MessageOutcome =
  | "DUPLICATE"
  | "REJECTED"
  | "DISCARDED"
  | "NO_LIVE_WORLD"
  | "UNKNOWN_SENDER"
  | "RATE_LIMITED"
  | "HANDOFF"
  | "OPTED_OUT"
  | "EMAIL_CONSENT"
  | "BAJA_CHOICE"
  | "MEDIA_REJECTED"
  | "IGNORED"
  | "INTAKE";

export interface MessageResult {
  readonly wamid: string;
  readonly outcome: MessageOutcome;
  readonly worldId?: string;
  readonly mode?: ChannelMode;
  readonly customerId?: string;
  readonly messageId?: string;
  /** The intake's own outcome (`ACKNOWLEDGED`, `TURN`, …). */
  readonly intake?: string;
  readonly reason?: string;
}
