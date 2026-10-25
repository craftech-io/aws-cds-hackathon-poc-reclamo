// What `send_whatsapp` refuses while the customer is not identified (`IDENTIFY_FIRST`, docs/tool-catalog.md):
//
//   - the identity challenge inside any other kind: the challenge is its own message of kind
//     `IDENTITY_CHALLENGE`; `verify_challenge` only checks an answer to one, so a challenge asked inside a
//     REPLY leaves the customer answering a question nobody can check → `CHALLENGE_OUTSIDE_ITS_KIND`;
//   - the account closure button: the closure is offered to an identified customer who asked for it, never
//     as the answer to a question about how closure works → `NOT_IDENTIFIED`.
//
// Identification is read as the identified fence reads it (`isIdentified`, common/fences.ts).
import { ToolError, type WaButtonAction } from "@reclamo/shared";
import { normalizeFigures } from "../../services/figure-text";

/** The questions of the three challenges (copy/es-AR.ts `CHALLENGE_*`), however the model words them. */
const ASKS_CHALLENGE = /(?:fecha\s+de\s+vencimiento|importe|monto)\s+del?\s+(?:tu\s+)?[uú]ltim[oa]\s+(?:cuota|movimiento)/iu;

const NEEDS_IDENTIFICATION: ReadonlySet<WaButtonAction> = new Set(["CONFIRM_CLOSURE"]);

/** Refuses, before the gate, what an unidentified session may not send. */
export function checkBeforeIdentification(message: { readonly kind: string; readonly text?: string | undefined; readonly buttons?: readonly { readonly action: WaButtonAction }[] | undefined }): void {
  if (message.kind !== "IDENTITY_CHALLENGE" && message.text !== undefined && ASKS_CHALLENGE.test(normalizeFigures(message.text))) {
    throw new ToolError("INVALID", "the identity challenge goes alone: send its promptText with kind IDENTITY_CHALLENGE, without other text or buttons, and answer the rest after the customer is identified", "CHALLENGE_OUTSIDE_ITS_KIND");
  }
  const early = (message.buttons ?? []).find((button) => NEEDS_IDENTIFICATION.has(button.action));
  if (early !== undefined) {
    throw new ToolError("NOT_IDENTIFIED", `${early.action} is offered only to an identified customer who asked for it; a question about how it works is answered from get_terms`, "BUTTON_BEFORE_IDENTIFICATION");
  }
}
