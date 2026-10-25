// Media of an inbound WhatsApp (docs/architecture-integrations.md §3.1-§3.2, docs/architecture.md §6,
// FL-029, FL-101, FL-103). Only a JPEG or PNG of at most 3.75 MB goes on to the scan; every other type
// gets a fixed reply and is never downloaded. Every object that lands in `Media` is announced first
// (`Runtime/W#<w>#SCANOBJ#…`), so a GuardDuty result that arrives before the message still finds it:
//
//   live       announce the PREFIX `wa/<worldId>/<wamid>/`, call `GetWhatsAppMessageMedia` with that
//              prefix as `destinationS3File.key` (the service appends the `mediaId`: the final key is
//              never predicted), find the real key with `ListObjectsV2` and record it in `s3Key`.
//              Zero or several objects under the prefix → `IMAGE_NOT_PROCESSED` (`MEDIA_KEY_UNRESOLVED`)
//   simulated  `image.id = SIM<32 hex>` resolves through `SIMMEDIA#` to its key: an upload under
//              `up/` (announced by the BFF before it signed the POST) or a seed receipt, copied
//              server-side to `<root>/sim/<messageId>/0.<ext>` after its announcement
//
// No key and no announce key depends on the shape of the `mediaId` (ADR-0002). Binding the message
// to the record and resolving the scan belong to media-intake/resolve.ts.
import { GetWhatsAppMessageMediaCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { ConnectorError } from "@reclamo/shared";
import type { Connector } from "../../connector/port";
import type { ScanSource } from "../../domain/runtime-claims";
import { awsClientConfig } from "../../lib/clients";
import type { Clock } from "../../lib/clock";
import type { RetryOptions } from "../../lib/retry";
import { deliveryKey } from "../rate-limit";
import { IMAGE_CONTENT_TYPES, type ImageContentType, LIVE_MEDIA_PREFIX, MAX_MEDIA_BYTES, MEDIA_TIMEOUTS } from "./config";
import { callEum } from "./live-transport";
import type { WaInboundMessage } from "./payloads";
import { uploadPrefixOf, worldStorageRoot } from "./media-keys";
import { SIM_MEDIA_ID } from "./sim-envelope";
import type { MediaBucket } from "./transport";

/** What the customer reads when an image is not taken (copy/es-AR.ts `WHATSAPP_TEXT`). */
export type MediaReply = "MEDIA_UNSUPPORTED" | "MEDIA_TOO_LARGE" | "IMAGE_NOT_PROCESSED";

export type MediaOutcome =
  | { readonly accepted: true; readonly announceKey: string; readonly s3Key: string; readonly source: ScanSource; readonly contentType: ImageContentType }
  | { readonly accepted: false; readonly reply: MediaReply; readonly reason: "UNSUPPORTED_TYPE" | "TOO_LARGE" | "EMPTY" | "MEDIA_KEY_UNRESOLVED" | "SIM_MEDIA_UNKNOWN" | "FOREIGN_KEY" };

/** Media types answered with a fixed text and never downloaded (images other than JPEG/PNG too). */
const UNSUPPORTED_MEDIA_TYPES: ReadonlySet<string> = new Set(["image", "document", "audio", "video", "sticker"]);

const refuse = (reply: MediaReply, reason: Extract<MediaOutcome, { accepted: false }>["reason"]): MediaOutcome => ({ accepted: false, reply, reason });

/** The declared type as JPEG or PNG, or `undefined` for anything else (`image/webp`, a PDF…). */
export function imageTypeOf(declared: string | undefined): ImageContentType | undefined {
  const type = declared?.split(";")[0]?.trim().toLowerCase();
  return IMAGE_CONTENT_TYPES.find((candidate) => candidate === type);
}

/** The image a message carries, if it is one the adapter may read; any other media is `UNSUPPORTED`. */
export function imageOf(message: WaInboundMessage): { readonly id: string; readonly contentType: ImageContentType } | "UNSUPPORTED" | undefined {
  if (message.type === "image" && message.image !== undefined) {
    const contentType = imageTypeOf(message.image.mime_type);
    return contentType === undefined ? "UNSUPPORTED" : { id: message.image.id, contentType };
  }
  return UNSUPPORTED_MEDIA_TYPES.has(message.type) ? "UNSUPPORTED" : undefined;
}


/** `wa/<worldId>/<wamid>/`: the announce key of a live image (one image per message). */
export function liveAnnounceKey(worldId: string, wamid: string): string {
  return `${LIVE_MEDIA_PREFIX}${worldId}/${deliveryKey(wamid)}/`;
}

type ScanData = Pick<Connector, "scans">;

/** Announces an object (or a prefix); a second announcement of the same one (a redelivery) is fine. */
async function announce(data: ScanData, input: { worldId: string; announceKey: string; s3Key?: string; source: ScanSource; now: Date }): Promise<void> {
  try {
    await data.scans.announce({ worldId: input.worldId, announceKey: input.announceKey, source: input.source, createdAtReal: input.now.toISOString(), ...(input.s3Key === undefined ? {} : { s3Key: input.s3Key }) });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
  }
}

/** Size check of a landed object; an object over the limit (or empty) is deleted at once. */
async function sized(bucket: MediaBucket, key: string, sizeBytes: number): Promise<MediaOutcome | undefined> {
  if (sizeBytes > MAX_MEDIA_BYTES) {
    await bucket.delete(key);
    return refuse("MEDIA_TOO_LARGE", "TOO_LARGE");
  }
  if (sizeBytes < 1) {
    await bucket.delete(key);
    return refuse("IMAGE_NOT_PROCESSED", "EMPTY");
  }
  return undefined;
}

// ---- Live -------------------------------------------------------------------------------------------

export interface LiveMediaDeps {
  /** `WhatsAppPhoneNumberId`. */
  readonly phoneNumberId: string;
  /** Physical name of the `Media` bucket. */
  readonly mediaBucketName: string;
  readonly bucket: MediaBucket;
  readonly data: ScanData;
  readonly realClock: Clock;
  readonly client?: SocialMessagingClient;
  readonly retry?: Pick<RetryOptions, "sleep" | "random">;
}

let mediaClient: SocialMessagingClient | undefined;

/** The only caller of `GetWhatsAppMessageMediaCommand` (`lint:chokepoint`). */
export async function fetchLiveImage(deps: LiveMediaDeps, input: { readonly worldId: string; readonly wamid: string; readonly mediaId: string; readonly contentType: ImageContentType }): Promise<MediaOutcome> {
  const prefix = liveAnnounceKey(input.worldId, input.wamid);
  await announce(deps.data, { worldId: input.worldId, announceKey: prefix, source: "WHATSAPP", now: await deps.realClock.now() });
  const client = deps.client ?? (mediaClient ??= new SocialMessagingClient(awsClientConfig(MEDIA_TIMEOUTS)));
  const command = new GetWhatsAppMessageMediaCommand({ mediaId: input.mediaId, originationPhoneNumberId: deps.phoneNumberId, destinationS3File: { bucketName: deps.mediaBucketName, key: prefix } });
  await callEum("whatsapp.media", true, MEDIA_TIMEOUTS.requestTimeoutMs + 1_000, () => client.send(command), deps.retry);
  const objects = await deps.bucket.list(prefix, 3);
  const only = objects.length === 1 ? objects[0] : undefined;
  if (only === undefined || !(await deps.data.scans.setS3Key(input.worldId, prefix, only.key))) {
    for (const object of objects) await deps.bucket.delete(object.key);
    return refuse("IMAGE_NOT_PROCESSED", "MEDIA_KEY_UNRESOLVED");
  }
  return (await sized(deps.bucket, only.key, only.sizeBytes)) ?? { accepted: true, announceKey: prefix, s3Key: only.key, source: "WHATSAPP", contentType: input.contentType };
}

// ---- Simulated ------------------------------------------------------------------------------------

export interface SimulatedMediaDeps {
  readonly bucket: MediaBucket;
  readonly data: Pick<Connector, "scans" | "claims">;
  readonly realClock: Clock;
}

/** A seed receipt (`Seed/receipts/…`) the simulator offers: copied into the world's root. */
const SEED_RECEIPT = /^receipts\/[a-z-]+\/[A-Za-z0-9._-]+\.(png|jpe?g)$/;

/** An upload of the simulator belongs to its world: `up/<worldId>/…`, or `<root>up/…` in QA. */
function uploadOfWorld(key: string, worldId: string): boolean {
  return key.startsWith(uploadPrefixOf(worldId)) || key.startsWith(`up/${worldId}/`);
}

export async function resolveSimulatedImage(deps: SimulatedMediaDeps, input: { readonly worldId: string; readonly messageId: string; readonly simMediaId: string }): Promise<MediaOutcome> {
  if (!SIM_MEDIA_ID.test(input.simMediaId)) return refuse("IMAGE_NOT_PROCESSED", "SIM_MEDIA_UNKNOWN");
  const media = await deps.data.claims.getSimMedia(input.worldId, input.simMediaId);
  if (media === undefined) return refuse("IMAGE_NOT_PROCESSED", "SIM_MEDIA_UNKNOWN");
  if (SEED_RECEIPT.test(media.s3Key)) {
    const extension = media.contentType === "image/png" ? "png" : "jpg";
    const target = `${worldStorageRoot(input.worldId)}sim/${input.messageId}/0.${extension}`;
    await announce(deps.data, { worldId: input.worldId, announceKey: target, s3Key: target, source: "SEED_COPY", now: await deps.realClock.now() });
    await deps.bucket.copyFromSeed(media.s3Key, target, media.contentType);
    return { accepted: true, announceKey: target, s3Key: target, source: "SEED_COPY", contentType: media.contentType };
  }
  if (!uploadOfWorld(media.s3Key, input.worldId)) return refuse("IMAGE_NOT_PROCESSED", "FOREIGN_KEY");
  const head = await deps.bucket.head(media.s3Key);
  if (head === undefined) return refuse("IMAGE_NOT_PROCESSED", "SIM_MEDIA_UNKNOWN");
  return (await sized(deps.bucket, media.s3Key, head.sizeBytes)) ?? { accepted: true, announceKey: media.s3Key, s3Key: media.s3Key, source: "SIMULATOR", contentType: media.contentType };
}
