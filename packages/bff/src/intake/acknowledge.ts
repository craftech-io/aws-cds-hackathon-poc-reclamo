// The number on the spot (ADR-0015, FL-010, FL-013): `acknowledge_complaint` of complaints/acknowledge.ts
// for a message the classifier decided is a complaint, BEFORE its turn is enqueued. The number, the
// `FILED` entry (with the presenter's document as the core masks it), the complaint and its three
// milestones go in one transaction; an open complaint of the same customer and type is acknowledged
// again instead (`COMPLAINT_ACK_EXISTING`, never a second number). The `COMPLAINT_ACK` is the fixed
// text of copy/ that `register_complaint` also sends (agent-tools/complaints/register-tool.ts
// `ackMessage`), through the one exit, `sendThroughGate`, with `sender SYSTEM`.
//
// `ackLatencyMs` (docs/architecture-integrations.md §10 step 4): from the provider's `message_timestamp`
// (or the simulated envelope's signing time) to the transport's acceptance of the acknowledgement, with
// `coldStart` marked. It goes to the log (`AckLatency`, metric filter) and to the complaint's KPI row.
import type { ComplaintType, MessageKind } from "@reclamo/shared";
import { worldKindOf } from "@reclamo/shared";
import { ackMessage } from "../agent-tools/complaints/register-tool";
import { derivedMessageId } from "../agent-tools/messaging/outbound";
import { type AckSender, acknowledgeComplaint } from "../complaints/acknowledge";
import type { ComplaintsDeps } from "../complaints/deps";
import { loadHolidays } from "../complaints/sla";
import type { Connector } from "../connector/port";
import type { CoreClient } from "../core/client";
import type { Complaint } from "../domain/complaint";
import { COMPLAINT_TYPE_LABEL } from "../copy";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { OutboundGate, OutboundRequest } from "../outbound/types";
import type { InboundCustomerMessage } from "../channels/whatsapp/ports";
import type { AgentMode } from "../turns/record";

export const ACK_LATENCY_METRIC = "AckLatency";

export interface AcknowledgeDeps {
  readonly data: Pick<Connector, "conversations" | "metrics">;
  readonly complaints: ComplaintsDeps;
  readonly gate: OutboundGate;
  readonly core: () => CoreClient;
  /** Real time: the transport's acceptance. */
  readonly realNow: () => Date;
  /** The first invocation of this container. */
  readonly coldStart: boolean;
  /** `SCRIPTED` in the local flows and the captures (their real time is fixed): never a measured latency. */
  readonly agentMode?: AgentMode;
  readonly log: Logger;
}

export interface AckOutcome {
  readonly complaint: Complaint;
  readonly created: boolean;
  readonly existing: boolean;
  readonly ackMessageId?: string;
  readonly ackLatencyMs?: number;
}

/** One registration per inbound message: the same `wamid` again finds the same number. */
export function registrationEventId(worldId: string, wamid: string): string {
  return `wa-reg-${sha256Hex(`${worldId}#${wamid}`).slice(0, 32)}`;
}

/** The KPI row of the complaint: the acknowledgement's latency (the turns add their tokens to it). */
async function recordAckKpi(deps: AcknowledgeDeps, complaint: Complaint, ackLatencyMs: number): Promise<void> {
  const batch = worldKindOf(complaint.worldId) === "SIM";
  try {
    await deps.data.metrics.put({
      worldId: complaint.worldId,
      source: batch ? "BATCH" : "WORLD",
      runId: batch ? complaint.worldId : "world",
      complaintId: complaint.complaintId,
      complaintType: complaint.type,
      agentMode: deps.agentMode ?? "REAL",
      origin: complaint.origin,
      ackLatencyMs,
      coldStart: deps.coldStart,
      humanActions: [],
      tokens: { in: 0, out: 0, cached: 0 },
      messages: { wa: 0, email: 0 },
      atSim: complaint.filedAtSim,
    });
  } catch (error) {
    // The latency is already in the log line; a KPI row that could not be written never fails the message.
    deps.log.warn("intake.ack_kpi_not_written", { errorName: error instanceof Error ? error.name : "unknown" });
  }
}

/** Number (or the open one) and the `COMPLAINT_ACK` through the gate, then the latency. */
export async function acknowledgeMessage(deps: AcknowledgeDeps, message: InboundCustomerMessage, input: { readonly type: ComplaintType; readonly triggerEventId: string }): Promise<AckOutcome> {
  const { worldId, customerId } = message;
  const correlationId = deps.log.correlationId;
  const customer = await deps.core().call("getCustomer", { worldId, simNow: message.atSim, correlationId }, { params: { customerId } });
  let ackMessageId: string | undefined;
  let acceptedAt: Date | undefined;
  const sendAck: AckSender = async (request) => {
    const system = ackMessage(request, customer.emailMasked);
    const kind: MessageKind = system.kind;
    const messageId = derivedMessageId(worldId, kind, ...(system.idParts ?? [request.complaintId, request.eventId]));
    const replay = (await deps.data.conversations.findMessage(worldId, customerId, messageId)) !== undefined;
    const outbound: OutboundRequest = {
      worldId,
      customerId,
      complaintId: request.complaintId,
      sender: "SYSTEM",
      channel: "WHATSAPP",
      kind,
      text: system.text,
      ...(system.buttons === undefined ? {} : { buttons: system.buttons }),
      refs: { source: "INTAKE", ...(system.refs ?? {}) },
      triggerEventId: input.triggerEventId,
      messageId,
    };
    const outcome = await deps.gate(outbound, { actor: "SYSTEM", correlationId, log: deps.log });
    ackMessageId = outcome.messageId;
    if (outcome.ok && outcome.decision === "ALLOWED" && !replay) acceptedAt = deps.realNow();
    if (!outcome.ok) deps.log.warn("intake.ack_refused", { code: outcome.failure.error.code, decision: outcome.decision ?? "UNDECIDED", ruleIds: [...outcome.ruleIds] });
    return outcome.messageId === undefined ? {} : { messageId: outcome.messageId };
  };
  const acknowledged = await acknowledgeComplaint(
    deps.complaints,
    {
      worldId,
      customerId,
      kind: "RECLAMO",
      type: input.type,
      channel: "WHATSAPP",
      summary: message.text.text.trim() === "" ? COMPLAINT_TYPE_LABEL[input.type] : message.text.text,
      ...(message.button?.loanId === undefined ? {} : { subject: { loanId: message.button.loanId } }),
      sourceMessageId: message.messageId,
      eventId: registrationEventId(worldId, message.wamid),
      presenter: { docType: customer.document.type, docNumberMasked: customer.document.numberMasked },
      filedAtSim: message.atSim,
      holidays: await loadHolidays(deps.complaints.connector),
      actor: "SYSTEM",
    },
    sendAck,
  );
  const outcome: AckOutcome = { complaint: acknowledged.complaint, created: acknowledged.created, existing: acknowledged.existing, ...(ackMessageId === undefined ? {} : { ackMessageId }) };
  if (acceptedAt === undefined || !acknowledged.created) return outcome;
  const ackLatencyMs = Math.max(0, acceptedAt.getTime() - Date.parse(message.eventAtReal));
  deps.log.info("intake.ack_latency", { metric: ACK_LATENCY_METRIC, ackLatencyMs, coldStart: deps.coldStart, origin: message.origin, complaintType: input.type });
  await recordAckKpi(deps, acknowledged.complaint, ackLatencyMs);
  return { ...outcome, ackLatencyMs };
}
