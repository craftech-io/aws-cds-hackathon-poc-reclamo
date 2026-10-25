// What the email viewer derives from `emails.list` and `emails.get`, as pure functions: the tone of a
// delivery proof, the integrity verdict of the stored `.eml` (FL-093: the SHA-256 shown is the one of
// the object that was sent) and the name a downloaded attachment is saved under. Typed against the
// real `AppRouter`.
import { formatSimInstant } from "@reclamo/shared";
import { MESSAGE_KIND_LABEL } from "@reclamo/bff/copy/es-AR";
import type { BadgeTone } from "../../components/Badge";
import type { RouterOutputs } from "../../lib/trpc-router";
import { emailsCopy } from "./copy";

export type EmailsPage = RouterOutputs["emails"]["list"];
export type EmailSummary = EmailsPage["emails"][number];
export type EmailDetail = RouterOutputs["emails"]["get"];
export type Proof = NonNullable<EmailSummary["deliveryProof"]>;

export interface EmailRef {
  readonly customerId: string;
  readonly mailId: string;
}

export function refOf(email: Pick<EmailSummary, "customerId" | "mailId">): EmailRef {
  return { customerId: email.customerId, mailId: email.mailId };
}

const PROOF_TONE: Readonly<Record<Proof, BadgeTone>> = { SENT: "info", DELIVERED: "success", BOUNCED: "danger", COMPLAINED: "danger", REJECTED: "danger" };

export function proofTone(proof: Proof | null): BadgeTone {
  return proof === null ? "neutral" : PROOF_TONE[proof];
}

export function proofText(proof: Proof | null): string {
  return proof === null ? "—" : emailsCopy.proofs[proof];
}

export function kindText(kind: EmailSummary["kind"]): string {
  return MESSAGE_KIND_LABEL[kind];
}

export function sentText(email: Pick<EmailSummary, "sentAtSim">): string {
  return formatSimInstant(email.sentAtSim);
}

/**
 * A real instant, said as such ("vie 09/10 18:12 · hora real"): SES stamps its events with the real clock,
 * so they are never shown next to the world's simulated time without their clock's name.
 */
export function realText(instant: string): string {
  return `${formatSimInstant(instant)} · ${emailsCopy.detail.realClock}`;
}

export type IntegrityVerdict = "matches" | "differs" | "missing";

/** `matches` only when the `.eml` read now hashes to what was recorded when it was sent. */
export function integrityVerdict(integrity: EmailDetail["integrity"]): IntegrityVerdict {
  if (integrity.sha256 === null) return "missing";
  return integrity.matches ? "matches" : "differs";
}

/** The name an attachment is saved under: the one it was sent with, or a fixed one by position. */
export function attachmentName(detail: Pick<EmailDetail, "view">, index: number): string {
  return detail.view?.attachments[index]?.filename ?? `adjunto-${index + 1}.pdf`;
}

/** How many attachments the detail can offer: the stored view's list, or the record's count. */
export function attachmentIndexes(detail: Pick<EmailDetail, "view" | "attachments">): number[] {
  const count = detail.view?.attachments.length ?? detail.attachments;
  return Array.from({ length: count }, (_, index) => index);
}

export function eventText(type: EmailDetail["events"][number]["type"]): string {
  return emailsCopy.events[type];
}
