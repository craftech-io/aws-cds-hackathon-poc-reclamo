// Test kit of the email channel: a client over the memory connector, a recording stand-in for the SES
// transport and for the `Emails` bucket, a minimal PDF and a valid request. Addresses are SES mailbox
// simulator ones only.
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import type { Connector } from "../../connector/port";
import { TEST_NOW, testConnector } from "../../connector/testing";
import { type LogSink, createLogger } from "../../lib/log";
import { configurationSetName } from "./config";
import { type EmailClient, type EmailSendRequest, type SesSendFn, createEmailClient } from "./outbound";
import type { EmailObjectStore } from "./store";

export const TEST_CONFIGURATION_SET = configurationSetName("aws-cds-hackathon-poc-reclamo", "poc");
export const TEST_MAIL_ID = "01JZ0000000000000000000001";
export const TEST_PROVIDER_ID = "0100019a-test-0000-0000-000000000001-000000";

/** The smallest bytes the attachment check accepts as a PDF. */
export const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

export function sendRequest(overrides: Partial<EmailSendRequest> = {}): EmailSendRequest {
  return {
    worldId: "g01",
    epoch: 1,
    customerId: "cus-0001",
    complaintId: "cmp-0001",
    messageId: "msg-0001",
    kind: "ACK_EMAIL",
    to: "success+g01-cus-0001@simulator.amazonses.com",
    subject: "Reclamo R-2026-000123 · Acuse de recibo",
    text: "Hola Ana:\n\nRegistramos tu reclamo R-2026-000123.",
    html: "<p>Hola Ana:</p><p>Registramos tu reclamo R-2026-000123.</p>",
    attachments: [{ filename: "acuse-R-2026-000123.pdf", docKind: "ACK", s3Key: "W/g01/complaints/cmp-0001/ACK-1.pdf", bytes: PDF_BYTES }],
    sentAtSim: "2026-10-07T10:10:00-03:00",
    mailId: TEST_MAIL_ID,
    ...overrides,
  };
}

export interface EmailKit {
  readonly client: EmailClient;
  readonly connector: Connector;
  /** Every `SendEmail` input, in order. */
  readonly sent: SendEmailCommandInput[];
  /** Every object written to `Emails`, by key. */
  readonly objects: Map<string, { body: Uint8Array; contentType: string }>;
  /** What happened, in order (`put:<key>`, `ses`), to prove what runs before SES. */
  readonly trail: string[];
  /** Every log line. */
  readonly lines: string[];
}

export interface EmailKitOptions {
  readonly demoRecipients?: readonly string[];
  /** Replaces the default SES stand-in (which answers `TEST_PROVIDER_ID`). */
  readonly ses?: SesSendFn;
  readonly connector?: Connector;
  readonly now?: () => Date;
}

export function emailKit(options: EmailKitOptions = {}): EmailKit {
  const connector = options.connector ?? testConnector().connector;
  const sent: SendEmailCommandInput[] = [];
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const trail: string[] = [];
  const lines: string[] = [];
  const sink: LogSink = (line) => void lines.push(line);
  const store: EmailObjectStore = {
    async put(key, body, contentType) {
      trail.push(`put:${key}`);
      objects.set(key, { body, contentType });
    },
  };
  const ses: SesSendFn = async (input, signal) => {
    trail.push("ses");
    sent.push(input);
    return options.ses ? options.ses(input, signal) : { MessageId: TEST_PROVIDER_ID };
  };
  const client = createEmailClient({
    connector,
    objects: store,
    sendRaw: ses,
    demoRecipients: () => options.demoRecipients ?? [],
    configurationSet: TEST_CONFIGURATION_SET,
    stage: "poc",
    now: options.now ?? (() => new Date(TEST_NOW.getTime())),
    newMailId: () => TEST_MAIL_ID,
    log: createLogger({ correlationId: "test", sink }),
  });
  return { client, connector, sent, objects, trail, lines };
}
