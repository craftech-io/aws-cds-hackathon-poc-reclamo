// `acknowledge_complaint` and `record_email_consent` (docs/tool-catalog.md, direct handlers; FL-010,
// FL-011). The inbound classifier (and `register_complaint`) call `acknowledgeComplaint` BEFORE any
// turn: an open complaint of the same customer, type and object gets no new number (it is
// acknowledged again); otherwise numbering.ts registers it in one transaction. Then the caller's
// `sendAck` port sends the `COMPLAINT_ACK` through the gate (outbound/gate.ts): number, type and
// deadline, never account data, so it needs no identity challenge (ADR-0015).
//
// The customer's answer to the email question (`ACCEPT_EMAIL` / `DECLINE_EMAIL` button) is stored
// once, with the version of the consent text they saw (BCRA 3.1.6). Declined, the complaint gets a
// human task for another reliable medium in the same transaction; accepted, the `sendAckEmail` port
// sends `ACK_EMAIL` with the acknowledgement PDF.
import { ToolError } from "@reclamo/shared";
import { EMAIL_CONSENT_VERSIONS, WHATSAPP_TEXT } from "../copy";
import type { Actor } from "../domain/common";
import { type Complaint, type ComplaintSubject, type EmailAnswerConsent, INBOX_CLOSED_STATUSES } from "../domain/complaint";
import { withRetry } from "../lib/retry";
import { type ComplaintsDeps, OPTIMISTIC_ATTEMPTS, newIdOf, realNowOf } from "./deps";
import { REGISTER_IDEMPOTENCY, type Registration, type RegistrationInput, registerComplaint } from "./numbering";
import { isCancelled } from "./register";
import { deadlineText } from "./sla";

/** What the gate needs to send the acknowledgement (outbound/ renders it from copy/). */
export interface AckRequest {
  readonly worldId: string;
  readonly customerId: string;
  readonly complaintId: string;
  readonly complaintNumber: string;
  readonly kind: Complaint["kind"];
  readonly type: Complaint["type"];
  readonly deadlineSim: string;
  readonly deadlineText: string;
  /** True when an open complaint was acknowledged again instead of a new one (`COMPLAINT_ACK_EXISTING`). */
  readonly existing: boolean;
  /** Ask the email question (only while the consent is pending). */
  readonly askEmailConsent: boolean;
  readonly eventId: string;
}

export type AckSender = (request: AckRequest) => Promise<{ readonly messageId?: string }>;

export interface Acknowledgement {
  readonly complaint: Complaint;
  /** A new number was given by this event. */
  readonly created: boolean;
  /** An open complaint of the same type and object was found instead. */
  readonly existing: boolean;
  readonly deadlineText: string;
  readonly filedHash?: string;
  readonly ackMessageId?: string;
}

function sameObject(open: ComplaintSubject | undefined, asked: ComplaintSubject | undefined): boolean {
  if (!asked) return true;
  const fields = ["loanId", "instalment", "chargeId", "transferId", "operationCode"] as const;
  return fields.every((field) => asked[field] === undefined || open?.[field] === undefined || open[field] === asked[field]);
}

/** An open complaint of this customer with the same type and object, if any (newest first). */
export async function findOpenComplaint(deps: Pick<ComplaintsDeps, "connector">, input: Pick<RegistrationInput, "worldId" | "customerId" | "type" | "subject">): Promise<Complaint | undefined> {
  const complaints = await deps.connector.complaints.listByCustomer(input.worldId, input.customerId);
  return complaints.find((complaint) => !INBOX_CLOSED_STATUSES.has(complaint.status) && complaint.type === input.type && sameObject(complaint.subject, input.subject));
}

/** Number (or the open one), then the acknowledgement through the caller's gate port. */
export async function acknowledgeComplaint(deps: ComplaintsDeps, input: RegistrationInput, sendAck?: AckSender): Promise<Acknowledgement> {
  let registration: Registration | undefined;
  let existing = false;
  const replay = await deps.connector.claims.getIdempotency(input.worldId, REGISTER_IDEMPOTENCY, input.eventId);
  if (!replay) {
    const open = await findOpenComplaint(deps, input);
    if (open) {
      existing = true;
      registration = { complaint: open, created: false, deadlineText: deadlineText(open.deadlineSim) };
    }
  }
  registration ??= await registerComplaint(deps, input);
  const { complaint } = registration;
  let ackMessageId: string | undefined;
  if (sendAck) {
    const sent = await sendAck({
      worldId: complaint.worldId,
      customerId: complaint.customerId,
      complaintId: complaint.complaintId,
      complaintNumber: complaint.complaintNumber,
      kind: complaint.kind,
      type: complaint.type,
      deadlineSim: complaint.deadlineSim,
      deadlineText: registration.deadlineText,
      existing,
      askEmailConsent: complaint.emailAnswerConsent.status === "PENDING",
      eventId: input.eventId,
    });
    ackMessageId = sent.messageId;
  }
  deps.log.info("complaints.acknowledged", { worldId: complaint.worldId, complaintId: complaint.complaintId, created: registration.created, existing });
  return {
    complaint,
    created: registration.created,
    existing,
    deadlineText: registration.deadlineText,
    ...(registration.filedHash ? { filedHash: registration.filedHash } : {}),
    ...(ackMessageId ? { ackMessageId } : {}),
  };
}

export interface EmailConsentInput {
  readonly worldId: string;
  readonly complaintId: string;
  readonly decision: "ACCEPTED" | "DECLINED";
  /** Version of the consent text the customer saw (copy/consent.ts). */
  readonly textVersion: string;
  readonly atSim: string;
  readonly actor: Actor;
}

export type AckEmailSender = (complaint: Complaint) => Promise<{ readonly messageId?: string }>;

export interface EmailConsentResult {
  readonly complaint: Complaint;
  /** False when the customer had already answered (a repeated button): nothing changed. */
  readonly changed: boolean;
  readonly consent: EmailAnswerConsent;
  readonly ackEmailMessageId?: string;
}

/** Stores the customer's answer to the email question once; declined → human task; accepted → `ACK_EMAIL`. */
export async function recordEmailConsent(deps: ComplaintsDeps, input: EmailConsentInput, sendAckEmail?: AckEmailSender): Promise<EmailConsentResult> {
  if (!Object.hasOwn(EMAIL_CONSENT_VERSIONS, input.textVersion)) throw new ToolError("INVALID", "unknown consent text version");
  const { connector } = deps;
  const outcome = await withRetry(
    async () => {
      const complaint = await connector.complaints.get(input.worldId, input.complaintId, { consistent: true });
      if (!complaint) throw new ToolError("NOT_FOUND", "complaint not found");
      if (complaint.emailAnswerConsent.status !== "PENDING") return { complaint, changed: false };
      const consent: EmailAnswerConsent = { status: input.decision, atSim: input.atSim, textVersion: input.textVersion };
      const ops = [
        connector.complaints.patchOp(input.worldId, input.complaintId, complaint.version, { emailAnswerConsent: consent }),
        connector.audit.appendOp({
          worldId: input.worldId,
          epoch: complaint.epoch,
          auditId: newIdOf(deps, "aud"),
          ts: realNowOf(deps).toISOString(),
          atSim: input.atSim,
          action: "EMAIL_CONSENT",
          actor: input.actor,
          refs: { complaintId: input.complaintId, textVersion: input.textVersion },
          primaryRef: `CMP#${input.complaintId}`,
          outcome: input.decision,
        }),
      ];
      if (input.decision === "DECLINED") {
        ops.push(
          connector.caseItems.putNoteOp({
            worldId: input.worldId,
            complaintId: input.complaintId,
            noteId: newIdOf(deps, "note"),
            kind: "HUMAN_TASK",
            atSim: input.atSim,
            author: "SYSTEM",
            text: WHATSAPP_TEXT.EMAIL_CONSENT_DECLINED,
            task: { status: "OPEN", route: "HUMAN_QUEUE" },
          }),
        );
      }
      await connector.transact(ops);
      const updated = await connector.complaints.get(input.worldId, input.complaintId, { consistent: true });
      return { complaint: updated ?? complaint, changed: true };
    },
    { attempts: OPTIMISTIC_ATTEMPTS, baseDelayMs: 20, maxDelayMs: 400, shouldRetry: isCancelled, ...deps.retry },
  );
  const consent = outcome.complaint.emailAnswerConsent;
  if (!outcome.changed || input.decision !== "ACCEPTED" || !sendAckEmail) return { ...outcome, consent };
  const sent = await sendAckEmail(outcome.complaint);
  return { ...outcome, consent, ...(sent.messageId ? { ackEmailMessageId: sent.messageId } : {}) };
}
