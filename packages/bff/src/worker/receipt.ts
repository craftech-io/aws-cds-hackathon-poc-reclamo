// What the worker does with a `RECEIPT_RECEIVED` before its turn (docs/architecture-integrations.md §9,
// docs/architecture.md §6-§7). `MediaIntake` and `InboundWhatsApp` only hand over the checked image
// (media-intake/schema.ts `ReceiptReceivedPayload`): MediaIntake cannot write `Complaints`
// (infra/iam-capabilities.ts), so the worker files the `RECEIPT_IMAGE` evidence here, once per message
// (media-intake/intake.ts `receiptImageEvidence`, id `evd-img-<messageId>`), in:
//
//   1. the complaint the producer named, when it is the customer's and still open; otherwise
//   2. the customer's newest open complaint.
//
// Without any open complaint the image stays on the conversation: the message's own `CUSTOMER_MESSAGE`
// turn already saw it, so no second turn runs (`RECEIPT_WITHOUT_COMPLAINT`).
import { isConflict } from "../connector/errors";
import type { Connector } from "../connector/port";
import { INBOX_CLOSED_STATUSES } from "../domain/complaint";
import { receiptImageEvidence } from "../media-intake/intake";
import type { EventOf } from "./events";
import type { WorkerContext } from "./ports";

type ReceiptEvent = EventOf<"RECEIPT_RECEIVED">;

/** The open complaint of the customer the image belongs to, or `undefined`. */
export async function receiptComplaintOf(data: Pick<Connector, "complaints">, event: ReceiptEvent): Promise<string | undefined> {
  const mine = (await data.complaints.listByCustomer(event.worldId, event.customerId, 50)).filter((complaint) => !INBOX_CLOSED_STATUSES.has(complaint.status));
  const named = event.payload.complaintId;
  if (named !== undefined && mine.some((complaint) => complaint.complaintId === named)) return named;
  return mine.sort((a, b) => Date.parse(b.filedAtSim) - Date.parse(a.filedAtSim))[0]?.complaintId;
}

/**
 * Files the image as `RECEIPT_IMAGE` evidence and returns the event with the complaint it went to, or
 * `undefined` when the customer has no open complaint. A redelivery finds the evidence written and goes on.
 */
export async function fileReceipt(data: Pick<Connector, "complaints" | "caseItems">, ctx: Pick<WorkerContext, "log">, event: ReceiptEvent): Promise<ReceiptEvent | undefined> {
  const complaintId = await receiptComplaintOf(data, event);
  if (complaintId === undefined) {
    ctx.log.info("receipt.without_complaint", { outcome: "RECEIPT_WITHOUT_COMPLAINT" });
    return undefined;
  }
  const evidence = receiptImageEvidence({ worldId: event.worldId, complaintId, payload: event.payload, atSim: event.payload.messageAtSim });
  try {
    await data.caseItems.putEvidence(evidence);
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  return { ...event, payload: { ...event.payload, complaintId } };
}
