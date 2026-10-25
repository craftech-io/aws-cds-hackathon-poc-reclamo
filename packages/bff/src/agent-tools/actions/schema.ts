// Target `actions` (`ToolActions`, docs/tool-catalog.md): effects on the simulated core. Every tool needs
// the customer identified, an open complaint of the session and the conversation in the agent's hands
// (`LAM-IDENTIFIED`, `LAM-COMPLAINT-REQUIRED`, `LAM-CONTROL`). The four money tools take only the evidence
// that justifies them: the amount comes from the evidence and the core, never from the model, and
// `capOverride` exists only so the Cedar forbid CED-NO-CAP-OVERRIDE is valid (zod refuses it with any
// value). The zod here is the only source of the Gateway schema of these tools.
import { z } from "zod";
import { DataChangeField } from "../../copy/types";
import { defineTool, deniedByPolicy, idField } from "../common/define";

const action = { identified: true, complaint: true, control: true } as const;

const capOverride = () => deniedByPolicy("string", "CED-NO-CAP-OVERRIDE");

const FreezeReason = z.enum(["UNKNOWN_OPERATION", "CUSTOMER_REQUEST"]);

const MONEY_NOTE = "Above the cap it answers ABOVE_CAP and does nothing: then ask for approval with request_operator_approval. CONFLICT means it was already done (the existing actionId comes back).";

export const ACTIONS_TOOLS = {
  apply_payment: defineTool({
    name: "apply_payment",
    description: `Applies a payment the settlement proved (a MATCHED reconciliation of this complaint) to the customer's instalments; the amount and the allocation come from the core. ${MONEY_NOTE}`,
    fields: {
      reconciliationId: idField("The MATCHED reconciliation of this complaint."),
      capOverride: capOverride(),
    },
    scoped: { reconciliationId: "EVIDENCE" },
    fences: action,
  }),

  reverse_charge: defineTool({
    name: "reverse_charge",
    description: `Reverses a charge a check of this complaint found WRONG, with compensatory interest, and issues a credit note; a charge already reversed answers ALREADY_REVERSED and moves nothing. ${MONEY_NOTE}`,
    fields: {
      chargeCheckId: idField("The WRONG charge check of this complaint."),
      capOverride: capOverride(),
    },
    scoped: { chargeCheckId: "EVIDENCE" },
    fences: action,
  }),

  refund_duplicate_debit: defineTool({
    name: "refund_duplicate_debit",
    description: `Refunds a debit a check of this complaint found DUPLICATE and issues a credit note. ${MONEY_NOTE}`,
    fields: {
      duplicateCheckId: idField("The DUPLICATE debit check of this complaint."),
      capOverride: capOverride(),
    },
    scoped: { duplicateCheckId: "EVIDENCE" },
    fences: action,
  }),

  request_transfer_reversal: defineTool({
    name: "request_transfer_reversal",
    description: `Asks the transfer network to reverse a transfer this complaint found REJECTED_NOT_REVERSED and credits the wallet. ${MONEY_NOTE}`,
    fields: {
      transferEvidenceId: idField("The TRANSFER_STATUS evidence of this complaint with REJECTED_NOT_REVERSED."),
      capOverride: capOverride(),
    },
    scoped: { transferEvidenceId: "EVIDENCE" },
    fences: action,
  }),

  freeze_outgoing: defineTool({
    name: "freeze_outgoing",
    description: "Freezes outgoing wallet movements to protect the customer, only in an UNKNOWN_OPERATION complaint: call it as soon as the session is identified, without asking the customer anything, and in the same turn call escalate_to_human with reason FRAUD. No tool lifts it: a person does.",
    fields: { reason: FreezeReason.describe("Why the wallet is frozen.") },
    fences: action,
  }),

  request_account_closure: defineTool({
    name: "request_account_closure",
    description:
      "Starts the closure of the customer's account once they tapped the closure confirmation button (the turn's facts show inbound button=\"CONFIRM_CLOSURE\"): call it in that turn with no other field; answers the conditions of the closure. Before the tap, send a REPLY with a CONFIRM_CLOSURE button instead.",
    fields: { confirmNonce: idField("Leave it out: the code takes the button the customer tapped in this turn.").optional() },
    scoped: { confirmNonce: "NONCE" },
    fences: action,
    untrustedOutput: ["conditionsText"],
  }),

  request_data_change: defineTool({
    name: "request_data_change",
    description:
      "Requests a change of the customer's email or address with the new value the customer wrote (the code extracts it from their message of this turn or, when that one has none, from their earlier messages of the complaint; an answer to the identity challenge is never a new value; never write it yourself, never pass it). NO_NEW_VALUE: no message has it yet, ask the customer to write it and call it in the turn of their reply. A change of the field already pending comes back alreadyRequested. PHONE: call it at once with field PHONE, without asking for the new number: a phone is never changed by chat and a person takes it (REFERRED). An account under review also goes to a person.",
    fields: {
      field: DataChangeField.describe("Which data the customer wants to change."),
      sourceMessageId: idField("Leave it out: the code takes the customer's message of this turn. Only to name an earlier inbound message that holds the new value.").optional(),
    },
    scoped: { sourceMessageId: "MESSAGE" },
    fences: action,
  }),
} as const;
