// Test support of the WhatsApp adapter: fixtures with the real shape of End User Messaging Social's
// events, a test certificate that signs live records the way SNS does (`SignatureVersion 2`), a
// world seeded in the memory connector, an in-memory `Media` bucket and recording fakes of the ports.
// Nothing here is used outside tests and local flows.
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addressHash, type ChannelMode } from "@reclamo/shared";
import { type MemoryConnector } from "../../connector/memory/connector";
import { SIM_NOW, TEST_NOW, testConnector, worldMeta, worldSettings } from "../../connector/testing";
import { type Clock, fixedClock } from "../../lib/clock";
import { deriveSubkey } from "../../lib/crypto";
import { type Logger, createLogger } from "../../lib/log";
import { SNS_CERT_HOST, SNS_EVENT_SOURCE, STAGE_ACCOUNT_ID, waInboundTopicArn } from "./config";
import type { SnsRecord, WhatsAppSnsEvent } from "./payloads";
import type { ButtonEffects, CustomerDirectory, FixedReplies, FixedReplyRequest, InboundCustomerMessage, InboundIntake, WhatsAppInboundDeps } from "./ports";
import { type SimulatedContent, buildSimulatedEvent } from "./sim-envelope";
import { canonicalNotification, createSnsVerifier } from "./sns-signature";
import type { MediaBucket } from "./transport";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const TEST_TOPIC_ARN = waInboundTopicArn();
export const TEST_CERT_URL = `https://${SNS_CERT_HOST}/SimpleNotificationService-0000000000000000000000000000000.pem`;
/** A synthetic number of the QA reserve (docs/seed-spec.md §5): never a real phone. */
export const TEST_PHONE = "+5491100009001";
export const TEST_PHONE_KEY = deriveSubkey("PhoneHashKey", "test-phone-hash-key-of-32-characters-or-more", "phone-hash");
export const TEST_SIM_KEYS = { console: "test-console-sim-envelope-key-0123456789", qa: "test-qa-sim-envelope-key-0123456789abcdef" } as const;

/** A fixture file, with its `__PLACEHOLDER__`s replaced (values are JSON-escaped). */
export function fixture(name: string, values: Readonly<Record<string, string>> = {}): unknown {
  let text = readFileSync(join(FIXTURES, name), "utf8");
  for (const [placeholder, value] of Object.entries(values)) text = text.split(`__${placeholder}__`).join(JSON.stringify(value).slice(1, -1));
  return JSON.parse(text) as unknown;
}

// One RSA key pair per test run: the "certificate" SNS would publish is its public key in PEM.
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_CERT_PEM = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

/** The EUM envelope (`Sns.Message`) of a webhook entry, as End User Messaging Social publishes it. */
export function eumMessage(entry: unknown, overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    context: {
      MetaWabaIds: [{ wabaId: "1234567890123456", arn: `arn:aws:social-messaging:us-east-1:${STAGE_ACCOUNT_ID}:waba/0a1b2c3d4e5f60718293a4b5c6d7e8f9` }],
      MetaPhoneNumberIds: [{ metaPhoneNumberId: "1098765432109876", arn: `arn:aws:social-messaging:us-east-1:${STAGE_ACCOUNT_ID}:phone-number-id/1a2b3c4d5e6f708192a3b4c5d6e7f809` }],
    },
    whatsAppWebhookEntry: JSON.stringify(entry),
    aws_account_id: STAGE_ACCOUNT_ID,
    message_timestamp: "2026-10-07T13:15:00.000Z",
    messageId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
    ...overrides,
  });
}

/** A live SNS record of `message`, signed with the test certificate unless `signature` says otherwise. */
export function liveRecord(message: string, options: { topicArn?: string; certUrl?: string; signature?: string; version?: string } = {}): SnsRecord {
  const sns = {
    Type: "Notification",
    MessageId: "a1b2c3d4-0000-4000-8000-000000000001",
    TopicArn: options.topicArn ?? TEST_TOPIC_ARN,
    Subject: null,
    Message: message,
    Timestamp: "2026-10-07T13:15:00.412Z",
    SignatureVersion: options.version ?? "2",
    SigningCertUrl: options.certUrl ?? TEST_CERT_URL,
    MessageAttributes: {},
  };
  const signature = options.signature ?? sign("RSA-SHA256", Buffer.from(canonicalNotification(sns)), keyPair.privateKey).toString("base64");
  return { EventSource: SNS_EVENT_SOURCE, EventSubscriptionArn: `${TEST_TOPIC_ARN}:6f0c1b2a`, Sns: { ...sns, Signature: signature } };
}

/** The single record of an event built by a test. */
export function onlyRecord(event: WhatsAppSnsEvent): SnsRecord {
  const [record] = event.Records;
  if (record === undefined || event.Records.length !== 1) throw new Error("expected exactly one record");
  return record;
}

export function liveEvent(entry: unknown): WhatsAppSnsEvent {
  return { Records: [liveRecord(eumMessage(entry))] };
}

/** A simulated event of the console's simulator for `worldId`, from `TEST_PHONE`, signed at `TEST_NOW`. */
export function simEvent(worldId: string, content: SimulatedContent, wamid: string = "wamid.SIM.01K6ZT0000000000000000000A", contextWamid?: string): WhatsAppSnsEvent {
  return buildSimulatedEvent(TEST_SIM_KEYS.console, { kid: "console", worldId, from: TEST_PHONE, wamid, content, at: TEST_NOW, ...(contextWamid === undefined ? {} : { contextWamid }) });
}

/** A verifier whose certificate fetch answers the test PEM (and counts the fetches). */
export function testSnsVerifier(): { verifier: ReturnType<typeof createSnsVerifier>; fetched: string[] } {
  const fetched: string[] = [];
  return { verifier: createSnsVerifier(async (url) => (fetched.push(url), TEST_CERT_PEM)), fetched };
}

export async function testPhoneHash(phone: string = TEST_PHONE): Promise<string> {
  return addressHash("WHATSAPP", phone, TEST_PHONE_KEY);
}

/** A `READY` world with settings, a paused clock at `SIM_NOW` and the given WhatsApp mode. */
export async function seedWorld(mc: MemoryConnector, worldId: string, options: { mode?: ChannelMode; status?: "READY" | "RESETTING" | "CREATING"; rateLimitPerHour?: number } = {}): Promise<void> {
  const data = mc.connector;
  await data.worlds.register(worldMeta(worldId, { status: options.status ?? "READY" }));
  await data.worlds.putSettings({ ...worldSettings(worldId), channelModes: { whatsapp: options.mode ?? "simulated" }, rateLimitPerHour: options.rateLimitPerHour ?? 20 });
  await data.runtime.putClock({ worldId, mode: "PAUSED", pausedSimNow: new Date(SIM_NOW).toISOString(), worldEpoch: 1 });
}

/** An in-memory `Media` bucket; `put` stands for whatever writes an object (the service, a POST). */
export class MemoryBucket implements MediaBucket {
  readonly objects = new Map<string, { sizeBytes: number; contentType?: string }>();
  readonly copies: Array<{ seedKey: string; mediaKey: string }> = [];
  put(key: string, sizeBytes: number, contentType?: string): void {
    this.objects.set(key, { sizeBytes, ...(contentType === undefined ? {} : { contentType }) });
  }
  async list(prefix: string, max: number) {
    return [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).slice(0, max).map(([key, object]) => ({ key, sizeBytes: object.sizeBytes }));
  }
  async head(key: string) {
    return this.objects.get(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async copyFromSeed(seedKey: string, mediaKey: string, contentType: string) {
    this.copies.push({ seedKey, mediaKey });
    this.put(mediaKey, 120_000, contentType);
  }
}

export interface Recorded {
  readonly replies: FixedReplyRequest[];
  readonly effects: Array<{ kind: string; input: Record<string, unknown> }>;
  readonly intake: InboundCustomerMessage[];
}

/** Ports that record what the adapter asked of them. */
export function recordingPorts(customers: Readonly<Record<string, string>>): { recorded: Recorded; customers: CustomerDirectory; replies: FixedReplies; effects: ButtonEffects; intake: InboundIntake } {
  const recorded: Recorded = { replies: [], effects: [], intake: [] };
  return {
    recorded,
    customers: { findByPhoneHash: async (worldId, phoneHash) => (customers[`${worldId}#${phoneHash}`] === undefined ? undefined : { customerId: customers[`${worldId}#${phoneHash}`] ?? "" }) },
    replies: { send: async (request) => void recorded.replies.push(request) },
    effects: {
      handoff: async (input) => void recorded.effects.push({ kind: "HANDOFF", input: { ...input } }),
      optOut: async (input) => void recorded.effects.push({ kind: "OPT_OUT", input: { ...input } }),
      emailConsent: async (input) => void recorded.effects.push({ kind: "EMAIL_CONSENT", input: { ...input } }),
    },
    intake: { accept: async (message) => (recorded.intake.push(message), { outcome: "ACCEPTED" }) },
  };
}

export interface InboundRig {
  readonly mc: MemoryConnector;
  readonly deps: WhatsAppInboundDeps;
  readonly recorded: Recorded;
  readonly bucket: MemoryBucket;
  readonly lines: string[];
}

/** A whole inbound adapter over a memory connector, with `customers` keyed `<worldId>#<phoneHash>`. */
export function inboundRig(options: { customers?: Readonly<Record<string, string>>; liveWorlds?: string[]; realClock?: Clock; liveMedia?: WhatsAppInboundDeps["liveMedia"]; log?: Logger } = {}): InboundRig {
  const mc = testConnector();
  const ports = recordingPorts(options.customers ?? {});
  const bucket = new MemoryBucket();
  const lines: string[] = [];
  const deps: WhatsAppInboundDeps = {
    data: mc.connector,
    keys: { phoneHash: TEST_PHONE_KEY, simEnvelope: TEST_SIM_KEYS },
    topicArn: TEST_TOPIC_ARN,
    sns: testSnsVerifier().verifier,
    stageModes: { email: "live", whatsapp: { liveWorlds: options.liveWorlds ?? [] } },
    customers: ports.customers,
    replies: ports.replies,
    effects: ports.effects,
    intake: ports.intake,
    bucket,
    realClock: options.realClock ?? fixedClock(TEST_NOW),
    log: options.log ?? createLogger({ sink: (line) => lines.push(line), correlationId: "test" }),
    ...(options.liveMedia === undefined ? {} : { liveMedia: options.liveMedia }),
  };
  return { mc, deps, recorded: ports.recorded, bucket, lines };
}
