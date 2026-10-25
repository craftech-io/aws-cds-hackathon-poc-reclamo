// Target `handoff` (`ToolHandoff`, docs/tool-catalog.md): a person takes over. No tool approves anything:
// `request_operator_approval` only asks, the action and the amount come from the code, and `decision`
// exists only so the Cedar forbid CED-NO-SELF-APPROVAL is valid (zod refuses it with any value). The zod
// here is the only source of the Gateway schema of these tools.
import { HandoffReason } from "@reclamo/shared";
import { boundedText, complaintIdField, defineTool, deniedByPolicy, idField } from "../common/define";

export const HANDOFF_TOOLS = {
  escalate_to_human: defineTool({
    name: "escalate_to_human",
    description:
      "Hands the complaint (or the conversation, when there is none) to a person with a summary for the operator; the customer gets the handoff notice from the code. FRAUD raises the priority, sends the safety guidance and alerts a supervisor: it is the reason of every UNKNOWN_OPERATION complaint, called in the same turn as freeze_outgoing without asking the customer first. Use it when the customer asks for a person or you cannot go on. Waiting for the customer's reply (the identity challenge, a receipt, a detail) is not being unable to go on: never call it in the turn you asked the customer something; a second failed identity answer is handed over by the code.",
    fields: {
      complaintId: complaintIdField(),
      reason: HandoffReason.describe("Why a person takes over."),
      summary: boundedText(500, "For the operator, in Spanish, no personal data."),
    },
    scoped: { complaintId: "COMPLAINT" },
  }),

  request_operator_approval: defineTool({
    name: "request_operator_approval",
    description:
      "After an action answered ABOVE_CAP, asks a person to approve it, with the evidence that justifies it. The code fixes the action, the amount and the tier (OPERATOR or SUPERVISOR); the request expires in 2 business days. You never approve: a person does, and the system executes it afterwards.",
    fields: {
      complaintId: complaintIdField(),
      evidenceId: idField("The reconciliation, charge check, duplicate check or transfer evidence that justifies the action."),
      justification: boundedText(500, "Why the action is due, in Spanish."),
      decision: deniedByPolicy("string", "CED-NO-SELF-APPROVAL"),
    },
    scoped: { complaintId: "COMPLAINT", evidenceId: "EVIDENCE" },
    fences: { complaint: true, control: true },
  }),
} as const;
