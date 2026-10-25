// What the worker does with an `EMAIL_EVENT` (`record_email_event`, docs/tool-catalog.md;
// docs/architecture-integrations.md §2): the delivery proof of the email, the register's
// `DELIVERY_PROOF`, the pending mail and the effects of a bounce or a complaint. Deterministic: the
// event decides, never the model. The outbound effect (the WhatsApp update after a bounce) is
// returned, not sent: the worker puts it through the gate like any other message.
//
//   Send                 proof SENT (if none yet); the pending mail stays open
//   Delivery             proof DELIVERED; DELIVERY_PROOF in the register for a written answer; closes
//   Bounce Permanent     proof BOUNCED; closes; the complaint → HUMAN_REVIEW (EMAIL_UNDELIVERABLE);
//   (and Undetermined)   template `reclamo_respuesta_no_entregada` by WhatsApp
//   Bounce Transient,    the event only (SES keeps trying and reports the outcome); one DEFERRED_SEND
//   Delivery Delay       +1 h simulated per email; the pending mail stays open
//   Complaint            proof COMPLAINED; closes; `Customer.emailSuppressed = true`; human case
//   Reject, Rendering    proof REJECTED (failed); closes; alarm (`email.failed` log line)
//
// A redelivered event (same type and instant already on the record) changes nothing. A proof never
// goes back: once DELIVERED only a later complaint moves it (COMPLAINED); BOUNCED, COMPLAINED and
// REJECTED are final.
import type { Connector } from "../connector/port";
import type { DeliveryProof } from "../domain/complaint";
import type { EmailRecord } from "../domain/conversation";
import type { Logger } from "../lib/log";
import { maskSensitive } from "../lib/mask";
import { type EmailEventPayload, EmailEventPayload as EmailEventPayloadSchema } from "./schema";

/** Simulated delay of the single retry after a transient bounce or a delay notice. */
export const DEFERRED_RETRY_MS = 60 * 60 * 1000;
/** The written answer: the only email whose delivery is a `DELIVERY_PROOF` of the register. */
export const WRITTEN_ANSWER_KIND = "FORMAL_ANSWER";
export const UNDELIVERED_TEMPLATE = "reclamo_respuesta_no_entregada";

/** Effects that belong to other modules (complaints/, the core client, timers/); the worker wires them. */
export interface EmailEventEffects {
  /** `DELIVERY_PROOF` of the complaint's register (complaints/register.ts `appendChained`), with the mail's id. */
  appendDeliveryProof(input: { worldId: string; epoch: number; complaintId: string; mailId: string; atSim: string }): Promise<void>;
  /** The complaint goes to `HUMAN_REVIEW` with `EMAIL_UNDELIVERABLE` when the state machine allows it. */
  handOffUndeliverable(input: { worldId: string; complaintId: string; atSim: string; cause: "BOUNCE" | "COMPLAINT" }): Promise<void>;
  /** The core marks the customer's email suppressed (no more non-formal emails). */
  suppressEmail(input: { worldId: string; customerId: string }): Promise<void>;
  /** One `DEFERRED_SEND` timer for this email. */
  scheduleRetry(input: { worldId: string; customerId: string; complaintId?: string; mailId: string; dueAtSim: string }): Promise<void>;
}

export interface ApplyDeps {
  readonly connector: Pick<Connector, "emails" | "runtime" | "complaints" | "audit" | "write">;
  readonly effects: EmailEventEffects;
  /** The world's simulated clock (lib/clock.ts `worldClock`). */
  readonly simNow: () => Promise<Date>;
  /** Real clock, for the audit stamp. */
  readonly now: () => Date;
  readonly log: Logger;
}

export interface UndeliveredNotice {
  readonly kind: "COMPLAINT_UPDATE";
  readonly channel: "WHATSAPP";
  readonly template: typeof UNDELIVERED_TEMPLATE;
  readonly params: readonly [string];
  readonly worldId: string;
  readonly customerId: string;
  readonly complaintId: string;
}

export type ApplyResult =
  | { readonly outcome: "MISSING" }
  | { readonly outcome: "DUPLICATE" }
  | {
      readonly outcome: "APPLIED";
      readonly deliveryProof?: DeliveryProof;
      readonly closedPending: boolean;
      readonly registerProof: boolean;
      readonly notify?: UndeliveredNotice;
      readonly retryAtSim?: string;
      readonly alarm: boolean;
    };

const FINAL: ReadonlySet<DeliveryProof> = new Set<DeliveryProof>(["BOUNCED", "COMPLAINED", "REJECTED"]);

function isPermanent(event: EmailEventPayload): boolean {
  return event.type === "BOUNCE" && event.bounceType !== "Transient";
}

function isDeferral(event: EmailEventPayload): boolean {
  return event.type === "DELIVERY_DELAY" || (event.type === "BOUNCE" && event.bounceType === "Transient");
}

/** The proof the event establishes over the current one; `undefined` leaves it as it is. */
export function nextProof(current: DeliveryProof | undefined, event: EmailEventPayload): DeliveryProof | undefined {
  if (current !== undefined && FINAL.has(current)) return undefined;
  switch (event.type) {
    case "SEND":
      return current === undefined ? "SENT" : undefined;
    case "DELIVERY":
      return current === "DELIVERED" ? undefined : "DELIVERED";
    case "BOUNCE":
      return isPermanent(event) ? "BOUNCED" : undefined;
    case "COMPLAINT":
      return "COMPLAINED";
    case "REJECT":
    case "RENDERING_FAILURE":
      return "REJECTED";
    case "DELIVERY_DELAY":
      return undefined;
  }
}

/** Terminal events close the pending mail; `Send`, a delay and a transient bounce do not. */
export function closesPending(event: EmailEventPayload): boolean {
  return event.type !== "SEND" && !isDeferral(event);
}

function eventDetail(event: EmailEventPayload): Record<string, string> | undefined {
  const detail: Record<string, string> = {};
  if (event.bounceType !== undefined) detail.bounceType = event.bounceType;
  if (event.smtpResponse !== undefined) detail.smtpResponse = maskSensitive(event.smtpResponse);
  return Object.keys(detail).length === 0 ? undefined : detail;
}

async function undeliveredNotice(deps: ApplyDeps, record: EmailRecord): Promise<UndeliveredNotice | undefined> {
  if (record.complaintId === undefined) return undefined;
  const complaint = await deps.connector.complaints.get(record.worldId, record.complaintId);
  if (complaint === undefined) return undefined;
  return { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", template: UNDELIVERED_TEMPLATE, params: [complaint.complaintNumber], worldId: record.worldId, customerId: record.customerId, complaintId: record.complaintId };
}

export async function applyEmailEvent(input: EmailEventPayload, deps: ApplyDeps): Promise<ApplyResult> {
  const event = EmailEventPayloadSchema.parse(input);
  const ref = { worldId: event.worldId, customerId: event.customerId, sentAtSim: event.sentAtSim, mailId: event.mailId };
  const record = await deps.connector.emails.get(ref);
  // The world was reset or destroyed after the event was queued: nothing left to prove.
  if (record === undefined || record.providerMessageId !== event.providerMessageId) return { outcome: "MISSING" };
  if (record.events.some((seen) => seen.type === event.type && seen.atReal === event.occurredAtReal)) {
    // Closing is idempotent: a redelivery after a crash between the two writes still frees the world.
    if (closesPending(event)) await deps.connector.write(deps.connector.runtime.closePendingOp(event.worldId, "MAIL", event.mailId));
    return { outcome: "DUPLICATE" };
  }

  const atSim = (await deps.simNow()).toISOString();
  const proof = nextProof(record.deliveryProof, event);
  const detail = eventDetail(event);
  await deps.connector.write(deps.connector.emails.recordEventOp(ref, { type: event.type, atReal: event.occurredAtReal, ...(detail ? { detail } : {}) }, proof ?? record.deliveryProof));

  const closedPending = closesPending(event);
  if (closedPending) await deps.connector.write(deps.connector.runtime.closePendingOp(event.worldId, "MAIL", event.mailId));

  const registerProof = proof === "DELIVERED" && record.kind === WRITTEN_ANSWER_KIND && record.complaintId !== undefined;
  if (registerProof && record.complaintId !== undefined) {
    await deps.effects.appendDeliveryProof({ worldId: event.worldId, epoch: event.epoch, complaintId: record.complaintId, mailId: event.mailId, atSim });
  }

  let notify: UndeliveredNotice | undefined;
  if (proof === "BOUNCED" && record.complaintId !== undefined) {
    await deps.effects.handOffUndeliverable({ worldId: event.worldId, complaintId: record.complaintId, atSim, cause: "BOUNCE" });
    notify = await undeliveredNotice(deps, record);
  }
  if (proof === "COMPLAINED") {
    await deps.effects.suppressEmail({ worldId: event.worldId, customerId: event.customerId });
    if (record.complaintId !== undefined) await deps.effects.handOffUndeliverable({ worldId: event.worldId, complaintId: record.complaintId, atSim, cause: "COMPLAINT" });
  }

  let retryAtSim: string | undefined;
  const firstDeferral = isDeferral(event) && !record.events.some((seen) => seen.type === "DELIVERY_DELAY" || (seen.type === "BOUNCE" && seen.detail?.bounceType === "Transient"));
  if (firstDeferral) {
    retryAtSim = new Date(Date.parse(atSim) + DEFERRED_RETRY_MS).toISOString();
    await deps.effects.scheduleRetry({ worldId: event.worldId, customerId: event.customerId, ...(record.complaintId === undefined ? {} : { complaintId: record.complaintId }), mailId: event.mailId, dueAtSim: retryAtSim });
  }

  await deps.connector.audit.append({
    worldId: event.worldId,
    epoch: event.epoch,
    auditId: `email-${event.mailId}-${event.type.toLowerCase().replace(/_/g, "-")}-${Date.parse(event.occurredAtReal)}`,
    ts: deps.now().toISOString(),
    atSim,
    action: "EMAIL_EVENT",
    actor: "SYSTEM",
    refs: { mailId: event.mailId, ...(record.complaintId === undefined ? {} : { complaintId: record.complaintId }) },
    ...(record.complaintId === undefined ? {} : { primaryRef: `CMP#${record.complaintId}` }),
    outcome: event.type,
    ...(proof === undefined ? {} : { detail: { deliveryProof: proof } }),
  });

  const alarm = proof === "REJECTED";
  if (alarm) deps.log.error("email.failed", { worldId: event.worldId, mailId: event.mailId, type: event.type });
  deps.log.info("email.event_applied", { worldId: event.worldId, mailId: event.mailId, type: event.type, deliveryProof: proof, closedPending });
  return {
    outcome: "APPLIED",
    ...(proof === undefined ? {} : { deliveryProof: proof }),
    closedPending,
    registerProof,
    ...(notify === undefined ? {} : { notify }),
    ...(retryAtSim === undefined ? {} : { retryAtSim }),
    alarm,
  };
}
