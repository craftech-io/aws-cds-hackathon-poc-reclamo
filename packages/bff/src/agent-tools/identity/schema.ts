// Target `identity` (`ToolIdentity`, docs/tool-catalog.md): who is writing and the identity challenge.
// The customer comes from the phone the session resolved, never from the input; neither tool ever
// returns the expected answer. The zod here is the only source of the Gateway schema of these tools.
import { boundedText, defineTool } from "../common/define";

export const IDENTITY_TOOLS = {
  identify_customer: defineTool({
    name: "identify_customer",
    description:
      "Says who is writing (the customer linked to this phone) and whether they are identified. If not, it returns the identity challenge to ask, with its text; never the expected answer. LOCKED after two failed challenges: a person takes over.",
    fields: {},
    callers: ["WORKER"],
  }),

  verify_challenge: defineTool({
    name: "verify_challenge",
    description:
      "Checks the customer's answer to the identity challenge. Call it only after the customer replied to the challenge you sent, with their answer exactly as they wrote it: an answer the customer did not write after the challenge, or one already checked, is refused (INVALID) and counts nothing. OK identifies them for 30 minutes; FAILED counts a failed attempt; LOCKED escalates to a person by itself. Never repeat or hint the expected answer.",
    fields: {
      answer: boundedText(40, "The customer's answer as written."),
    },
  }),
} as const;
