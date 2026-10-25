// The intake of `InboundWhatsApp` (channels/whatsapp/ports.ts `InboundIntake`, docs/architecture.md §7,
// docs/architecture-integrations.md §10): what happens to a customer's message once the adapter verified
// its origin, resolved the customer by the linked phone, admitted it under the real-hour limit, resolved
// its nonces and opt-out words, announced its image and stored it masked. In order:
//
//   1. classify (classifier.ts): rules first, the small model only behind the kill switch and the cap;
//      `ACTION INTAKE_CLASSIFIED` in `AuditLog` with the source and the rule, never the text;
//   2. decide by code:
//        HUMAN                           a person, without a turn (FL-060)
//        RECLAMO by rule or ≥ 0.7        number, `FILED`, milestones and `COMPLAINT_ACK` (FL-010)
//        FOLLOW_UP status question       the existing number again (FL-013)
//        anything else                   a turn without a number (the agent may register, FL-012)
//   3. enqueue the turn (`CUSTOMER_MESSAGE`) through the single producer, AFTER the acknowledgement;
//      a QA world created with `settings.intakeOnly` (EV-3) stops here: classified, never a turn;
//   4. bind the image to its scan registry (media-intake/resolve.ts), now that the complaint is known:
//      a result already there (or a known seed copy) follows the message's turn as `RECEIPT_RECEIVED`.
//
// A redelivery repeats the same steps with the same derived ids: one number, one acknowledgement, one
// audit entry and one event (SQS deduplication and `IDEMP#` on the worker's side).
import type { Caller } from "@reclamo/shared";
import type { InboundCustomerMessage, InboundIntake } from "../channels/whatsapp/ports";
import { recordDecision } from "../channels/whatsapp/records";
import type { Connector } from "../connector/port";
import { INBOX_CLOSED_STATUSES } from "../domain/complaint";
import type { JsonObject } from "../domain/common";
import { sha256Hex } from "../lib/crypto";
import { type Logger, correlationIdFrom } from "../lib/log";
import type { Enqueuer } from "../worker/enqueue";
import { type AcknowledgeDeps, acknowledgeMessage } from "./acknowledge";
import { type Classification, type ClassifierDeps, classifyIntake, registersNow } from "./classifier";
import type { EffectDeps } from "./effects";
import { intakeEffects } from "./effects";
import { type BindPorts, bindImage } from "./media-events";
import type { OpenComplaintRef } from "./rules";

export type IntakeOutcome = "ACKNOWLEDGED" | "ACKNOWLEDGED_EXISTING" | "TURN" | "HANDOFF";

export interface IntakeDeps {
  readonly data: Connector;
  readonly classifier: Omit<ClassifierDeps, "data" | "log">;
  readonly acknowledge: Omit<AcknowledgeDeps, "data" | "log">;
  readonly effects: Omit<EffectDeps, "data" | "log">;
  readonly media: Omit<BindPorts, "connector" | "enqueuer" | "log">;
  readonly enqueuer: Enqueuer;
  readonly log: Logger;
}

/** The `CUSTOMER_MESSAGE` of an inbound message: one per world and `wamid`. */
export function customerMessageEventId(worldId: string, wamid: string): string {
  return `wa-evt-${sha256Hex(`${worldId}#${wamid}`).slice(0, 32)}`;
}

async function openComplaintsOf(data: Pick<Connector, "complaints">, message: InboundCustomerMessage): Promise<OpenComplaintRef[]> {
  const mine = await data.complaints.listByCustomer(message.worldId, message.customerId, 50);
  return mine
    .filter((complaint) => !INBOX_CLOSED_STATUSES.has(complaint.status))
    .sort((a, b) => Date.parse(b.filedAtSim) - Date.parse(a.filedAtSim))
    .map((complaint) => ({ complaintId: complaint.complaintId, type: complaint.type, filedAtSim: complaint.filedAtSim }));
}

function auditDetail(classification: Classification): JsonObject {
  return {
    source: classification.source,
    confidence: classification.confidence,
    ...(classification.rule === undefined ? {} : { rule: classification.rule }),
    ...(classification.type === undefined ? {} : { type: classification.type }),
    ...(classification.fallback === undefined ? {} : { fallback: classification.fallback }),
    ...(classification.modelMs === undefined ? {} : { modelMs: classification.modelMs }),
  };
}

interface Decided {
  readonly outcome: IntakeOutcome;
  readonly complaintId?: string;
}

async function decide(deps: IntakeDeps, message: InboundCustomerMessage, classification: Classification, eventId: string): Promise<Decided> {
  const ack = { ...deps.acknowledge, data: deps.data, log: deps.log };
  if (classification.kind === "HUMAN") {
    await intakeEffects({ ...deps.effects, data: deps.data, log: deps.log }).handoff({
      worldId: message.worldId,
      customerId: message.customerId,
      sourceMessageId: message.messageId,
      atSim: message.atSim,
      reason: "CUSTOMER_ASKED",
      ...(classification.complaintId === undefined ? {} : { complaintId: classification.complaintId }),
    });
    return { outcome: "HANDOFF", ...(classification.complaintId === undefined ? {} : { complaintId: classification.complaintId }) };
  }
  if (registersNow(classification)) {
    const acknowledged = await acknowledgeMessage(ack, message, { type: classification.type, triggerEventId: eventId });
    return { outcome: acknowledged.existing ? "ACKNOWLEDGED_EXISTING" : "ACKNOWLEDGED", complaintId: acknowledged.complaint.complaintId };
  }
  if (classification.kind === "FOLLOW_UP" && classification.repeatAck === true && classification.type !== undefined) {
    const acknowledged = await acknowledgeMessage(ack, message, { type: classification.type, triggerEventId: eventId });
    return { outcome: "ACKNOWLEDGED_EXISTING", complaintId: acknowledged.complaint.complaintId };
  }
  return { outcome: "TURN", ...(classification.complaintId === undefined ? {} : { complaintId: classification.complaintId }) };
}

/** `settings.intakeOnly` of a QA world (EV-3): the decision is recorded and no turn runs. */
async function intakeOnly(data: Pick<Connector, "worlds">, worldId: string): Promise<boolean> {
  if (!worldId.startsWith("qa-")) return false;
  return (await data.worlds.getSettings(worldId))?.intakeOnly === true;
}

/** The message's turn, through the single producer; always after its acknowledgement. */
async function enqueueTurn(deps: IntakeDeps, message: InboundCustomerMessage, eventId: string, complaintId: string | undefined): Promise<void> {
  const caller: Caller = { kind: "CHANNEL", worldId: message.worldId, eventId };
  await deps.enqueuer.enqueueCustomerEvent(
    {
      type: "CUSTOMER_MESSAGE",
      eventId,
      worldId: message.worldId,
      customerId: message.customerId,
      epoch: message.epoch,
      eventAtSim: message.atSim,
      correlationId: correlationIdFrom(deps.log.correlationId),
      payload: { messageId: message.messageId, messageAtSim: message.atSim, complaintIds: complaintId === undefined ? [] : [complaintId] },
    },
    caller,
  );
}

export function createIntake(deps: IntakeDeps): InboundIntake {
  return {
    async accept(message) {
      const eventId = customerMessageEventId(message.worldId, message.wamid);
      const openComplaints = await openComplaintsOf(deps.data, message);
      const classification = await classifyIntake(
        { ...deps.classifier, data: deps.data, log: deps.log },
        { worldId: message.worldId, epoch: message.epoch, text: message.text.text, hasImage: message.media !== undefined, openComplaints, ...(message.button === undefined ? {} : { button: message.button }) },
      );
      await recordDecision(deps.data, {
        worldId: message.worldId,
        epoch: message.epoch,
        action: "INTAKE_CLASSIFIED",
        outcome: classification.kind,
        wamid: message.wamid,
        at: deps.classifier.realNow(),
        atSim: message.atSim,
        customerId: message.customerId,
        messageId: message.messageId,
        detail: auditDetail(classification),
      });
      deps.log.info("intake.classified", { kind: classification.kind, source: classification.source, rule: classification.rule ?? "none", fallback: classification.fallback ?? "none" });

      const decided = await decide(deps, message, classification, eventId);
      if (decided.outcome !== "HANDOFF" && !(await intakeOnly(deps.data, message.worldId))) await enqueueTurn(deps, message, eventId, decided.complaintId);
      if (message.media !== undefined) {
        await bindImage(
          { ...deps.media, connector: deps.data, enqueuer: deps.enqueuer, log: deps.log },
          { worldId: message.worldId, customerId: message.customerId, messageId: message.messageId, announceKey: message.media.announceKey, ...(decided.complaintId === undefined ? {} : { complaintId: decided.complaintId }) },
        );
      }
      return { outcome: decided.outcome };
    },
  };
}
