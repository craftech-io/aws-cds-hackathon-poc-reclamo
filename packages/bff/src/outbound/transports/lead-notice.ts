// Transport of the lead notice to Craftech (docs/architecture-guests.md §9, ADR-0006 amendment). It
// is not a message to a customer, so it does not go through the gate; it is the only other SES send
// of the app and lives here, with the transports, so `lint:chokepoint` still finds every send command
// in one directory. Its own fence: one recipient that must be @craftech.io (checked again here, and by
// IAM), `text/plain` only, the fixed subject (or the operator's `[PRUEBA]` one), no configuration set,
// the app's `no-reply@` sender.
// The QaDriver's `notice.probe` builds it with the `PROBE` fence instead: the one recipient is the SES
// mailbox simulator's `success@` (and its IAM allows only that address), never a person's mailbox.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { z } from "zod";
import { awsClientConfig } from "../../lib/clients";
import { withRetry } from "../../lib/retry";
import { LEAD_NOTICE_PROBE_RECIPIENT, LEAD_NOTICE_SUBJECT, LEAD_NOTICE_TEST_SUBJECT, type LeadNotice, leadNoticeRecipient } from "../../leads/notice";

export interface LeadNoticeTransport {
  send(notice: LeadNotice): Promise<void>;
}

/** `Resource.LeadNotice` (infra/leads.ts): the product's `no-reply@` sender, never a lead's data. */
export const LeadNoticeLink = z.object({ from: z.string().min(3) });

/** Who a transport may send to: the team's mailbox, or only the SES mailbox simulator (`notice.probe`). */
export type LeadNoticeFence = "MAILBOX" | "PROBE";

function fenced(notice: LeadNotice, fence: LeadNoticeFence): boolean {
  if (fence === "PROBE") return notice.to === LEAD_NOTICE_PROBE_RECIPIENT && notice.subject === LEAD_NOTICE_SUBJECT;
  // The team's mailbox gets a lead's notice or the operator's marked test (`npm run leads:notice-test`).
  return leadNoticeRecipient(notice.to) === notice.to && (notice.subject === LEAD_NOTICE_SUBJECT || notice.subject === LEAD_NOTICE_TEST_SUBJECT);
}

const SES_TIMEOUTS = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 1 } as const;
const RETRYABLE = new Set(["ThrottlingException", "TooManyRequestsException", "InternalFailure", "ServiceUnavailable", "TimeoutError"]);

export class LeadNoticeRefused extends Error {
  override readonly name = "LeadNoticeRefused";
}

/** `from` is `Reclamo en regla <no-reply@<app domain>>` (the `LeadNotice` link of infra/leads.ts). */
export function sesLeadNoticeTransport(from: string, client: SESv2Client = new SESv2Client(awsClientConfig(SES_TIMEOUTS)), fence: LeadNoticeFence = "MAILBOX"): LeadNoticeTransport {
  return {
    async send(notice) {
      if (!fenced(notice, fence)) throw new LeadNoticeRefused(fence === "PROBE" ? "the notice probe is fenced to the SES mailbox simulator and a fixed subject" : "the lead notice is fenced to one @craftech.io mailbox and a fixed subject");
      await withRetry(
        () =>
          client.send(
            new SendEmailCommand({
              FromEmailAddress: from,
              Destination: { ToAddresses: [notice.to] },
              Content: { Simple: { Subject: { Data: notice.subject, Charset: "UTF-8" }, Body: { Text: { Data: notice.text, Charset: "UTF-8" } } } },
            }),
          ),
        { attempts: 3, baseDelayMs: 200, shouldRetry: (error) => error instanceof Error && RETRYABLE.has(error.name) },
      );
    },
  };
}
