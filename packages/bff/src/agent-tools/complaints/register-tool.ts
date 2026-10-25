// `register_complaint` (docs/tool-catalog.md, FL-009, FL-012, ADR-0015): the number on the spot, before
// the identity challenge and before investigating. complaints/acknowledge.ts decides everything: an
// open complaint of the same customer, type and object is acknowledged again (`existing`), otherwise
// numbering.ts writes the number, the `FILED` entry (with the presenter's document as the core masks
// it), the complaint, its three milestones and the idempotency claim in one transaction. Then the
// `COMPLAINT_ACK` goes through the gate with a fixed text of copy/ (never the model's): number, type,
// deadline and, while the email consent is pending, the question with the masked registered address and
// its button. The complaint joins the session, so the tools of the rest of the turn see it.
//
// The message of origin is the customer's message of the turn unless the model names an earlier inbound
// one. Idempotent per message of origin and type: the same call again gets the same number and the same
// acknowledgement (the gate's send claim answers the first send).
import { ToolError, ok } from "@reclamo/shared";
import { sourceMessageIdOf } from "../common/principal";
import { COMPLAINT_TYPE_LABEL, CURRENT_EMAIL_CONSENT, WHATSAPP_TEXT, fill } from "../../copy";
import { type AckRequest, type AckSender, acknowledgeComplaint } from "../../complaints/acknowledge";
import { loadHolidays } from "../../complaints/sla";
import { sha256Hex } from "../../lib/crypto";
import { type ToolContext, type ToolImplementation, actorOf } from "../common/context";
import type { ToolInput } from "../common/define";
import { type SystemMessage, sendSystem } from "../messaging/outbound";
import type { ComplaintPorts } from "./ports";
import type { COMPLAINTS_TOOLS } from "./schema";

type RegisterInput = ToolInput<(typeof COMPLAINTS_TOOLS)["register_complaint"]>;

/** The registration's event: one per message of origin and type (`IDEMP#REGISTER#<eventId>`). */
export function registrationEventId(type: string, sourceMessageId: string): string {
  return `reg.${type}.${sha256Hex(sourceMessageId).slice(0, 32)}`;
}

/** The fixed acknowledgement of copy/: number, type, deadline and, while pending, the email question. */
export function ackMessage(request: AckRequest, emailMasked: string | undefined): SystemMessage {
  const key = request.existing ? "COMPLAINT_ACK_EXISTING" : request.kind === "CONSULTA" ? "CONSULTA_ACK" : "COMPLAINT_ACK";
  const ack = fill(WHATSAPP_TEXT[key], { complaintNumber: request.complaintNumber, complaintType: COMPLAINT_TYPE_LABEL[request.type], deadlineText: request.deadlineText });
  const ask = request.askEmailConsent && emailMasked !== undefined;
  return {
    kind: "COMPLAINT_ACK",
    complaintId: request.complaintId,
    text: ask ? `${ack}\n\n${fill(CURRENT_EMAIL_CONSENT.question, { emailMasked })}` : ack,
    ...(ask ? { buttons: [{ action: "ACCEPT_EMAIL" as const, ref: request.complaintId }, { action: "DECLINE_EMAIL" as const, ref: request.complaintId }] } : {}),
    refs: { complaintNumber: request.complaintNumber, ...(ask ? { consentVersion: CURRENT_EMAIL_CONSENT.version } : {}) },
    idParts: [request.complaintId, request.eventId],
  };
}

export function registerComplaintTool(ports: ComplaintPorts): ToolImplementation<RegisterInput> {
  return async (ctx) => {
    const { input, session } = ctx;
    const sourceMessageId = sourceMessageIdOf(session, input.sourceMessageId);
    if (sourceMessageId === undefined) throw new ToolError("INVALID", "this turn answers no message of the customer: name the inbound message the presentation came in", "NO_SOURCE_MESSAGE");
    const deps = ports.complaints(ctx.log);
    const customer = await ports.core().call("getCustomer", { worldId: session.worldId, simNow: session.eventAtSim, correlationId: ctx.correlationId }, { params: { customerId: session.customerId } });
    if (customer.customerId !== session.customerId) throw new ToolError("FORBIDDEN", "the core answered for another customer", "NOT_IN_SESSION");
    let ackMessageId: string | undefined;
    const sendAck: AckSender = async (request) => {
      const sent = await sendSystem(ports.gate, ctx as ToolContext<unknown>, ackMessage(request, customer.emailMasked));
      ackMessageId = sent.messageId;
      return sent.messageId === undefined ? {} : { messageId: sent.messageId };
    };
    const acknowledged = await acknowledgeComplaint(
      deps,
      {
        worldId: session.worldId,
        customerId: session.customerId,
        kind: input.kind,
        type: input.type,
        channel: "WHATSAPP",
        summary: input.summary,
        sourceMessageId,
        eventId: registrationEventId(input.type, sourceMessageId),
        presenter: { docType: customer.document.type, docNumberMasked: customer.document.numberMasked },
        filedAtSim: session.eventAtSim,
        holidays: await loadHolidays(ctx.connector),
        actor: actorOf(ctx.principal),
        ...(ctx.conversation === undefined ? {} : { control: ctx.conversation.control }),
      },
      sendAck,
    );
    const { complaint } = acknowledged;
    await ctx.connector.sessions.addComplaintToSession(session.worldId, session.sessionId, complaint.complaintId);
    await ctx.audit({
      action: "REGISTER_COMPLAINT",
      outcome: acknowledged.created ? "REGISTERED" : acknowledged.existing ? "EXISTING" : "REPLAYED",
      refs: { complaintId: complaint.complaintId, complaintNumber: complaint.complaintNumber, sourceMessageId, ...(ackMessageId === undefined ? {} : { ackMessageId }) },
    });
    return ok({ complaintId: complaint.complaintId, complaintNumber: complaint.complaintNumber, deadlineText: acknowledged.deadlineText, existing: acknowledged.existing });
  };
}
