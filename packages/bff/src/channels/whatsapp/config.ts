// Fixed values of the WhatsApp adapter (ADR-0002, docs/architecture-integrations.md §3): the Meta API
// version of every live send, the markers of the phone simulator's envelope, the topic live events
// come from, the media limits and the SDK budgets. Nothing here is read from the environment; the
// connected phone number and the WABA are secrets (lib/secrets.ts), the topic ARN a linked resource.
import type { ClientTimeouts } from "../../lib/clients";

/** `metaApiVersion` of `SendWhatsAppMessage`; changing it is a reviewed change, never a runtime value. */
export const META_API_VERSION = "v20.0";

/** Meta product of every Cloud API message. */
export const MESSAGING_PRODUCT = "whatsapp";

/** Language of every template (docs/architecture-integrations.md §3.3). */
export const TEMPLATE_LANGUAGE_CODE = "es_AR";

/** `metaPhoneNumberId` and `metadata.phone_number_id` of an envelope built by the phone simulator. */
export const SIMULATED_PHONE_NUMBER_ID = "simulated";

/** Every simulated message id: inbound from the phone simulator and outbound from the simulated transport. */
export const SIM_WAMID_PREFIX = "wamid.SIM.";

/** `EventSource` of a record the phone simulator (BFF or `QaDriver`) hands to `InboundWhatsApp`. */
export const SIM_EVENT_SOURCE = "reclamo:sim";

/** `EventSource` of a record SNS delivers. */
export const SNS_EVENT_SOURCE = "aws:sns";

/** SNS message attributes of the simulated envelope (sim-envelope.ts). */
export const SIM_ATTRIBUTES = {
  kid: "reclamo-sim-kid",
  worldId: "reclamo-sim-world",
  ts: "reclamo-sim-ts",
  signature: "reclamo-sim-signature",
} as const;

/** A simulated envelope is accepted up to five real minutes after it was signed (either way). */
export const SIM_ENVELOPE_MAX_AGE_MS = 5 * 60_000;

/** Region and account of the stage (CLAUDE.md, "Cuenta"). */
export const STAGE_REGION = "us-east-1";
export const STAGE_ACCOUNT_ID = "776805327629";

/** Topic the WABA's event destination publishes to; it exists in every mode (docs/architecture.md §1). */
export const WA_INBOUND_TOPIC_NAME = "aws-cds-hackathon-poc-reclamo-wa-inbound";

export function waInboundTopicArn(region: string = STAGE_REGION, accountId: string = STAGE_ACCOUNT_ID): string {
  return `arn:aws:sns:${region}:${accountId}:${WA_INBOUND_TOPIC_NAME}`;
}

/** The only host a live record's `SigningCertUrl` may point to (docs/architecture.md §13). */
export const SNS_CERT_HOST = `sns.${STAGE_REGION}.amazonaws.com`;

/** Images Bedrock can read, and the most it reads per image: 3.75 MB (docs/architecture-integrations.md §3.1). */
export const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];
export const MAX_MEDIA_BYTES = 3_932_160;

/** `Media` prefix of live WhatsApp media (`wa/<worldId>/<wamid>/`, ADR-0002). */
export const LIVE_MEDIA_PREFIX = "wa/";

/** `IDEMP#WHATSAPP#<wamid>`: an inbound message is processed once (FL-106). */
export const INBOUND_IDEMPOTENCY_SOURCE = "WHATSAPP";
/** `IDEMP#WA_RECEIVED#<wamid>`: the simulated instant and message id a redelivery reuses. */
export const INBOUND_RECEIPT_SOURCE = "WA_RECEIVED";
/** `IDEMP#RATE_NOTICE#<hash>-<hour>`: the "too many messages" reply goes once per sender and real hour. */
export const RATE_NOTICE_SOURCE = "RATE_NOTICE";

/** A simulated outbound message is `sent` at once and `delivered` one second later (§3.2). */
export const SIM_DELIVERED_AFTER_MS = 1_000;

/** A button nonce lives seven real days (docs/architecture-integrations.md §4, step 2). */
export const NONCE_TTL_MS = 7 * 24 * 60 * 60_000;

/** The customer's window: 24 hours from their last message (simulated clock in `simulated`, ADR-0002). */
export const WINDOW_MS = 24 * 60 * 60_000;

// End User Messaging Social answers in well under a second; the media download writes to S3 on
// AWS's side and may take longer. The SDK makes one attempt so our own retries bound the total.
export const SEND_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };
export const MEDIA_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 15_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };
export const S3_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

/** Our own retries around a call of End User Messaging Social. */
export const EUM_RETRY = { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 } as const;

/** Fetching an SNS signing certificate: a few seconds, then the record is refused (and SNS retries). */
export const CERT_FETCH_TIMEOUT_MS = 3_000;
