// What a button (or a keyword, or the classifier's rule for "hablar con una persona") does without a
// turn (docs/tool-catalog.md "Handlers de invocación directa", channels/whatsapp/ports.ts `ButtonEffects`):
//
//   handoff        `escalate_to_human(CUSTOMER_ASKED)` (FL-060): the open complaint to `HUMAN_REVIEW`, or a
//                  human task of the conversation, and the fixed `HANDOFF_NOTICE` (worker/escalation.ts)
//   emailConsent   `record_email_consent` (FL-011): the answer once, with the version of the text the
//                  customer saw; accepted → `ACK_EMAIL` with the PDF; then the fixed confirmation
//   optOut         the customer's opt-out (FL-006): recorded where the channel policy reads consent
//                  (the core's `whatsapp.optedOut`, through `ConsentRecorder`) and audited
//
// Every id derives from the message that carried the button, so a redelivery repeats nothing.
import type { Caller } from "@reclamo/shared";
import { derivedMessageId } from "../agent-tools/messaging/outbound";
import type { ButtonEffects } from "../channels/whatsapp/ports";
import { recordDecision } from "../channels/whatsapp/records";
import { recordEmailConsent } from "../complaints/acknowledge";
import type { ComplaintsDeps } from "../complaints/deps";
import type { Connector } from "../connector/port";
import { CURRENT_EMAIL_CONSENT, WHATSAPP_TEXT, fill } from "../copy";
import type { CoreClient } from "../core/client";
import type { Logger } from "../lib/log";
import type { OutboundGate } from "../outbound/types";
import { handOff } from "../worker/escalation";
import { type AckEmailDeps, ackEmailSender } from "./ack-email";

/** Writes the customer's WhatsApp opt-out where the policy reads it; `false` when no store takes it. */
export interface ConsentRecorder {
  optOut(input: { readonly worldId: string; readonly customerId: string; readonly atSim: string; readonly via: "BUTTON" | "KEYWORD"; readonly caller: Caller }): Promise<boolean>;
}

export interface EffectDeps extends AckEmailDeps {
  readonly data: Connector;
  readonly complaints: ComplaintsDeps;
  readonly gate: OutboundGate;
  readonly core: () => CoreClient;
  readonly consent: ConsentRecorder;
  /** Real time: audit stamps. */
  readonly realNow: () => Date;
  readonly log: Logger;
}

async function confirmConsent(deps: EffectDeps, input: { worldId: string; customerId: string; complaintId: string; sourceMessageId: string; atSim: string; accepted: boolean }): Promise<void> {
  let text: string = WHATSAPP_TEXT.EMAIL_CONSENT_DECLINED;
  if (input.accepted) {
    const customer = await deps.core().call("getCustomer", { worldId: input.worldId, simNow: input.atSim, correlationId: deps.log.correlationId }, { params: { customerId: input.customerId } });
    text = fill(WHATSAPP_TEXT.EMAIL_CONSENT_ACCEPTED, { emailMasked: customer.emailMasked });
  }
  const outcome = await deps.gate(
    {
      worldId: input.worldId,
      customerId: input.customerId,
      complaintId: input.complaintId,
      sender: "SYSTEM",
      channel: "WHATSAPP",
      kind: "REPLY",
      text,
      refs: { source: "INTAKE", purpose: "EMAIL_CONSENT", complaintId: input.complaintId },
      messageId: derivedMessageId(input.worldId, "REPLY", "EMAIL_CONSENT", input.sourceMessageId),
    },
    { actor: "SYSTEM", correlationId: deps.log.correlationId, log: deps.log },
  );
  deps.log.info("intake.email_consent_confirmed", { accepted: input.accepted, ok: outcome.ok });
}

export function intakeEffects(deps: EffectDeps): ButtonEffects {
  return {
    async handoff(input) {
      const epoch = await deps.data.counters.getEpoch(input.worldId);
      await handOff(
        { data: deps.data, complaints: deps.complaints, gate: deps.gate, now: deps.realNow, log: deps.log },
        {
          worldId: input.worldId,
          customerId: input.customerId,
          epoch,
          eventId: input.sourceMessageId,
          eventAtSim: input.atSim,
          correlationId: deps.log.correlationId,
          reason: input.reason,
          summary: `${input.reason} · WHATSAPP`,
          ...(input.complaintId === undefined ? {} : { complaintId: input.complaintId }),
          notify: true,
          cause: "CUSTOMER_ASKED",
          answers: input.sourceMessageId,
        },
      );
    },

    async emailConsent(input) {
      if (input.complaintId === undefined) {
        deps.log.warn("intake.email_consent_without_complaint");
        return;
      }
      // The nonce already binds the complaint to this customer; a complaint of another one is never touched.
      const complaint = await deps.data.complaints.get(input.worldId, input.complaintId, { consistent: true });
      if (complaint === undefined || complaint.customerId !== input.customerId) {
        deps.log.warn("intake.email_consent_foreign_complaint");
        return;
      }
      const result = await recordEmailConsent(
        deps.complaints,
        { worldId: input.worldId, complaintId: input.complaintId, decision: input.accepted ? "ACCEPTED" : "DECLINED", textVersion: CURRENT_EMAIL_CONSENT.version, atSim: input.atSim, actor: "SYSTEM" },
        ackEmailSender(deps, input.atSim),
      );
      if (result.changed) await confirmConsent(deps, { worldId: input.worldId, customerId: input.customerId, complaintId: input.complaintId, sourceMessageId: input.sourceMessageId, atSim: input.atSim, accepted: input.accepted });
    },

    async optOut(input) {
      const caller: Caller = { kind: "CHANNEL", worldId: input.worldId, eventId: input.sourceMessageId };
      const recorded = await deps.consent.optOut({ worldId: input.worldId, customerId: input.customerId, atSim: input.atSim, via: input.via, caller });
      const epoch = await deps.data.counters.getEpoch(input.worldId);
      await recordDecision(deps.data, {
        worldId: input.worldId,
        epoch,
        action: "OPT_OUT",
        outcome: recorded ? "RECORDED" : "NOT_RECORDED",
        wamid: input.sourceMessageId,
        at: deps.realNow(),
        atSim: input.atSim,
        customerId: input.customerId,
        messageId: input.sourceMessageId,
        detail: { via: input.via },
      });
      if (!recorded) deps.log.error("intake.opt_out_not_recorded", { via: input.via });
    },
  };
}
