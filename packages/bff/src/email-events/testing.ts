// Test kit of `EmailEvents` and `record_email_event`: SES configuration-set events shaped as
// EventBridge delivers them (simulator recipients only), and a world with one sent email.
import type { Connector } from "../connector/port";
import { email } from "../connector/testing";
import type { EmailRecord } from "../domain/conversation";
import type { NewOf } from "../connector/codec";
import { TEST_CONFIGURATION_SET, TEST_MAIL_ID, TEST_PROVIDER_ID } from "../channels/email/testing";

export const TEST_ACCOUNT = "776805327629";
export const SENT_AT_SIM = "2026-10-07T10:10:00-03:00";

export type SesDetailType = "Email Sent" | "Email Delivered" | "Email Bounced" | "Email Complaint Received" | "Email Rejected" | "Email Delivery Delayed" | "Email Rendering Failed" | "Email Opened";

export interface SesEventOptions {
  readonly worldId?: string;
  readonly epoch?: string;
  readonly mailId?: string;
  readonly providerMessageId?: string;
  readonly account?: string;
  readonly configurationSet?: string;
  readonly bounceType?: "Permanent" | "Transient" | "Undetermined";
  readonly time?: string;
  readonly tags?: Record<string, string[]>;
  readonly source?: string;
}

/** One SES event as the EventBridge rule hands it to `EmailEvents`. */
export function sesEvent(detailType: SesDetailType, options: SesEventOptions = {}): Record<string, unknown> {
  const time = options.time ?? "2026-10-07T13:10:05.000Z";
  const recipient = "success+g01-cus-0001@simulator.amazonses.com";
  const tags = options.tags ?? {
    "ses:configuration-set": [options.configurationSet ?? TEST_CONFIGURATION_SET],
    worldId: [options.worldId ?? "g01"],
    epoch: [options.epoch ?? "1"],
    mailId: [options.mailId ?? TEST_MAIL_ID],
    complaintId: ["cmp-0001"],
    kind: ["FORMAL_ANSWER"],
    stage: ["poc"],
  };
  const detail: Record<string, unknown> = {
    eventType: detailType.replace("Email ", ""),
    mail: { timestamp: time, source: "respuestas@reclamo.demo.craftech.io", sendingAccountId: options.account ?? TEST_ACCOUNT, messageId: options.providerMessageId ?? TEST_PROVIDER_ID, destination: [recipient], tags },
  };
  if (detailType === "Email Delivered") detail.delivery = { timestamp: time, recipients: [recipient], smtpResponse: "250 2.6.0 Message received", processingTimeMillis: 512 };
  if (detailType === "Email Bounced") detail.bounce = { bounceType: options.bounceType ?? "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: recipient }], timestamp: time };
  if (detailType === "Email Complaint Received") detail.complaint = { complainedRecipients: [{ emailAddress: recipient }], timestamp: time };
  if (detailType === "Email Delivery Delayed") detail.deliveryDelay = { delayType: "MailboxFull", delayedRecipients: [{ emailAddress: recipient }], timestamp: time };
  return {
    version: "0",
    id: "11111111-2222-3333-4444-555555555555",
    "detail-type": detailType,
    source: options.source ?? "aws.ses",
    account: options.account ?? TEST_ACCOUNT,
    time,
    region: "us-east-1",
    resources: [],
    detail,
  };
}

/** A sent email of `g01` (proof `SENT`, its SES id recorded unless `recorded: false`) and its pending mail. */
export async function seedSentEmail(connector: Connector, overrides: Partial<NewOf<typeof EmailRecord>> = {}, options: { recorded?: boolean } = {}): Promise<EmailRecord> {
  const record = email("g01", { mailId: TEST_MAIL_ID, sentAtSim: SENT_AT_SIM, complaintId: "cmp-0001", kind: "FORMAL_ANSWER", ...overrides });
  const ref = { worldId: record.worldId, customerId: record.customerId, sentAtSim: record.sentAtSim, mailId: record.mailId };
  await connector.transact([
    connector.emails.putOp(record),
    connector.runtime.openPendingOp({ worldId: record.worldId, kind: "MAIL", pendingId: record.mailId, openedAtReal: "2026-10-07T13:10:00.000Z", customerId: record.customerId, complaintId: record.complaintId }),
  ]);
  if (options.recorded !== false) await connector.write(connector.emails.setProviderMessageIdOp(ref, TEST_PROVIDER_ID));
  const stored = await connector.emails.get(ref);
  if (stored === undefined) throw new Error("seeded email not found");
  return stored;
}
