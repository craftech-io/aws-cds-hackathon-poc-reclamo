// `read_receipt` and `reconcile_payment` (docs/tool-catalog.md, docs/architecture-integrations.md §6.1
// and §7; FL-016…FL-022, FL-026, FL-111). Both run the deterministic services of receipts/ and
// reconcile/ below the fences: the evidence of the input was already proved to be of a complaint of the
// session (`LAM-SCOPE`), the customer is identified and the complaint open.
//
//   read_receipt       the reading of the complaint's RECEIPT_IMAGE (budget, Bedrock, fallback,
//                      validation, duplicate check); the image never comes back, and only validated
//                      fields of a READ (or DUPLICATE_OF) reading reach the model. INVALID_RECEIPT (a
//                      check digit or a format that cannot be) goes to a person by code (RECEIPT_DOUBT)
//                      with the fixed notice: another photo would not change it, so no attempts are offered.
//   reconcile_payment  the decision against the published settlement (or the customer's wallet or
//                      transfer movement); then what the code does on its own:
//                        PENDING_BATCH   the SETTLEMENT_RECHECK timer of the complaint and batch;
//                        PAYER_MISMATCH  a person reviews it (RECEIPT_DOUBT) with the fixed notice, and
//                                        nothing of the other payer reaches the answer.
import { ToolError, ok } from "@reclamo/shared";
import type { Connector } from "../../connector/port";
import type { JsonObject } from "../../domain/common";
import type { Logger } from "../../lib/log";
import { type ReconcileDeps, type ReconcileResponse, reconcilePayment } from "../../reconcile/service";
import { receiptFallbackForced } from "../../receipts/force";
import { type ReadReceiptResponse, type ReceiptServiceDeps, readReceiptEvidence } from "../../receipts/service";
import type { ToolContext, ToolImplementation } from "../common/context";
import type { ToolInput } from "../common/define";
import { dayText, dayTimeText, money } from "../account/format";
import { complaintOf } from "./evidence";
import { type HandoffOutcome, type HandoffPorts, handOverByCode } from "./handoff";
import { ensureRecheckTimer } from "./recheck";
import type { INVESTIGATION_TOOLS } from "./schema";

type Tools = typeof INVESTIGATION_TOOLS;

export interface PaymentPorts extends HandoffPorts {
  /** receipts/ over the call's connector and logger (Bedrock, images, budget). */
  readonly receipts: (connector: Connector, log: Logger) => ReceiptServiceDeps;
  /** reconcile/ over the call's connector and logger (core, network, settlement files). */
  readonly reconcile: (connector: Connector, log: Logger) => ReconcileDeps;
}

/** `2026-10-06T18:40` as printed → its instant in Argentina. */
function printedInstant(paidAtLocal: string): string {
  return `${paidAtLocal}:00-03:00`;
}

function receiptView(response: ReadReceiptResponse) {
  const fields = response.fields;
  return {
    result: response.result,
    readingId: response.readingId,
    evidenceId: response.readingEvidenceId,
    source: response.source,
    ...(fields === undefined
      ? {}
      : { fields: { network: fields.network, operationCode: fields.operationCode, amount: money(fields.amount), paidAtText: dayTimeText(printedInstant(fields.paidAtLocal)) } }),
    ...(response.duplicateOf === undefined ? {} : { duplicateOf: response.duplicateOf }),
    // Another photo is offered only for a reading that could not be read; an impossible receipt goes to a person.
    ...(response.result === "INVALID_RECEIPT" ? {} : { attemptsLeft: response.attemptsLeft }),
  };
}

function reconciliationView(response: ReconcileResponse) {
  const base = { result: response.result, reconciliationId: response.reconciliationId, evidenceId: response.evidenceId, source: response.source };
  const decision = response.decision;
  switch (decision.result) {
    case "MATCHED":
      return "line" in decision
        ? { ...base, match: { network: decision.line.network, businessDateText: dayText(`${decision.line.businessDate}T12:00:00-03:00`), operationCode: decision.line.operationCode, amount: money(decision.line.amount), batchSha256: decision.line.batchSha256 } }
        : { ...base, match: { network: response.source, operationCode: decision.movement.operationId, amount: money(decision.movement.amount), paidAtText: dayTimeText(decision.movement.atSim) } };
    case "AMOUNT_MISMATCH":
      return "line" in decision ? { ...base, amountFound: money(decision.line.amount) } : { ...base, amountFound: money(decision.movement.amount) };
    case "ALREADY_APPLIED":
      // `ALREADY_APPLIED` is decided only on an imputation to the session's own customer.
      return { ...base, appliedAtText: dayTimeText(decision.appliedAtSim) };
    case "PENDING_BATCH":
      return { ...base, pendingBatch: { network: decision.pending.network, publishAtText: dayTimeText(decision.pending.publishAtSim) } };
    default:
      // PAYER_MISMATCH and NOT_FOUND: never a line, a date or a reference of anyone else.
      return base;
  }
}

/** What a hand-over by code adds to the tool's answer. */
function handedOverOf(handoff: HandoffOutcome): JsonObject {
  return {
    handedOver: handoff.handedOver.length > 0,
    ...(handoff.handoffNoticeMessageId === undefined ? {} : { handoffNoticeMessageId: handoff.handoffNoticeMessageId }),
  };
}

export function paymentTools(ports: PaymentPorts) {
  const readReceipt: ToolImplementation<ToolInput<Tools["read_receipt"]>> = async (ctx) => {
    const complaint = complaintOf(ctx);
    const image = ctx.findings.evidence.find((item) => item.evidenceId === ctx.input.evidenceId || item.refId === ctx.input.evidenceId);
    if (image === undefined || image.kind !== "RECEIPT_IMAGE") throw new ToolError("EVIDENCE_REQUIRED", "evidenceId must be the RECEIPT_IMAGE evidence of this complaint");
    if (image.complaintId !== complaint.complaintId) throw new ToolError("FORBIDDEN", "the receipt is not of the complaint being investigated");
    const response = await readReceiptEvidence(ports.receipts(ctx.connector, ctx.log), {
      worldId: ctx.session.worldId,
      epoch: complaint.epoch,
      complaintId: complaint.complaintId,
      customerId: ctx.session.customerId,
      evidenceId: image.evidenceId,
      simNow: new Date(ctx.session.eventAtSim),
      turnId: ctx.session.turnId,
      ...((await receiptFallbackForced(ctx.connector, ctx.session.worldId)) ? { forceFallback: true } : {}),
    });
    const effect = response.result === "INVALID_RECEIPT" ? await invalidReceipt(ctx as ToolContext<unknown>, response.readingId) : {};
    await ctx.audit({ outcome: response.result, refs: { readingId: response.readingId, evidenceId: response.readingEvidenceId }, ...(Object.keys(effect).length === 0 ? {} : { detail: effect }) });
    return ok({ ...receiptView(response), ...effect });
  };

  /** A receipt that cannot be (check digit, format): a person reviews it, never the customer accused. */
  async function invalidReceipt(ctx: ToolContext<unknown>, readingId: string): Promise<JsonObject> {
    const handoff = await handOverByCode(ports, ctx, {
      reason: "RECEIPT_DOUBT",
      cause: "INVALID_RECEIPT",
      complaints: [complaintOf(ctx)],
      summary: `Lectura ${readingId}: el comprobante no supera la validación (dígito verificador o formato); revisarlo sin acusar al cliente.`,
    });
    return handedOverOf(handoff);
  }

  async function payerMismatch(ctx: ToolContext<unknown>, response: ReconcileResponse): Promise<JsonObject> {
    const complaint = complaintOf(ctx);
    const handoff = await handOverByCode(ports, ctx, {
      reason: "RECEIPT_DOUBT",
      cause: "PAYER_MISMATCH",
      complaints: [complaint],
      summary: `Conciliación ${response.reconciliationId}: la línea de la rendición no es de este cliente; revisar el comprobante sin acusar al cliente.`,
    });
    return handedOverOf(handoff);
  }

  const reconcile: ToolImplementation<ToolInput<Tools["reconcile_payment"]>> = async (ctx) => {
    const complaint = complaintOf(ctx);
    const source = ctx.input.source ?? "SETTLEMENT";
    const response = await reconcilePayment(ports.reconcile(ctx.connector, ctx.log), {
      worldId: ctx.session.worldId,
      epoch: complaint.epoch,
      complaintId: complaint.complaintId,
      customerId: ctx.session.customerId,
      source,
      ...(ctx.input.readingId === undefined ? {} : { readingId: ctx.input.readingId }),
      ...(ctx.input.movementId === undefined ? {} : { movementId: ctx.input.movementId }),
      simNow: new Date(ctx.session.eventAtSim),
      actor: ctx.principal.kind === "HARNESS" ? "AGENT" : "SYSTEM",
      turnId: ctx.session.turnId,
      correlationId: ctx.correlationId,
    });
    const view = reconciliationView(response);
    let effect: JsonObject = {};
    if (response.decision.result === "PENDING_BATCH") {
      const recheck = await ensureRecheckTimer(ports.complaints(), complaint, response.decision.pending, ctx.log);
      effect = { recheckTimerId: recheck.timerId };
    } else if (response.result === "PAYER_MISMATCH") {
      effect = await payerMismatch(ctx, response);
    }
    await ctx.audit({ outcome: response.result, refs: { reconciliationId: response.reconciliationId, evidenceId: response.evidenceId }, ...(Object.keys(effect).length === 0 ? {} : { detail: effect }) });
    return ok({ ...view, ...effect });
  };

  return { read_receipt: readReceipt, reconcile_payment: reconcile } as const;
}
