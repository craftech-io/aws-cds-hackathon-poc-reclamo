// Target `messaging` (`ToolMessaging`, docs/tool-catalog.md): the only way the agent writes to the
// customer. The recipient is not a field: it is always the phone of the session (no tool declares one).
// Only the six kinds of CED-WA-KIND-ALLOWLIST exist in the enum, so collection kinds cannot even be named;
// the outbound gate decides the rest. At most one COMPLAINT_UPDATE per event that opened the turn
// (`LAM-ONCE-PER-EVENT`). The zod here is the only source of the Gateway schema of this tool.
import { z } from "zod";
import { WaButtonAction } from "@reclamo/shared";
import { TemplateName } from "../../copy/types";
import { boundedText, defineTool, idField } from "../common/define";

/** The kinds the agent may send by WhatsApp (CED-WA-KIND-ALLOWLIST lists the same six). */
export const AgentWhatsAppKind = z.enum(["REPLY", "IDENTITY_CHALLENGE", "RECEIPT_REQUEST", "COMPLAINT_UPDATE", "RESOLUTION_NOTICE", "OUT_OF_SCOPE_REFUSAL"]);

/** WhatsApp allows three reply buttons per message; "Hablar con alguien" is added by the code. */
export const MAX_BUTTONS = 3;

const Template = z
  .object({
    name: TemplateName.describe("Approved template."),
    params: z
      .array(boundedText(300, "One parameter."))
      .max(5)
      .optional()
      .describe("Values in order, copied from this turn's tool results; for reclamo_novedad {{3}}, a status phrase id from the closed list."),
  })
  .strict();

const Button = z
  .object({
    action: WaButtonAction.describe("What the button does; the code writes its title."),
    ref: idField("The complaint or loan the button is about.").optional(),
  })
  .strict();

export const MESSAGING_TOOLS = {
  send_whatsapp: defineTool({
    name: "send_whatsapp",
    description:
      "Sends a WhatsApp message to the customer of this conversation (always the phone of the session). Free text in Spanish only inside the 24-hour window; outside it, an approved template whose parameters come from this turn's tool results. Never asks for or reminds of a payment owed: the channel policy blocks it. At most one COMPLAINT_UPDATE per event. The answer says the decision: ALLOWED, BLOCKED (with its rules), DEFERRED (it goes out later by itself: never resend it) or REROUTED.",
    fields: {
      kind: AgentWhatsAppKind.describe("Kind of message."),
      text: boundedText(900, "Free text in Rioplatense Spanish, only inside the 24-hour window.").optional(),
      template: Template.optional().describe("Approved template, the only way to write outside the 24-hour window."),
      buttons: z.array(Button).max(MAX_BUTTONS).optional().describe("Reply buttons."),
      complaintId: idField("The complaint the message is about: the id attribute of a <complaint> fact (or a complaintId a tool returned), never its R- number.").optional(),
    },
    check: (input, ctx) => {
      if ((input.text === undefined) === (input.template === undefined)) ctx.addIssue({ code: "custom", path: ["text"], message: "send either text or template, not both and not neither" });
    },
    scoped: { complaintId: "COMPLAINT", "buttons[].ref": "BUTTON_REF" },
    fences: { control: true, oncePerEvent: (input) => (input["kind"] === "COMPLAINT_UPDATE" ? "COMPLAINT_UPDATE" : undefined) },
  }),
} as const;
