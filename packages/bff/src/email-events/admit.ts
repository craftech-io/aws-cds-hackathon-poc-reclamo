// What `EmailEvents` does with one SES event (docs/architecture-integrations.md §2, docs/architecture.md
// §13 "Eventos de SES"): it validates and enqueues, nothing else. It never sends (no `PIPELINE`) and
// never applies the delivery proof itself: the worker does that (apply.ts), in the customer's order.
//
//   1. zod: `source = aws.ses`, a known `detail-type`, an SES message id;
//   2. `account` (and `mail.sendingAccountId`) = the account of this function;
//   3. tag `ses:configuration-set` = the app's configuration set;
//   4. tags `worldId`, `epoch`, `mailId` present and well formed;
//   5. the world's epoch has a tombstone → discarded and audited (`TOMBSTONED_EVENT`), no retry;
//   6. an `EmailRecord` of THAT world and THAT `mailId` holds this SES message id (`ByProviderMessageId`);
//      a mail still pending whose id is not recorded yet (the event beat the write) is retried;
//   7. `EMAIL_EVENT` to the world's queue, with an id derived from the event so a redelivery is one event.
//
// Anything else is rejected: audited `EMAIL_EVENT_REJECTED` when the event names a valid world (only
// ids, never an address), logged otherwise. A direct invocation with a fabricated event therefore
// never produces a delivery proof.
import { ChannelError, WorldId } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import { EMAIL_TAG } from "../channels/email/config";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { type EmailEventEnqueue, EmailEventPayload, type SesMailEvent, parseSesEvent, singleTag } from "./schema";

export const REJECTION_REASONS = [
  "INVALID_EVENT",
  "UNSUPPORTED_TYPE",
  "WRONG_ACCOUNT",
  "WRONG_CONFIGURATION_SET",
  "MISSING_TAGS",
  "UNKNOWN_MAIL",
  "MAIL_MISMATCH",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type AdmitOutcome =
  | { readonly outcome: "ENQUEUED"; readonly eventId: string }
  | { readonly outcome: "TOMBSTONED" }
  | { readonly outcome: "REJECTED"; readonly reason: RejectionReason };

export interface AdmitDeps {
  readonly connector: Pick<Connector, "conversations" | "emails" | "runtime" | "audit" | "counters">;
  readonly enqueue: EmailEventEnqueue;
  /** The account of the running function (from its ARN) and the app's configuration set. */
  readonly expected: { readonly account: string; readonly configurationSet: string };
  /** Real clock, for audit stamps. */
  readonly now: () => Date;
  readonly log: Logger;
}

interface Tagged {
  readonly worldId: string;
  readonly epoch: number;
  readonly mailId: string;
}

function taggedOf(event: SesMailEvent): Tagged | undefined {
  const worldId = singleTag(event.tags, EMAIL_TAG.world);
  const epochText = singleTag(event.tags, EMAIL_TAG.epoch);
  const mailId = singleTag(event.tags, EMAIL_TAG.mail);
  if (worldId === undefined || epochText === undefined || mailId === undefined) return undefined;
  if (!WorldId.safeParse(worldId).success || !/^\d{1,9}$/.test(epochText) || !/^[A-Za-z0-9][A-Za-z0-9._:+=@-]{0,159}$/.test(mailId)) return undefined;
  return { worldId, epoch: Number(epochText), mailId };
}

/** `ses-<32 hex>`: one id per SES message, event type and instant, stable across redeliveries. */
export function emailEventId(event: Pick<SesMailEvent, "providerMessageId" | "type" | "occurredAtReal">): string {
  return `ses-${sha256Hex(`${event.providerMessageId}#${event.type}#${event.occurredAtReal}`).slice(0, 32)}`;
}

export async function admitSesEvent(raw: unknown, deps: AdmitDeps): Promise<AdmitOutcome> {
  const parsed = parseSesEvent(raw);
  if (!parsed.ok) return reject(deps, parsed.reason);
  const event = parsed.event;
  const tagged = taggedOf(event);

  if (event.account !== deps.expected.account || (event.sendingAccountId !== undefined && event.sendingAccountId !== deps.expected.account)) {
    return reject(deps, "WRONG_ACCOUNT", tagged);
  }
  if (singleTag(event.tags, EMAIL_TAG.configurationSet) !== deps.expected.configurationSet) return reject(deps, "WRONG_CONFIGURATION_SET", tagged);
  if (tagged === undefined) return reject(deps, "MISSING_TAGS");

  if ((await deps.connector.runtime.getTombstone(tagged.worldId, tagged.epoch)) !== undefined) {
    await audit(deps, tagged, "TOMBSTONED_EVENT", "TOMBSTONED", { type: event.type });
    deps.log.info("email_events.tombstoned", { worldId: tagged.worldId, epoch: tagged.epoch, type: event.type });
    return { outcome: "TOMBSTONED" };
  }

  const match = await deps.connector.conversations.findByProviderMessageId(event.providerMessageId);
  if (match === undefined) {
    if (await recordedLater(deps, tagged)) throw new ChannelError("UNAVAILABLE", "EMAIL", "the SES id of this email is not recorded yet", { retryable: true });
    return reject(deps, "UNKNOWN_MAIL", tagged);
  }
  if (match.kind !== "EMAIL" || match.email.worldId !== tagged.worldId || match.email.mailId !== tagged.mailId) return reject(deps, "MAIL_MISMATCH", tagged);

  const record = match.email;
  const payload = EmailEventPayload.parse({
    worldId: record.worldId,
    epoch: tagged.epoch,
    customerId: record.customerId,
    complaintId: record.complaintId,
    mailId: record.mailId,
    sentAtSim: record.sentAtSim,
    providerMessageId: event.providerMessageId,
    type: event.type,
    bounceType: event.bounceType,
    occurredAtReal: event.occurredAtReal,
    smtpResponse: event.smtpResponse,
  });
  const eventId = emailEventId(event);
  await deps.enqueue({ type: "EMAIL_EVENT", eventId, worldId: record.worldId, customerId: record.customerId, payload });
  deps.log.info("email_events.enqueued", { worldId: record.worldId, mailId: record.mailId, type: event.type, eventId });
  return { outcome: "ENQUEUED", eventId };
}

/**
 * The event beat the write of `providerMessageId`: the mail is still pending and its record exists
 * without an SES id. Anything else (no pending mail, another id) is not ours to wait for.
 */
async function recordedLater(deps: AdmitDeps, tagged: Tagged): Promise<boolean> {
  const pending = (await deps.connector.runtime.listPending(tagged.worldId)).find((item) => item.kind === "MAIL" && item.pendingId === tagged.mailId);
  if (pending?.customerId === undefined) return false;
  const record = await deps.connector.emails.find(tagged.worldId, pending.customerId, tagged.mailId);
  return record !== undefined && record.providerMessageId === undefined;
}

async function reject(deps: AdmitDeps, reason: RejectionReason, tagged?: Tagged): Promise<AdmitOutcome> {
  deps.log.warn("email_events.rejected", { reason, worldId: tagged?.worldId });
  if (tagged !== undefined) await audit(deps, tagged, "EMAIL_EVENT_REJECTED", reason, {});
  return { outcome: "REJECTED", reason };
}

async function audit(deps: AdmitDeps, tagged: Tagged, action: string, outcome: string, detail: Record<string, string>): Promise<void> {
  const ts = deps.now().toISOString();
  try {
    await deps.connector.audit.append({
      worldId: tagged.worldId,
      epoch: tagged.epoch,
      auditId: `email-evt-${sha256Hex(`${action}#${tagged.mailId}#${ts}`).slice(0, 24)}`,
      ts,
      action,
      actor: "SYSTEM",
      refs: { mailId: tagged.mailId },
      outcome,
      ...(Object.keys(detail).length === 0 ? {} : { detail }),
    });
  } catch (error) {
    // The decision stands without its audit row; a failed audit must not turn a rejection into a retry.
    deps.log.error("email_events.audit_failed", { action, error: error instanceof Error ? error.name : "unknown" });
  }
}
