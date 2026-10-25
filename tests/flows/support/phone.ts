// What a persona does on the console's phone simulator beyond typing, as the simulator does it in the
// stage: a tap on a button of the last message that offers it (the nonce and the title the message
// carries, answering its `wamid`), an image the simulator sends (a seed receipt, or an upload under
// `up/<world>/` announced before it lands, docs/architecture.md §6), and the SES events of an email the
// world sent, built from the tags the email client put on it (what the configuration set's rule hands
// `EmailEvents`).
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import type { WaButtonAction } from "@reclamo/shared";
import type { SimulatedContent } from "@reclamo/bff/channels/whatsapp/sim-envelope";
import type { Connector } from "@reclamo/bff/connector/port";
import type { Message } from "@reclamo/bff/domain/conversation";
import type { FakeS3 } from "./fakes/s3";
import type { SentEmail } from "./stage/context";

const ACCOUNT = "776805327629";
const SOURCE = "respuestas@reclamo.demo.craftech.io";

interface WireButton {
  readonly action: string;
  readonly nonce: string;
  readonly title: string;
}

function buttonsOf(message: Message): WireButton[] {
  const interactive = message.interactive as { buttons?: unknown; rows?: unknown } | undefined;
  const list = Array.isArray(interactive?.buttons) ? interactive.buttons : Array.isArray(interactive?.rows) ? interactive.rows : [];
  return list.filter((item): item is WireButton => typeof item === "object" && item !== null && typeof (item as WireButton).nonce === "string");
}

/** The reply to the last WhatsApp of a customer that offers `action`, and the message it answers. */
export async function tapContent(connector: Connector, worldId: string, customerId: string, action: WaButtonAction): Promise<{ readonly content: SimulatedContent; readonly contextWamid?: string }> {
  const messages = await connector.conversations.listMessages(worldId, customerId);
  const offering = messages
    .filter((message) => message.direction === "OUT" && message.channel === "WHATSAPP" && buttonsOf(message).some((button) => button.action === action))
    .sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim))
    .at(-1);
  const button = offering === undefined ? undefined : buttonsOf(offering).find((candidate) => candidate.action === action);
  if (offering === undefined || button === undefined) throw new Error(`no WhatsApp of ${customerId} offers ${action}`);
  const shape = (offering.interactive as { shape?: unknown } | undefined)?.shape;
  const type = offering.templateName !== undefined ? "template_reply" : shape === "list" ? "list_reply" : "button_reply";
  return { content: { type, nonce: button.nonce, title: button.title }, ...(offering.providerMessageId === undefined ? {} : { contextWamid: offering.providerMessageId }) };
}

/** `SIM<32 hex>` from a counter: the simulator's ids are random, a test's are reproducible. */
export function localSimMediaId(sequence: number): string {
  return `SIM${sequence.toString(16).padStart(32, "0")}`;
}

/** Registers what the simulator's image stands for (`SIMMEDIA#`); answers the content to send. */
export async function simulatedImage(
  connector: Connector,
  input: { readonly worldId: string; readonly simMediaId: string; readonly s3Key: string; readonly contentType: "image/png" | "image/jpeg"; readonly at: Date; readonly caption?: string },
): Promise<SimulatedContent> {
  await connector.claims.putSimMedia({ worldId: input.worldId, simMediaId: input.simMediaId, s3Key: input.s3Key, contentType: input.contentType, createdAtReal: input.at.toISOString() });
  return { type: "image", simMediaId: input.simMediaId, mimeType: input.contentType, ...(input.caption === undefined ? {} : { caption: input.caption }) };
}

/**
 * An upload of the simulator: announced in the scan registry before it lands (as `simulator.presignReceipt`
 * does before it signs the POST), then put in `Media` as the browser's POST would. GuardDuty's verdict
 * arrives with `mediaScanned`.
 */
export async function uploadImage(connector: Connector, s3: FakeS3, input: { readonly worldId: string; readonly key: string; readonly bytes: Uint8Array; readonly contentType: "image/png" | "image/jpeg"; readonly at: Date }): Promise<void> {
  if (!input.key.startsWith(`up/${input.worldId}/`)) throw new RangeError("an upload of the simulator lives under up/<worldId>/");
  await connector.scans.announce({ worldId: input.worldId, announceKey: input.key, s3Key: input.key, source: "SIMULATOR", createdAtReal: input.at.toISOString() });
  s3.put("Media", input.key, input.bytes, input.contentType);
}

export type SesEventType = "Delivery" | "Bounce" | "Complaint" | "Reject" | "DeliveryDelay" | "Send";

const DETAIL_TYPE: Readonly<Record<SesEventType, string>> = {
  Delivery: "Email Delivered",
  Bounce: "Email Bounced",
  Complaint: "Email Complaint Received",
  Reject: "Email Rejected",
  DeliveryDelay: "Email Delivery Delayed",
  Send: "Email Sent",
};

function tagsOf(input: SendEmailCommandInput): Record<string, string[]> {
  const tags: Record<string, string[]> = { "ses:configuration-set": [input.ConfigurationSetName ?? ""] };
  for (const tag of input.EmailTags ?? []) if (tag.Name !== undefined && tag.Value !== undefined) tags[tag.Name] = [tag.Value];
  return tags;
}

/** One SES event of a sent email, shaped as the EventBridge rule of the configuration set delivers it. */
export function sesEventOf(sent: SentEmail, type: SesEventType, at: Date): Record<string, unknown> {
  const time = at.toISOString();
  const destination = sent.input.Destination?.ToAddresses ?? [];
  const detail: Record<string, unknown> = {
    eventType: type,
    mail: { timestamp: time, source: SOURCE, sendingAccountId: ACCOUNT, messageId: sent.providerMessageId, destination, tags: tagsOf(sent.input) },
  };
  const recipients = destination.map((emailAddress) => ({ emailAddress }));
  if (type === "Delivery") detail.delivery = { timestamp: time, recipients: destination, smtpResponse: "250 2.6.0 Message received", processingTimeMillis: 420 };
  if (type === "Bounce") detail.bounce = { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: recipients, timestamp: time };
  if (type === "Complaint") detail.complaint = { complainedRecipients: recipients, timestamp: time };
  if (type === "DeliveryDelay") detail.deliveryDelay = { delayType: "MailboxFull", delayedRecipients: recipients, timestamp: time };
  return { version: "0", id: `local-ses-${sent.providerMessageId}-${type}`, "detail-type": DETAIL_TYPE[type], source: "aws.ses", account: ACCOUNT, time, region: "us-east-1", resources: [], detail };
}
