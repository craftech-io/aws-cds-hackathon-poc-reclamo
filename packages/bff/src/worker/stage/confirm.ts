// The confirmation emails of a closure and a data change in the stage (worker/confirmations.ts): fixed
// texts of copy/, sender `SYSTEM`, by email through the one exit (ADR-0006), to the address the core has
// on file today (the gate resolves it; a pending email change never receives anything). The closure
// carries its PDF receipt with the conditions the core stated, stored in `Documents` before the gate.
import { CLOSURE_CONDITION_TEXT } from "../../agent-tools/actions/account-actions";
import { dayTimeText } from "../../agent-tools/account/format";
import { type DocumentStore, documentKey } from "../../agent-tools/complaints/ports";
import { DATA_CHANGE_FIELD_LABEL, EMAIL_TEXT, fill } from "../../copy";
import { renderDocument } from "../../pdf/documents";
import type { OutboundAttachment, OutboundGate } from "../../outbound/types";
import { type ConfirmationKind, confirmationKind, confirmationMessageId } from "../confirmations";
import type { ConfirmationRequest, WorkerContext } from "../ports";

export interface StageConfirmDeps {
  readonly gate: OutboundGate;
  readonly documents: () => DocumentStore;
}

interface Confirmation {
  readonly text: string;
  readonly attachments: readonly OutboundAttachment[];
}

async function closure(deps: StageConfirmDeps, request: ConfirmationRequest): Promise<Confirmation> {
  const { complaint, action } = request;
  const conditions = (action.closureConditions ?? []).map((code) => CLOSURE_CONDITION_TEXT[code]);
  const rendered = renderDocument({ docKind: "CLOSURE", complaintNumber: complaint.complaintNumber, issuedAtSim: request.eventAtSim, requestedAtSim: action.atSim, conditions });
  const s3Key = documentKey(request.worldId, complaint.complaintId, rendered.docKind, rendered.sha256);
  await deps.documents().put(s3Key, rendered.bytes, rendered.contentType);
  const body = fill(EMAIL_TEXT.CLOSURE_BODY, { requestedAtText: dayTimeText(action.atSim), complaintNumber: complaint.complaintNumber });
  return { text: [body, ...conditions].join(" "), attachments: [{ docKind: rendered.docKind, s3Key, sha256: rendered.sha256 }] };
}

function dataChange(request: ConfirmationRequest): Confirmation | undefined {
  const field = request.action.dataChangeField;
  if (field === undefined) return undefined;
  return { text: fill(EMAIL_TEXT.DATA_CHANGE_BODY, { field: DATA_CHANGE_FIELD_LABEL[field] }), attachments: [] };
}

/** `confirmAction` in the stage: one confirmation email per action, through the gate. */
export function stageConfirmation(deps: StageConfirmDeps) {
  return async (request: ConfirmationRequest, ctx: WorkerContext): Promise<void> => {
    const kind: ConfirmationKind | undefined = confirmationKind(request.action);
    if (kind === undefined) return;
    const confirmation = kind === "CLOSURE_CONFIRMATION" ? await closure(deps, request) : dataChange(request);
    if (confirmation === undefined) {
      ctx.log.warn("worker.confirmation_skipped", { kind, reason: "NO_FIELD" });
      return;
    }
    const { complaint, action } = request;
    const outcome = await deps.gate(
      {
        worldId: request.worldId,
        customerId: request.customerId,
        complaintId: complaint.complaintId,
        sender: "SYSTEM",
        channel: "EMAIL",
        kind,
        text: confirmation.text,
        ...(confirmation.attachments.length === 0 ? {} : { attachments: confirmation.attachments }),
        refs: { eventId: request.eventId, purpose: kind, complaintId: complaint.complaintId, actionId: action.actionId },
        triggerEventId: request.eventId,
        messageId: confirmationMessageId(action, kind),
      },
      { actor: "SYSTEM", correlationId: request.correlationId ?? request.eventId, log: ctx.log },
    );
    ctx.log.info("worker.confirmation", { kind, ok: outcome.ok, decision: outcome.ok ? outcome.decision : (outcome.decision ?? "UNDECIDED") });
  };
}
