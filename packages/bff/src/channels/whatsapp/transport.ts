// The one interface both WhatsApp transports implement (ADR-0002): the live one over End User Messaging
// Social and the simulated one of the phone simulator. The mode is per world (registry.ts picks the
// transport with the world's mode); nothing above the transport knows which one runs. A transport
// resolves the recipient itself (the live number of a customer is read only here), validates the Meta
// message and sends it; the gate (outbound/gate.ts) persists the `Message OUT` with what it returns.
import type { ChannelMode } from "@reclamo/shared";
import type { MetaMessage, WaOutbound } from "./meta-message";

/** The `Message OUT` a send belongs to. */
export interface SendRecord {
  readonly worldId: string;
  readonly customerId: string;
  readonly messageId: string;
  /**
   * The simulated number the gate resolved for this party (outbound/dispatch.ts): the simulated
   * transport takes it as is; the live one ignores it and resolves the number itself.
   */
  readonly to?: string;
}

export interface WhatsAppSendRequest {
  readonly record: SendRecord;
  readonly outbound: WaOutbound;
}

export interface WhatsAppSendResult {
  /** The id `statuses[]` refer to (index `ByProviderMessageId`). */
  readonly providerMessageId: string;
  readonly simulated: boolean;
  /** Live: `SENT` (delivery arrives by SNS). Simulated: `DELIVERED` (its synthetic statuses are recorded). */
  readonly status: "SENT" | "DELIVERED";
  /** The exact Meta JSON that went out (ADR-0002: the simulated mode keeps the same contract). */
  readonly payload: MetaMessage;
  readonly sentAtReal: string;
}

export interface WhatsAppTransport {
  readonly mode: ChannelMode;
  send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult>;
}

/**
 * Who a customer is on WhatsApp. Simulated: the persona's synthetic number. Live: `Customer.liveE164`
 * of the core, which exists only in `demo` (and the QA live world) and no tool ever returns.
 */
export interface RecipientResolver {
  whatsAppNumber(worldId: string, customerId: string, mode: ChannelMode): Promise<string | undefined>;
}

/** The status of a template as registered with Meta (`Reference/TEMPLATE#WHATSAPP/<name>`). */
export interface TemplateStatusReader {
  status(name: string): Promise<string | undefined>;
}

/** What the adapter needs of the `Media` bucket (media-store.ts implements it over S3). */
export interface MediaBucket {
  /** Keys and sizes under a prefix, at most `max`. */
  list(prefix: string, max: number): Promise<ReadonlyArray<{ readonly key: string; readonly sizeBytes: number }>>;
  head(key: string): Promise<{ readonly sizeBytes: number; readonly contentType?: string } | undefined>;
  delete(key: string): Promise<void>;
  /** Server-side copy of a seed receipt (`Seed` bucket) into `Media`. */
  copyFromSeed(seedKey: string, mediaKey: string, contentType: string): Promise<void>;
}
