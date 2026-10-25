// The single SES v2 client of the stage (docs/architecture-integrations.md §1). Only the gate's email
// transport (outbound/transports/) builds it and hands it the function that runs the SES command, so
// `lint:chokepoint` keeps finding every send command in that one directory. In order:
//
//   1. the request is validated (zod, strict) and its headers checked (no CR/LF, bounded);
//   2. the recipient fence (recipient-fence.ts, `CH-RECIPIENT-FENCE`): refused before anything else;
//   3. the abuse caps on the REAL clock: 200 per world and hour, 20 per day to real demo recipients;
//   4. the raw MIME (mime.ts), read back to check one `To` equal to `Destination`, no `Cc`/`Bcc`;
//   5. BEFORE SES: the `.eml` and its view in `Emails`, then in one transaction the `EmailRecord`
//      (`Conversations/…/MAIL#<ts>#<mailId>`) and the pending mail `Runtime/W#<w>#PENDING · MAIL#`,
//      which only a terminal SES event closes (email-events/apply.ts);
//   6. `SendEmail` with `Content.Raw`, `FromEmailAddress` and `Destination.ToAddresses` always explicit
//      (one recipient, lower case, the fenced one), the configuration set and `EmailTags`
//      {worldId, epoch, complaintId, mailId, kind, stage}; only throttling is retried (SES has no
//      idempotency key);
//   7. AFTER: `providerMessageId` and the delivery proof `SENT` on the record. A failed send closes
//      the pending mail so the world does not wait for an email that never left.
//
// The same `mailId` twice (the `QaDriver` derives it from its idempotency key) never sends twice: a
// record with its SES id returns that send, one without it is `UNKNOWN_DELIVERY`.
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { z } from "zod";
import { ChannelError, IsoInstant, MessageKind, WorldId, maskEmail } from "@reclamo/shared";
import type { Connector } from "../../connector/port";
import { isConflict } from "../../connector/errors";
import { Epoch, CustomerId, Id } from "../../domain/common";
import { withDeadline } from "../../lib/deadline";
import type { Logger } from "../../lib/log";
import { withRetry } from "../../lib/retry";
import { assertHeaderValue } from "./address";
import {
  ANSWERS_ADDRESS,
  ATTACHMENT_FILENAME,
  DEMO_RECIPIENT_EMAILS_PER_DAY,
  DEMO_RECIPIENT_RATE_SEGMENT,
  DEMO_WORLD,
  EMAILS_PER_WORLD_HOUR,
  EMAIL_RATE_SEGMENT,
  EMAIL_TAG,
  MAX_ATTACHMENTS,
  SENDER_DISPLAY_NAME,
  SES_SEND_ATTEMPTS,
  SES_SEND_TIMEOUTS,
  SES_THROTTLING_ERRORS,
} from "./config";
import { buildMime, inspectMime } from "./mime";
import { type DemoRecipients, type FenceDecision, type FenceIntent, assertSingleRecipient, checkRecipientFence } from "./recipient-fence";
import { type EmailObjectStore, emailObjectKeys, emailView } from "./store";
import { sha256Hex } from "../../lib/crypto";

const Attachment = z
  .object({
    filename: z.string().regex(ATTACHMENT_FILENAME),
    /** `ANSWER`, `ACK`, `PAYOFF_CERTIFICATE`, … (pdf/). */
    docKind: z.string().regex(/^[A-Z][A-Z_]{1,39}$/),
    /** The PDF's key in `Documents`. */
    s3Key: z.string().min(1).max(512),
    bytes: z.instanceof(Uint8Array),
  })
  .strict();

export const EmailSendRequest = z
  .object({
    worldId: WorldId,
    /** World epoch at the send (the `epoch` tag lets `EmailEvents` find the tombstone of a reset). */
    epoch: Epoch,
    customerId: CustomerId,
    complaintId: Id.optional(),
    /** The `Message OUT` the gate records for this email. */
    messageId: Id.optional(),
    kind: MessageKind,
    /** The customer's address from the core: PII, fenced, never logged nor stored in clear. */
    to: z.string().min(3).max(254),
    subject: z.string().min(1).max(300),
    text: z.string().min(1).max(100_000),
    html: z.string().min(1).max(300_000),
    attachments: z.array(Attachment).max(MAX_ATTACHMENTS).default([]),
    sentAtSim: IsoInstant,
    /** A new ULID by default; the `QaDriver` derives it from its idempotency key. */
    mailId: Id.optional(),
  })
  .strict();
export type EmailSendRequest = z.input<typeof EmailSendRequest>;

export type EmailSendResult =
  | { readonly status: "SENT"; readonly mailId: string; readonly providerMessageId: string; readonly rawSha256: string; readonly s3RawKey: string; readonly replayed: boolean }
  | { readonly status: "UNKNOWN_DELIVERY"; readonly mailId: string }
  | { readonly status: "REFUSED"; readonly code: "RECIPIENT_NOT_ALLOWED"; readonly ruleId: string; readonly reason: string }
  | { readonly status: "REFUSED"; readonly code: "RATE_LIMITED"; readonly reason: "WORLD_HOURLY_EMAIL_CAP" | "DEMO_RECIPIENT_DAILY_CAP" };

/** Runs one SES `SendEmail` (the transport builds the command); `signal` aborts it at the deadline. */
export type SesSendFn = (input: SendEmailCommandInput, signal: AbortSignal) => Promise<{ readonly MessageId?: string | undefined }>;

export type EmailClientConnector = Pick<Connector, "emails" | "runtime" | "caps" | "audit" | "transact" | "write">;

export interface EmailClientDeps {
  readonly connector: EmailClientConnector;
  readonly objects: EmailObjectStore;
  readonly sendRaw: SesSendFn;
  readonly demoRecipients: DemoRecipients;
  /** `aws-cds-hackathon-poc-reclamo-email-poc` (config.ts `configurationSetName`). */
  readonly configurationSet: string;
  readonly stage: string;
  /** Real clock: caps, stamps of the pending mail and the audit. */
  readonly now: () => Date;
  readonly newMailId: () => string;
  readonly log: Logger;
}

export interface EmailClient {
  send(request: EmailSendRequest): Promise<EmailSendResult>;
  /** The fence alone: the gate's step 5 and the `QaDriver`'s `fence.probe` (never writes, never sends). */
  checkRecipient(intent: FenceIntent): FenceDecision;
}

const SES_DEADLINE_MS = SES_SEND_TIMEOUTS.requestTimeoutMs * SES_SEND_ATTEMPTS + 2_000;

function sesError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  const name = error instanceof Error ? error.name : "";
  if (SES_THROTTLING_ERRORS.has(name)) return new ChannelError("RATE_LIMITED", "EMAIL", "SES throttled the send", { cause: error });
  if (name === "TimeoutError" || name === "AbortError" || name === "RequestTimeout" || name === "DeadlineError") {
    return new ChannelError("TIMEOUT", "EMAIL", "SES did not answer in time", { cause: error, retryable: false });
  }
  if (/Rejected|NotVerified|Suspended|Paused|BadRequest|NotFound|MessageRejected|AccountSuspended/.test(name)) {
    return new ChannelError("SEND_FAILED", "EMAIL", `SES refused the send (${name})`, { cause: error, retryable: false });
  }
  return new ChannelError("UNAVAILABLE", "EMAIL", "SES send failed", { cause: error, retryable: false });
}

function startOfRealDay(at: Date): Date {
  return new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

export function createEmailClient(deps: EmailClientDeps): EmailClient {
  const checkRecipient = (intent: FenceIntent) => checkRecipientFence(intent, deps.demoRecipients);

  async function underCaps(worldId: string, demoRecipient: boolean, mailId: string, epoch: number): Promise<EmailSendResult | undefined> {
    const now = deps.now();
    const hourly = await deps.connector.caps.increment({ kind: "RATE", worldId, phoneHash: EMAIL_RATE_SEGMENT, at: now }, EMAILS_PER_WORLD_HOUR);
    if (!hourly.allowed) return { status: "REFUSED", code: "RATE_LIMITED", reason: "WORLD_HOURLY_EMAIL_CAP" };
    if (!demoRecipient) return undefined;
    const daily = await deps.connector.caps.increment({ kind: "RATE", worldId: DEMO_WORLD, phoneHash: DEMO_RECIPIENT_RATE_SEGMENT, at: startOfRealDay(now) }, DEMO_RECIPIENT_EMAILS_PER_DAY);
    if (!daily.allowed) return { status: "REFUSED", code: "RATE_LIMITED", reason: "DEMO_RECIPIENT_DAILY_CAP" };
    await deps.connector.audit.append({
      worldId,
      epoch,
      auditId: `demo-mail-${mailId}`,
      ts: now.toISOString(),
      action: "DEMO_RECIPIENT_EMAIL",
      actor: "SYSTEM",
      refs: { mailId },
      outcome: `${daily.count}/${DEMO_RECIPIENT_EMAILS_PER_DAY}`,
    });
    return undefined;
  }

  /** The same `mailId` again: the earlier send, never a second email. */
  async function replay(request: z.output<typeof EmailSendRequest>, mailId: string): Promise<EmailSendResult> {
    const record = await deps.connector.emails.get({ worldId: request.worldId, customerId: request.customerId, sentAtSim: request.sentAtSim, mailId });
    if (record?.providerMessageId === undefined) return { status: "UNKNOWN_DELIVERY", mailId };
    return { status: "SENT", mailId, providerMessageId: record.providerMessageId, rawSha256: record.rawSha256 ?? "", s3RawKey: record.s3RawKey, replayed: true };
  }

  function tagsOf(request: z.output<typeof EmailSendRequest>, mailId: string): Array<{ Name: string; Value: string }> {
    const tags: Array<[string, string | undefined]> = [
      [EMAIL_TAG.world, request.worldId],
      [EMAIL_TAG.epoch, String(request.epoch)],
      [EMAIL_TAG.complaint, request.complaintId],
      [EMAIL_TAG.mail, mailId],
      [EMAIL_TAG.kind, request.kind],
      [EMAIL_TAG.stage, deps.stage],
    ];
    return tags.flatMap(([name, value]) => {
      if (value === undefined) return [];
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new ChannelError("INVALID", "EMAIL", `EmailTags value of ${name} holds characters SES refuses`);
      return [{ Name: name, Value: value }];
    });
  }

  async function sendToSes(input: SendEmailCommandInput): Promise<string> {
    const result = await withDeadline("ses.sendEmail", SES_DEADLINE_MS, (signal) =>
      withRetry(() => deps.sendRaw(input, signal), {
        attempts: SES_SEND_ATTEMPTS,
        baseDelayMs: 200,
        maxDelayMs: 1_500,
        shouldRetry: (error) => error instanceof Error && SES_THROTTLING_ERRORS.has(error.name),
      }),
    );
    if (result.MessageId === undefined || result.MessageId === "") throw new ChannelError("SEND_FAILED", "EMAIL", "SES returned no message id", { retryable: false });
    return result.MessageId;
  }

  async function send(input: EmailSendRequest): Promise<EmailSendResult> {
    const parsed = EmailSendRequest.safeParse(input);
    if (!parsed.success) throw new ChannelError("INVALID", "EMAIL", "invalid email request", { cause: parsed.error });
    const request = parsed.data;
    const mailId = request.mailId ?? deps.newMailId();
    const log = deps.log.child({ channel: "EMAIL", worldId: request.worldId, mailId, kind: request.kind });
    assertHeaderValue("Subject", request.subject);

    const fence = checkRecipient({ worldId: request.worldId, to: request.to });
    if (!fence.allowed) {
      log.warn("email.fence_refused", { ruleId: fence.ruleId, reason: fence.reason });
      return { status: "REFUSED", code: fence.code, ruleId: fence.ruleId, reason: fence.reason };
    }
    const capped = await underCaps(request.worldId, fence.target === "DEMO_RECIPIENT", mailId, request.epoch);
    if (capped !== undefined) {
      log.warn("email.cap_reached", { reason: capped.status === "REFUSED" ? capped.reason : undefined });
      return capped;
    }

    const recipient = fence.to.address;
    const mime = buildMime({
      from: { displayName: SENDER_DISPLAY_NAME, address: ANSWERS_ADDRESS },
      to: recipient,
      subject: request.subject,
      date: new Date(request.sentAtSim),
      mailId,
      worldId: request.worldId,
      text: request.text,
      html: request.html,
      attachments: request.attachments.map((file) => ({ filename: file.filename, bytes: file.bytes })),
    });
    const destination = [recipient];
    assertSingleRecipient(destination, await inspectMime(mime.raw));

    const keys = emailObjectKeys(request.worldId, request.sentAtSim, mailId);
    const attachments = request.attachments.map((file) => ({ filename: file.filename, docKind: file.docKind, s3Key: file.s3Key, sha256: sha256Hex(file.bytes), bytes: file.bytes.byteLength }));
    const view = emailView({
      mailId,
      worldId: request.worldId,
      headers: { from: `${SENDER_DISPLAY_NAME} <${ANSWERS_ADDRESS}>`, to: recipient, subject: request.subject, date: request.sentAtSim },
      text: request.text,
      html: request.html,
      attachments: attachments.map(({ filename, docKind, sha256, bytes }) => ({ filename, docKind, sha256, bytes })),
      rawSha256: mime.sha256,
    });
    await deps.objects.put(keys.raw, mime.raw, "message/rfc822");
    await deps.objects.put(keys.render, new TextEncoder().encode(JSON.stringify(view)), "application/json");

    const ref = { worldId: request.worldId, customerId: request.customerId, sentAtSim: request.sentAtSim, mailId };
    try {
      await deps.connector.transact([
        deps.connector.emails.putOp({
          ...ref,
          messageId: request.messageId,
          complaintId: request.complaintId,
          kind: request.kind,
          toMasked: maskEmail(recipient),
          subject: request.subject,
          s3RawKey: keys.raw,
          s3RenderKey: keys.render,
          rawSha256: mime.sha256,
          attachments: attachments.map(({ docKind, s3Key, sha256 }) => ({ docKind, s3Key, sha256 })),
          events: [],
        }),
        deps.connector.runtime.openPendingOp({ worldId: request.worldId, kind: "MAIL", pendingId: mailId, openedAtReal: deps.now().toISOString(), customerId: request.customerId, complaintId: request.complaintId, ref: request.kind }),
      ]);
    } catch (error) {
      if (!isConflict(error)) throw error;
      log.info("email.replayed");
      return replay(request, mailId);
    }

    let providerMessageId: string;
    try {
      providerMessageId = await sendToSes({
        FromEmailAddress: ANSWERS_ADDRESS,
        Destination: { ToAddresses: destination },
        Content: { Raw: { Data: mime.raw } },
        ConfigurationSetName: deps.configurationSet,
        EmailTags: tagsOf(request, mailId),
      });
    } catch (error) {
      const failure = sesError(error);
      try {
        await deps.connector.write(deps.connector.runtime.closePendingOp(request.worldId, "MAIL", mailId));
      } catch (closeError) {
        // The pending mail goes STALE in 10 real minutes anyway; the send failure is what matters.
        log.error("email.pending_close_failed", { error: closeError instanceof Error ? closeError.name : "unknown" });
      }
      log.error("email.send_failed", { code: failure.code, errorName: failure.cause instanceof Error ? failure.cause.name : undefined });
      throw failure;
    }
    await deps.connector.write(deps.connector.emails.setProviderMessageIdOp(ref, providerMessageId));
    log.info("email.sent", { target: fence.target });
    return { status: "SENT", mailId, providerMessageId, rawSha256: mime.sha256, s3RawKey: keys.raw, replayed: false };
  }

  return { send, checkRecipient };
}
