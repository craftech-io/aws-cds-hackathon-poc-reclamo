// `ACK_EMAIL` (FL-011, BCRA 3.1.6): once the customer accepts the registered email with the button of
// the acknowledgement, the acknowledgement goes there as well, with its PDF (`ACK`, the hash of the
// complaint's `FILED` entry printed on it). The PDF is rendered by pdf/ from the complaint and the
// register, stored in `Documents` under the complaint, and the email leaves through the one exit,
// `sendThroughGate` (`sender SYSTEM`, exempt kind, the recipient fence of the gate). Its message id
// derives from the complaint, so a repeated tap never sends it twice.
import { ToolError } from "@reclamo/shared";
import { documentKey } from "../agent-tools/complaints/ports";
import { derivedMessageId } from "../agent-tools/messaging/outbound";
import type { EmailObjectStore } from "../channels/email/store";
import type { AckEmailSender } from "../complaints/acknowledge";
import { deadlineText } from "../complaints/sla";
import type { Connector } from "../connector/port";
import { COMPLAINT_TYPE_LABEL, EMAIL_TEXT, fill } from "../copy";
import type { Logger } from "../lib/log";
import type { OutboundGate } from "../outbound/types";
import { renderDocument } from "../pdf/documents";
import { dateAr } from "../pdf/format";

export interface AckEmailDeps {
  readonly data: Pick<Connector, "chains">;
  readonly gate: OutboundGate;
  readonly documents: () => EmailObjectStore;
  readonly log: Logger;
}

/** The sender `recordEmailConsent` calls after an accepted consent; `atSim` is the tap's instant. */
export function ackEmailSender(deps: AckEmailDeps, atSim: string): AckEmailSender {
  return async (complaint) => {
    const entries = await deps.data.chains.listRegisterByComplaint(complaint.worldId, complaint.epoch, complaint.complaintNumber);
    const filed = entries.find((entry) => entry.eventType === "FILED");
    if (filed === undefined) throw new ToolError("NOT_FOUND", "the complaint has no FILED entry");
    const rendered = renderDocument({
      docKind: "ACK",
      complaintNumber: complaint.complaintNumber,
      issuedAtSim: atSim,
      type: complaint.type,
      channel: complaint.channel,
      filedAtSim: complaint.filedAtSim,
      deadlineSim: complaint.deadlineSim,
      filedHash: filed.hash,
    });
    const s3Key = documentKey(complaint.worldId, complaint.complaintId, "ACK", rendered.sha256);
    await deps.documents().put(s3Key, rendered.bytes, rendered.contentType);
    const body = fill(EMAIL_TEXT[complaint.kind === "CONSULTA" ? "ACK_BODY_CONSULTA" : "ACK_BODY_RECLAMO"], {
      complaintNumber: complaint.complaintNumber,
      complaintType: COMPLAINT_TYPE_LABEL[complaint.type],
      filedAtText: dateAr(complaint.filedAtSim),
      deadlineText: deadlineText(complaint.deadlineSim),
    });
    const outcome = await deps.gate(
      {
        worldId: complaint.worldId,
        customerId: complaint.customerId,
        complaintId: complaint.complaintId,
        sender: "SYSTEM",
        channel: "EMAIL",
        kind: "ACK_EMAIL",
        text: body,
        attachments: [{ docKind: "ACK", s3Key, sha256: rendered.sha256 }],
        refs: { source: "INTAKE", complaintNumber: complaint.complaintNumber },
        messageId: derivedMessageId(complaint.worldId, "ACK_EMAIL", complaint.complaintId),
      },
      { actor: "SYSTEM", correlationId: deps.log.correlationId, log: deps.log },
    );
    if (!outcome.ok) deps.log.warn("intake.ack_email_refused", { code: outcome.failure.error.code, decision: outcome.decision ?? "UNDECIDED", ruleIds: [...outcome.ruleIds] });
    return outcome.messageId === undefined ? {} : { messageId: outcome.messageId };
  };
}
