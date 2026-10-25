// The closed list of status phrases that fill `{{3}}` of the `reclamo_novedad` template
// (docs/architecture-integrations.md §3.3). `{{3}}` is never free text: the agent passes a phrase
// id, the code renders the phrase, and the gate refuses anything else with
// `TEMPLATE_PARAM_NOT_ALLOWED`. A free parameter outside the window is what Meta rejects or
// recategorises most. The seed loads this list into `Reference/TemplateStatusPhrase`.
//
// Each phrase reads after "hay una novedad en tu reclamo R-…:" and before ". Podés responder por
// acá.": lower case first, no final punctuation, one line, about the complaint and never about a
// payment the customer owes.
import { z } from "zod";

export const STATUS_PHRASE_IDS = [
  "SETTLEMENT_PUBLISHED",
  "PAYMENT_REFLECTED",
  "TRANSFER_CREDITED",
  "TRANSFER_REVERSED",
  "DISBURSEMENT_CREDITED",
  "REFUND_CREDITED",
  "CHARGE_REVERSED",
  "NETWORK_PENDING",
  "APPROVAL_PENDING",
  "HUMAN_REVIEWED",
  "ANSWER_SENT",
] as const;

export const StatusPhraseId = z.enum(STATUS_PHRASE_IDS);
export type StatusPhraseId = z.infer<typeof StatusPhraseId>;

export const TEMPLATE_STATUS_PHRASES: Readonly<Record<StatusPhraseId, string>> = {
  SETTLEMENT_PUBLISHED: "ya tenemos la rendición de la red",
  PAYMENT_REFLECTED: "tu pago ya se refleja en tu cuenta",
  TRANSFER_CREDITED: "la transferencia ya figura acreditada",
  TRANSFER_REVERSED: "la transferencia rechazada ya volvió a tu billetera",
  DISBURSEMENT_CREDITED: "el desembolso ya figura acreditado en tu billetera",
  REFUND_CREDITED: "el reintegro ya figura acreditado en tu billetera",
  CHARGE_REVERSED: "revertimos el cargo que reclamaste",
  NETWORK_PENDING: "seguimos esperando la confirmación de la red",
  APPROVAL_PENDING: "la acción espera la aprobación de una persona",
  HUMAN_REVIEWED: "una persona revisó tu caso",
  ANSWER_SENT: "te mandamos la respuesta escrita por email",
};

/** The phrase of an id; `undefined` for anything outside the closed list. */
export function statusPhrase(id: string): string | undefined {
  const parsed = StatusPhraseId.safeParse(id);
  return parsed.success ? TEMPLATE_STATUS_PHRASES[parsed.data] : undefined;
}
