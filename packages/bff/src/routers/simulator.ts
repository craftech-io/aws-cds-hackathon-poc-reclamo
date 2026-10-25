// `simulator` router (docs/tool-catalog.md "Procedimientos de la consola"; docs/architecture-integrations.md
// §3.2; ADR-0002; FL-101): the phone simulator of the console, "WhatsApp (simulado)". It answers only
// while the principal's world runs WhatsApp `simulated` (`WHATSAPP_LIVE` otherwise). The console never
// sends a phone, a nonce or a `wamid`: the BFF builds the same SNS record End User Messaging Social
// publishes, from the persona's phone, signs it with `SimEnvelopeKey` (`kid = console`) and hands it to
// `InboundWhatsApp`, so a simulated message passes the same identity, limits, classifier and gate.
//
//   personas        the 41 personas of copy/persona-scripts.ts present in the world, with their
//                   scenario and script, plus "Número no vinculado" (a phone of no customer)
//   threads         one persona's WhatsApp thread as its phone shows it (buttons without nonces) and
//                   "El agente está escribiendo…" while an event of that customer is in flight
//   sendText        a text from the persona's phone, masked like any inbound text before the envelope
//   tapButton       a tap on a button of one of our messages: the nonce is read here, never sent
//   attachReceipt   the persona's synthetic receipt (`Seed/receipts/…`, copied by `InboundWhatsApp`) or
//                   an image uploaded with `presignReceipt`; the message carries `image.id = SIM<32 hex>`
//                   and `SIMMEDIA#<id>` names the object
//   presignReceipt  a presigned POST of one JPEG or PNG of at most 3.75 MB to exactly
//                   `up/<worldId>/<id>/0.<ext>` (QA worlds: under their root), 5 minutes; the
//                   `SCANOBJ#` of that key is written BEFORE signing, so a scan result that lands before
//                   the tap on "Enviar" is kept until the message binds it (docs/architecture.md §6)
//   markRead        "Marcar leído": `read` for every delivered message of the thread
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { z } from "zod";
import { type ChannelMode, ToolError, WaButtonAction, maskPhone } from "@reclamo/shared";
import { normalizeInboundText } from "../channels/normalizer";
import { IMAGE_CONTENT_TYPES, type ImageContentType, MAX_MEDIA_BYTES } from "../channels/whatsapp/config";
import { uploadPrefixOf } from "../channels/whatsapp/media-keys";
import type { WhatsAppSnsEvent } from "../channels/whatsapp/payloads";
import { worldWhatsAppMode } from "../channels/whatsapp/registry";
import { type SimKeyId, type SimulatedContent, buildSimulatedEvent, newSimMediaId, newSimulatedWamid } from "../channels/whatsapp/sim-envelope";
import { simulatedWhatsAppTransport } from "../channels/whatsapp/simulated-transport";
import { BUTTON_TITLES, PERSONA_SCRIPTS, type PersonaScript, UNLINKED_NUMBER_SCRIPT, personaScript } from "../copy";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import type { Message } from "../domain/conversation";
import { awsClientConfig } from "../lib/clients";
import { ulid } from "../lib/crypto";
import { bucketName, channelModes, readLinked } from "../lib/resource";
import { keySecret } from "../lib/secrets";
import type { ContextDeps } from "./deps";
import { PRESIGNED_TTL_SECONDS } from "./register";
import { accessProcedure } from "./roles";
import { type WorldContext, router } from "./trpc";

export interface PresignedUpload {
  readonly url: string;
  readonly fields: Record<string, string>;
}

/** What the simulator reaches; tests and the local UI server bind their own. */
export interface SimulatorPorts {
  readonly connector: Connector;
  /** The world's effective WhatsApp mode (its settings within what the stage allows). */
  readonly whatsAppMode: (worldId: string) => Promise<ChannelMode>;
  /** `SimEnvelopeKey`, the console's key (`kid = console`); the QaDriver's `QaSimEnvelopeKey` with `kid = qa`. */
  readonly envelopeKey: () => string;
  /** The key's id; `console` unless the QaDriver runs the console in process (`qa`, valid only in QA worlds). */
  readonly envelopeKid?: SimKeyId;
  /** Hands the signed record to `InboundWhatsApp` and returns its summary. */
  readonly deliver: (event: WhatsAppSnsEvent) => Promise<unknown>;
  /** A presigned POST of exactly one image to `key` in `Media`. */
  readonly presignUpload: (key: string, contentType: ImageContentType) => Promise<PresignedUpload>;
  /** New `SIM<32 hex>` media ids; random by default. */
  readonly newMediaId?: () => string;
}

declare module "./deps" {
  interface ContextDeps {
    /** `simulator.*` (routers/simulator.ts); the linked resources when absent. */
    readonly simulatorPorts?: SimulatorPorts;
  }
}

/** Refusal `reason` of every `simulator.*` procedure while the world runs WhatsApp live. */
export const LIVE_MODE_REASON = "WHATSAPP_LIVE";

/** "Número no vinculado": a phone in the non-assignable range that no world gives to a customer (FL-002). */
export const UNLINKED_PHONE = "+5491100003000";

export const PersonaId = z.string().regex(/^C(0[1-9]|[1-3]\d|4[01])$/, "invalid persona");
export const PersonaRef = z.union([PersonaId, z.literal("UNLINKED")]);
export type PersonaRef = z.infer<typeof PersonaRef>;

/** Persona `Cnn` is customer `cus-00nn` with phone `+54911000010nn` (docs/seed-spec.md §5). */
export function personaCustomerId(personaId: string): string {
  return `cus-${personaId.slice(1).padStart(4, "0")}`;
}

export function personaPhone(persona: PersonaRef): string {
  return persona === "UNLINKED" ? UNLINKED_PHONE : `+5491100001${persona.slice(1).padStart(3, "0")}`;
}

/** `receipts/<variant>/<cnn>-<seq>.png`: the persona's synthetic receipt in `Seed`. */
export function scriptReceiptKey(script: PersonaScript): string | undefined {
  const attachment = script.messages.map((message) => message.attachment).find((candidate) => candidate?.kind === "RECEIPT_IMAGE");
  if (attachment?.kind !== "RECEIPT_IMAGE") return undefined;
  return `receipts/${attachment.variant}/${script.id.toLowerCase()}-${attachment.seq}.png`;
}

// Two tries within the Bff's 20 s: a repeated record carries the same `wamid`, which the intake handles once.
const LAMBDA_TIMEOUTS = { requestTimeoutMs: 8_000, connectionTimeoutMs: 1_000, maxAttempts: 2 } as const;
const S3_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;
const FunctionLink = z.object({ name: z.string().min(1) });

/** `lambda:Invoke` (request-response) of the linked `InboundWhatsApp`, with the record as its event. */
export function lambdaInboundDelivery(client: LambdaClient = new LambdaClient(awsClientConfig(LAMBDA_TIMEOUTS))): SimulatorPorts["deliver"] {
  return async (event) => {
    const output = await client.send(new InvokeCommand({ FunctionName: readLinked("InboundWhatsApp", FunctionLink).name, Payload: new TextEncoder().encode(JSON.stringify(event)) }));
    if (output.FunctionError !== undefined || output.Payload === undefined) throw new ToolError("UNAVAILABLE", "the WhatsApp intake did not answer", "INBOUND_FAILED");
    return JSON.parse(new TextDecoder().decode(output.Payload)) as unknown;
  };
}

/** The conditions of every upload: the exact key, one image type, 1 byte to 3.75 MB, 5 minutes. */
export function s3UploadPresigner(client: S3Client = new S3Client(awsClientConfig(S3_TIMEOUTS))): SimulatorPorts["presignUpload"] {
  return (key, contentType) =>
    createPresignedPost(client, {
      Bucket: bucketName("Media"),
      Key: key,
      Fields: { "Content-Type": contentType },
      Conditions: [["content-length-range", 1, MAX_MEDIA_BYTES], ["eq", "$Content-Type", contentType], ["eq", "$key", key]],
      Expires: PRESIGNED_TTL_SECONDS,
    });
}

let stagePorts: SimulatorPorts | undefined;

function simulatorPortsOf(deps: ContextDeps): SimulatorPorts {
  if (deps.simulatorPorts) return deps.simulatorPorts;
  const connector = dynamoConnector();
  stagePorts ??= {
    connector,
    whatsAppMode: async (worldId) => worldWhatsAppMode(worldId, await connector.worlds.getSettings(worldId), channelModes()),
    envelopeKey: () => keySecret("SimEnvelopeKey"),
    deliver: lambdaInboundDelivery(),
    presignUpload: s3UploadPresigner(),
  };
  return stagePorts;
}

async function portsFor(ctx: WorldContext): Promise<SimulatorPorts> {
  const ports = simulatorPortsOf(ctx.deps);
  if ((await ports.whatsAppMode(ctx.principal.worldId)) !== "simulated") throw new ToolError("CONFLICT", "the phone simulator is off while WhatsApp runs live in this world", LIVE_MODE_REASON);
  return ports;
}

/** What `InboundWhatsApp` answered, reduced to what the phone shows (never a payload). */
const InboundAnswer = z.looseObject({
  records: z.array(z.looseObject({ accepted: z.boolean(), reason: z.string().optional(), messages: z.array(z.looseObject({ outcome: z.string() })).default([]) })),
});

async function send(ctx: WorldContext, ports: SimulatorPorts, persona: PersonaRef, content: SimulatedContent, contextWamid?: string) {
  const at = ctx.deps.wallClock();
  const wamid = newSimulatedWamid(at.getTime());
  const event = buildSimulatedEvent(ports.envelopeKey(), { kid: ports.envelopeKid ?? "console", worldId: ctx.principal.worldId, from: personaPhone(persona), wamid, content, at, ...(contextWamid ? { contextWamid } : {}) });
  const answer = InboundAnswer.safeParse(await ports.deliver(event));
  const record = answer.success ? answer.data.records[0] : undefined;
  ctx.log.info("simulator.sent", { persona, content: content.type, accepted: record?.accepted ?? null, reason: record?.reason ?? null });
  return { persona, wamid, accepted: record?.accepted ?? false, reason: record?.reason ?? null, outcomes: record?.messages.map((message) => message.outcome) ?? [] };
}

const InteractiveButtons = z.looseObject({
  shape: z.enum(["buttons", "list"]).optional(),
  buttons: z.array(z.looseObject({ action: WaButtonAction, nonce: z.string().min(1), title: z.string().max(80).optional() })),
});

function buttonsOf(message: Message) {
  const parsed = InteractiveButtons.safeParse(message.interactive);
  if (!parsed.success || message.direction !== "OUT") return [];
  const form = message.templateName !== undefined ? "QUICK_REPLY" : parsed.data.shape === "list" ? "LIST_ROW" : "INTERACTIVE";
  return parsed.data.buttons.map((button, index) => ({
    index,
    action: button.action,
    nonce: button.nonce,
    title: button.title ?? BUTTON_TITLES[button.action][form] ?? Object.values(BUTTON_TITLES[button.action])[0] ?? button.action,
    content: (message.templateName !== undefined ? "template_reply" : parsed.data.shape === "list" ? "list_reply" : "button_reply") as "template_reply" | "list_reply" | "button_reply",
  }));
}

/** The phone's view of a message: no nonce, no key, no provider payload. */
function phoneMessage(message: Message) {
  return {
    messageId: message.messageId,
    direction: message.direction,
    body: message.body,
    templateName: message.templateName ?? null,
    buttons: buttonsOf(message).map(({ index, action, title }) => ({ index, action, title })),
    image: message.media ? { contentType: message.media.contentType ?? null, scan: message.media.scan ?? null } : null,
    status: message.status,
    atSim: message.atSim,
    // When it was stored: orders the messages of one paused minute (message → receipt → answer).
    ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
  };
}

function customerOf(persona: PersonaRef): string {
  if (persona === "UNLINKED") throw new ToolError("INVALID", "the unlinked number has no thread in this world", "SIM_UNLINKED");
  return personaCustomerId(persona);
}

const ExtensionOf: Readonly<Record<ImageContentType, string>> = { "image/jpeg": "jpg", "image/png": "png" };
const ImageType = z.enum(IMAGE_CONTENT_TYPES);
/** `<prefix><uploadId>/0.<ext>`: the only keys an upload of the world may have. */
export function uploadKeyOf(worldId: string, uploadId: string, contentType: ImageContentType): string {
  return `${uploadPrefixOf(worldId)}${uploadId}/0.${ExtensionOf[contentType]}`;
}

const UPLOAD_NAME = /^up-[0-9a-z]{26}\/0\.(jpg|png)$/;

/** The image type of an upload key of this world; anything else was not uploaded from this simulator. */
function uploadContentType(worldId: string, key: string): ImageContentType {
  const prefix = uploadPrefixOf(worldId);
  const match = key.startsWith(prefix) ? UPLOAD_NAME.exec(key.slice(prefix.length)) : null;
  if (match === null) throw new ToolError("INVALID", "that image was not uploaded from this simulator", "SIM_MEDIA_KEY");
  return match[1] === "png" ? "image/png" : "image/jpeg";
}

export const PersonaInput = z.object({ persona: PersonaRef }).strict();
export const SendTextInput = z.object({ persona: PersonaRef, text: z.string().trim().min(1).max(1_000) }).strict();
export const TapButtonInput = z.object({ persona: PersonaId, messageId: z.string().min(1).max(160), buttonIndex: z.number().int().min(0).max(9) }).strict();
export const AttachSource = z.discriminatedUnion("kind", [z.object({ kind: z.literal("SCRIPT") }).strict(), z.object({ kind: z.literal("UPLOAD"), key: z.string().min(1).max(512) }).strict()]);
export const AttachReceiptInput = z.object({ persona: PersonaId, source: AttachSource, caption: z.string().trim().min(1).max(200).optional() }).strict();
export const PresignReceiptInput = z.object({ persona: PersonaId, contentType: ImageType, sizeBytes: z.number().int().min(1).max(MAX_MEDIA_BYTES) }).strict();

export const simulatorRouter = router({
  personas: accessProcedure("simulator.personas").query(async ({ ctx }) => {
    const ports = await portsFor(ctx);
    const present = await Promise.all(PERSONA_SCRIPTS.map(async (script) => (await ports.connector.conversations.getMeta(ctx.principal.worldId, personaCustomerId(script.id))) !== undefined));
    const personas = PERSONA_SCRIPTS.filter((_script, index) => present[index]).map((script) => ({
      persona: script.id,
      customerId: personaCustomerId(script.id),
      name: script.name,
      phoneMasked: maskPhone(personaPhone(script.id)),
      scenario: script.scenario,
      scenarioEn: script.scenarioEn,
      script: script.messages.map((message) => ({ text: message.text, en: message.en, receipt: message.attachment?.kind === "RECEIPT_IMAGE" })),
      hasReceipt: scriptReceiptKey(script) !== undefined,
    }));
    return { personas, unlinked: { persona: "UNLINKED" as const, phoneMasked: maskPhone(UNLINKED_PHONE), text: UNLINKED_NUMBER_SCRIPT.text, en: UNLINKED_NUMBER_SCRIPT.en } };
  }),

  threads: accessProcedure("simulator.threads")
    .input(PersonaInput)
    .query(async ({ ctx, input }) => {
      const ports = await portsFor(ctx);
      const customerId = customerOf(input.persona);
      const [messages, state] = await Promise.all([ports.connector.conversations.listMessages(ctx.principal.worldId, customerId), ports.connector.runtime.getWorldState(ctx.principal.worldId)]);
      return {
        persona: input.persona,
        messages: messages.filter((message) => message.channel === "WHATSAPP").map(phoneMessage),
        typing: state.inFlight.some((token) => token.startsWith(`${customerId}#`)),
      };
    }),

  sendText: accessProcedure("simulator.sendText")
    .input(SendTextInput)
    .mutation(async ({ ctx, input }) => {
      const ports = await portsFor(ctx);
      return send(ctx, ports, input.persona, { type: "text", text: normalizeInboundText(input.text, ctx.principal.worldId).text });
    }),

  tapButton: accessProcedure("simulator.tapButton")
    .input(TapButtonInput)
    .mutation(async ({ ctx, input }) => {
      const ports = await portsFor(ctx);
      const message = await ports.connector.conversations.findMessage(ctx.principal.worldId, personaCustomerId(input.persona), input.messageId);
      const button = message === undefined ? undefined : buttonsOf(message)[input.buttonIndex];
      if (message === undefined || button === undefined) throw new ToolError("NOT_FOUND", "that message has no such button", "SIM_BUTTON_NOT_FOUND");
      return send(ctx, ports, input.persona, { type: button.content, nonce: button.nonce, title: button.title }, message.providerMessageId);
    }),

  attachReceipt: accessProcedure("simulator.attachReceipt")
    .input(AttachReceiptInput)
    .mutation(async ({ ctx, input }) => {
      const ports = await portsFor(ctx);
      const { worldId } = ctx.principal;
      let s3Key: string;
      let contentType: ImageContentType;
      if (input.source.kind === "SCRIPT") {
        const script = personaScript(input.persona as `C${string}`);
        const seedKey = script === undefined ? undefined : scriptReceiptKey(script);
        if (seedKey === undefined) throw new ToolError("NOT_FOUND", "this persona has no synthetic receipt", "SIM_NO_RECEIPT");
        s3Key = seedKey;
        contentType = "image/png";
      } else {
        contentType = uploadContentType(worldId, input.source.key);
        const scan = await ports.connector.scans.get(worldId, input.source.key);
        if (scan === undefined || scan.source !== "SIMULATOR" || scan.messageId !== undefined) throw new ToolError("INVALID", "that image was not uploaded from this simulator", "SIM_MEDIA_KEY");
        s3Key = input.source.key;
      }
      const simMediaId = (ports.newMediaId ?? newSimMediaId)();
      await ports.connector.claims.putSimMedia({ worldId, simMediaId, s3Key, contentType, createdAtReal: ctx.deps.wallClock().toISOString() });
      return send(ctx, ports, input.persona, { type: "image", simMediaId, mimeType: contentType, ...(input.caption ? { caption: normalizeInboundText(input.caption, worldId).text } : {}) });
    }),

  presignReceipt: accessProcedure("simulator.presignReceipt")
    .input(PresignReceiptInput)
    .mutation(async ({ ctx, input }) => {
      const ports = await portsFor(ctx);
      const now = ctx.deps.wallClock();
      const key = uploadKeyOf(ctx.principal.worldId, `up-${ulid(now.getTime()).toLowerCase()}`, input.contentType);
      // The registry first: GuardDuty scans as soon as the object lands, maybe before the tap on "Enviar".
      await ports.connector.scans.announce({ worldId: ctx.principal.worldId, announceKey: key, s3Key: key, source: "SIMULATOR", createdAtReal: now.toISOString() });
      const post = await ports.presignUpload(key, input.contentType);
      return { url: post.url, fields: post.fields, key, maxBytes: MAX_MEDIA_BYTES, expiresInSeconds: PRESIGNED_TTL_SECONDS };
    }),

  markRead: accessProcedure("simulator.markRead")
    .input(PersonaInput)
    .mutation(async ({ ctx, input }) => {
      const ports = await portsFor(ctx);
      const customerId = customerOf(input.persona);
      const transport = simulatedWhatsAppTransport({
        data: ports.connector,
        recipients: { whatsAppNumber: async () => undefined },
        templates: { status: async () => undefined },
        realClock: { now: async () => ctx.deps.wallClock() },
        log: ctx.log,
      });
      return { persona: input.persona, marked: await transport.markRead(ctx.principal.worldId, customerId) };
    }),
});
