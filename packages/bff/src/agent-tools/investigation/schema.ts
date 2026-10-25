// Target `investigation` (`ToolInvestigation`, docs/tool-catalog.md): every tool needs the customer
// identified and an open complaint of the session (`LAM-IDENTIFIED`, `LAM-COMPLAINT-REQUIRED`) and
// leaves an evidence on it. A receipt reading alone never applies a payment: only a settlement line of
// the same customer does (`reconcile_payment`). The zod here is the only source of the Gateway schema.
import { z } from "zod";
import type { ComplaintType } from "@reclamo/shared";
import { defineTool, idField } from "../common/define";

const ReconcileSource = z.enum(["SETTLEMENT", "WALLET", "TRANSFER"]);

const investigation = { identified: true, complaint: true } as const;

/** An investigation tool's fences, with the one complaint type its evidence may land on (common/fences.ts). */
const investigates = (type: ComplaintType) => ({ ...investigation, complaintTypes: [type] });

export const INVESTIGATION_TOOLS = {
  read_receipt: defineTool({
    name: "read_receipt",
    description:
      "Reads the receipt image the customer sent for this complaint (network, operation code, amount, date). The image never comes back. A reading is not proof of payment: reconcile it against the settlement with reconcile_payment. UNREADABLE asks for another photo; NOT_A_RECEIPT is not a receipt; INVALID_RECEIPT goes to a person by itself (handedOver): never ask for another photo then.",
    fields: { evidenceId: idField("The RECEIPT_IMAGE evidence of this complaint.") },
    scoped: { evidenceId: "EVIDENCE" },
    fences: investigation,
    untrustedOutput: ["fields.operationCode"],
  }),

  reconcile_payment: defineTool({
    name: "reconcile_payment",
    description:
      "Looks for the payment in the published settlement of the network (SETTLEMENT, with the READ receipt reading of this complaint) or in the wallet or transfer movements (WALLET, TRANSFER, with the movement). MATCHED is the only result that allows apply_payment. PENDING_BATCH: the batch is not published yet and the check runs again by itself. PAYER_MISMATCH goes to a person by itself.",
    fields: {
      readingId: idField("The READ receipt reading of this complaint; required when source is SETTLEMENT.").optional(),
      source: ReconcileSource.optional().describe("Where to look; SETTLEMENT by default."),
      movementId: idField("For WALLET or TRANSFER: the movement of this customer, copied from list_operations.").optional(),
    },
    check: (input, ctx) => {
      const source = input.source ?? "SETTLEMENT";
      if (source === "SETTLEMENT" && input.readingId === undefined) ctx.addIssue({ code: "custom", path: ["readingId"], message: "readingId is required for a SETTLEMENT reconciliation" });
      if (source !== "SETTLEMENT" && input.movementId === undefined) ctx.addIssue({ code: "custom", path: ["movementId"], message: "movementId is required for a WALLET or TRANSFER reconciliation" });
    },
    scoped: { readingId: "EVIDENCE", movementId: "MOVEMENT" },
    fences: investigates("PAYMENT_NOT_REFLECTED"),
  }),

  check_charge: defineTool({
    name: "check_charge",
    description: "Recomputes a charge of the customer against the fee schedule and the terms: CORRECT, WRONG (with the expected amount) or UNDETERMINED. WRONG is what reverse_charge needs, unless the answer carries alreadyReversed: that charge was already returned, with its credit note, and is never reversed again. When the customer does not say which charge it is, call it on every charge of list_operations kind CHARGE instead of asking which one.",
    fields: { chargeId: idField("A charge of this customer, copied from list_operations.") },
    scoped: { chargeId: "CHARGE" },
    fences: investigates("UNRECOGNIZED_CHARGE"),
    untrustedOutput: ["reasonText"],
  }),

  check_duplicate_debit: defineTool({
    name: "check_duplicate_debit",
    description: "Checks whether an instalment of a loan of the customer was debited twice: DUPLICATE (with the debits and the refundable amount) or NOT_DUPLICATE. DUPLICATE is what refund_duplicate_debit needs.",
    fields: {
      loanId: idField("A loan of this customer, copied from get_account.").optional(),
      instalment: z.number().int().positive().max(120).optional().describe("Number of the instalment."),
    },
    scoped: { loanId: "LOAN" },
    fences: investigates("DUPLICATE_DEBIT"),
  }),

  get_transfer_status: defineTool({
    name: "get_transfer_status",
    description: "Status of a transfer of the customer in the transfer network: COMPLETED, PENDING (with the expected date), REJECTED_REVERSED, REJECTED_NOT_REVERSED or UNKNOWN, with its trace.",
    fields: { transferId: idField("A transfer of this customer, copied from list_operations.") },
    scoped: { transferId: "TRANSFER" },
    fences: investigates("TRANSFER_NOT_CREDITED"),
    untrustedOutput: ["rejectReasonText"],
  }),

  get_disbursement: defineTool({
    name: "get_disbursement",
    description: "Status of the disbursement of a loan of the customer: PENDING, CREDITED, FAILED_RETURNED or HELD_REVIEW, with gross, origination fee and net amounts.",
    fields: { loanId: idField("A loan of this customer, copied from get_account; the latest loan by default.").optional() },
    scoped: { loanId: "LOAN" },
    fences: investigates("DISBURSEMENT_NOT_RECEIVED"),
  }),
} as const;
