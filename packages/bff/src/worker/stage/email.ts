// The effects of `record_email_event` in the worker (email-events/apply.ts `EmailEventEffects`,
// docs/architecture-integrations.md §3): what an SES event of one of our emails changes beyond its record.
//
//   DELIVERED written answer   `DELIVERY_PROOF` in the register with the answer's message (complaints/answer.ts)
//   bounce or complaint        the complaint to a person, `EMAIL_UNDELIVERABLE`, without a notice of its
//                              own (the worker sends the fixed update after the effects, by the gate)
//   complaint of the address   audited `EMAIL_SUPPRESSED` (the core's flag is not modelled yet)
//   first transient bounce     one `DEFERRED_SEND` timer at +1 simulated hour with the same email as a new
//                              message: its content was checked when it first went out, so the gate decides
//                              the policy, the fence and the transport again, and never twice the content
import type { MessageKind, Sender } from "@reclamo/shared";
import { recordDeliveryProof } from "../../complaints/answer";
import type { ComplaintsDeps } from "../../complaints/deps";
import { isConflict } from "../../connector/errors";
import type { Connector } from "../../connector/port";
import type { EmailEventEffects } from "../../email-events/apply";
import { contentHashOf } from "../../outbound/defer";
import { DocKind, type OutboundGate, type OutboundRequest } from "../../outbound/types";
import { WORKER_ACTIONS, auditOnce } from "../audit";
import { handOff } from "../escalation";
import type { EventOf } from "../events";
import type { WorkerContext } from "../ports";

export interface StageEmailDeps {
  readonly data: Connector;
  readonly complaints: () => ComplaintsDeps;
  readonly gate: OutboundGate;
}

/** The kept request of the retry: the email as it went out, under a new message id. */
async function retryRequest(data: Connector, input: { worldId: string; customerId: string; complaintId?: string; mailId: string }): Promise<{ request: OutboundRequest; actor: Sender } | undefined> {
  const record = await data.emails.find(input.worldId, input.customerId, input.mailId);
  if (record?.messageId === undefined) return undefined;
  const message = await data.conversations.findMessage(input.worldId, input.customerId, record.messageId);
  if (message === undefined) return undefined;
  const attachments = record.attachments.flatMap((file) => {
    const docKind = DocKind.safeParse(file.docKind);
    return docKind.success ? [{ docKind: docKind.data, s3Key: file.s3Key, sha256: file.sha256 }] : [];
  });
  const actor: Sender = message.sender ?? "SYSTEM";
  const base: OutboundRequest = {
    worldId: input.worldId,
    customerId: input.customerId,
    ...(input.complaintId === undefined ? {} : { complaintId: input.complaintId }),
    sender: actor,
    channel: "EMAIL",
    kind: record.kind as MessageKind,
    text: message.body,
    subject: record.subject,
    ...(attachments.length === 0 ? {} : { attachments }),
    refs: { retryOf: input.mailId },
    messageId: `${record.messageId}-retry`.slice(0, 128),
  };
  return { request: { ...base, refs: { ...base.refs, contentHash: contentHashOf(base) } }, actor };
}

/** The effects of one `EMAIL_EVENT`, bound to its world, epoch and customer. */
export function stageEmailEffects(deps: StageEmailDeps) {
  return (event: EventOf<"EMAIL_EVENT">, ctx: WorkerContext): EmailEventEffects => {
    const handoffDeps = { data: deps.data, complaints: deps.complaints(), gate: deps.gate, now: ctx.now, log: ctx.log };
    return {
      async appendDeliveryProof(input) {
        const complaint = await deps.data.complaints.get(input.worldId, input.complaintId, { consistent: true });
        const messageId = complaint?.answer?.mailId === input.mailId ? complaint.answer.messageId : undefined;
        if (messageId === undefined) {
          ctx.log.warn("email.delivery_proof_not_the_answer");
          return;
        }
        await recordDeliveryProof(deps.complaints(), { worldId: input.worldId, complaintId: input.complaintId, messageId, proof: "DELIVERED", atSim: input.atSim });
      },
      async handOffUndeliverable(input) {
        await handOff(handoffDeps, {
          worldId: input.worldId,
          customerId: event.customerId,
          epoch: event.epoch,
          eventId: event.eventId,
          eventAtSim: input.atSim,
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
          reason: "EMAIL_UNDELIVERABLE",
          summary: `EMAIL_UNDELIVERABLE · ${input.cause}`,
          complaintId: input.complaintId,
          notify: false,
          cause: `EMAIL_${input.cause}`,
        });
      },
      async suppressEmail(input) {
        ctx.log.warn("email.suppressed");
        await auditOnce({ data: deps.data, now: ctx.now, log: ctx.log }, { action: WORKER_ACTIONS.emailSuppressed, worldId: input.worldId, epoch: event.epoch, eventId: event.eventId, atSim: event.eventAtSim, refs: { customerId: input.customerId, mailId: event.payload.mailId } });
      },
      async scheduleRetry(input) {
        const kept = await retryRequest(deps.data, input);
        if (kept === undefined) {
          ctx.log.warn("email.retry_without_message");
          return;
        }
        const timerId = `${input.mailId}-RETRY`;
        try {
          await deps.data.timers.put({
            worldId: input.worldId,
            kind: "DEFERRED_SEND",
            timerId,
            dueAtSim: input.dueAtSim,
            seq: 0,
            status: "SCHEDULED",
            epoch: event.epoch,
            ownerKey: `MAIL#${input.mailId}`,
            payload: { customerId: input.customerId, ...(input.complaintId === undefined ? {} : { complaintId: input.complaintId }), request: JSON.parse(JSON.stringify(kept.request)) as Record<string, never>, actor: kept.actor },
          });
        } catch (error) {
          // A redelivered event: the one retry already exists.
          if (!isConflict(error)) throw error;
          return;
        }
        await deps.complaints().milestones?.schedule(input.worldId, [{ kind: "DEFERRED_SEND", timerId }]);
      },
    };
  };
}
