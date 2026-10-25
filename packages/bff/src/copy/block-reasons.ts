// Why the outbound gate stopped, deferred or rerouted a message, in the words the console shows on
// the compliance tape and in the policy view (docs/design-brief.md §7). Staff-facing: these texts
// name the forbidden things (collection, credit offers) and never reach a customer. Every rule is
// "nuestra lectura, no asesoramiento legal" (STAFF_TEXT.NOT_LEGAL_ADVICE goes next to it).
import type { ErrorCode, Reroute, TapeEntryKind } from "@reclamo/shared";
import { BLOCK_SOURCE_GLOSS, GATE_FAILURE_GLOSS, TAPE_DECISION_GLOSS } from "./en-gloss";
import type { BlockSource, CollectionCategory, Glossed } from "./types";

export interface BlockReason {
  /** One line for the red banner of the tape. */
  readonly short: string;
  /** What the rule says, for the rule panel and the policy view. */
  readonly detail: string;
}

export const BLOCK_SOURCE_REASON: Readonly<Record<BlockSource, BlockReason>> = {
  "CH-SENDER": { short: "Emisor no autorizado", detail: "El emisor no tiene una sesión válida, un rol vigente en el mundo ni un tipo de mensaje determinista." },
  "CH-CONTROL": { short: "Conversación tomada por una persona", detail: "Con la conversación en manos de una persona el agente no envía; el operador escribe solo con la conversación tomada." },
  "CH-KIND-CHANNEL": { short: "Tipo de mensaje no permitido en este canal", detail: "Cada tipo de mensaje tiene su canal: la respuesta escrita y los certificados van solo por email." },
  "CH-WA-NO-COLLECTION": { short: "Política comercial de WhatsApp (cobro de deudas)", detail: "Por WhatsApp no sale ningún mensaje de cobranza, lo mande quien lo mande. Camino permitido: la cola humana o el aviso formal por email." },
  "CH-WA-NO-PAYMENT-REQUEST": { short: "Pedido de pago por WhatsApp", detail: "Por WhatsApp no sale ningún pedido de pago, link ni instrumento de pago." },
  "CH-NO-CREDIT-OFFER": { short: "Oferta de crédito", detail: "Ningún canal lleva ofertas de crédito, refinanciación ni aumentos." },
  "CH-RECIPIENT-FENCE": { short: "Destinatario fuera del cerco", detail: "Email solo al simulador de buzones de SES o, desde el mundo demo, a destinatarios de demo registrados; WhatsApp vivo solo a teléfonos de demo." },
  "CH-OPTIN": { short: "Sin opt-in de WhatsApp", detail: "Un WhatsApp iniciado por el prestamista requiere un opt-in vigente." },
  "CH-OPTOUT": { short: "El cliente pidió no recibir mensajes", detail: "Con un opt-out vigente solo sale la confirmación del opt-out." },
  "CH-WA-CUSTOMER-INITIATED": { short: "Sin reclamo abierto del cliente", detail: "Un WhatsApp proactivo solo puede ser una novedad de un reclamo abierto que inició el cliente." },
  "CH-WA-24H": { short: "Fuera de la ventana de 24 horas", detail: "Fuera de la ventana solo salen plantillas aprobadas, con parámetros de la lista cerrada." },
  "CH-CONTACT-HOURS": { short: "Fuera del horario de contacto", detail: "Proactivos de lunes a viernes de 8 a 20 y sábados de 9 a 13, sin domingos ni feriados (supuesto); el aviso formal de deuda, de lunes a viernes de 9 a 18." },
  "CH-MAX-PER-DAY": { short: "Tope de contactos del día", detail: "Hasta 3 contactos proactivos por cliente por día (supuesto); el aviso formal de deuda, uno cada 7 días." },
  "CH-NO-SENSITIVE-ASK": { short: "Pedido de datos sensibles", detail: "Ningún mensaje pide claves, PIN, códigos, tarjetas, datos bancarios ni documentos." },
  "CH-NO-FOREIGN-LINKS": { short: "Enlace o contacto ajeno", detail: "Ningún mensaje lleva enlaces, dominios, emails o teléfonos que no sean del stage." },
  "CH-FORMAL-CONTENT": { short: "Contenido formal incompleto", detail: "La respuesta escrita lleva número, tipo, fecha, resolución y el derecho a acudir al BCRA; el aviso formal de deuda, la identificación del acreedor y el detalle del core." },
  G2: { short: "Guardrail de salida", detail: "El guardrail de salida (G2) denegó el texto: un tema prohibido, o sin fundamento en los resultados del turno." },
  VERIFY: { short: "Verificación determinista", detail: "Un monto, una fecha, un número o un código del texto no está en los resultados del turno." },
};

/** Tool error codes the gate returns, as the console explains them. */
export const GATE_FAILURE_CODES = ["TEMPLATE_REQUIRED", "TEMPLATE_PARAM_NOT_ALLOWED", "GROUNDING_FAIL", "POLICY_DENIED", "RECIPIENT_NOT_ALLOWED", "UNKNOWN_DELIVERY"] as const satisfies readonly ErrorCode[];
export type GateFailureCode = (typeof GATE_FAILURE_CODES)[number];

export const GATE_FAILURE_REASON: Readonly<Record<GateFailureCode, string>> = {
  TEMPLATE_REQUIRED: "Fuera de la ventana hace falta una plantilla aprobada",
  TEMPLATE_PARAM_NOT_ALLOWED: "Parámetro de plantilla fuera de la lista cerrada",
  GROUNDING_FAIL: "Texto sin fundamento en los resultados del turno",
  POLICY_DENIED: "Tema denegado por el guardrail de salida",
  RECIPIENT_NOT_ALLOWED: "Destinatario no permitido por el cerco",
  UNKNOWN_DELIVERY: "Entrega incierta: la revisa una persona, nunca se reenvía a ciegas",
};

/** Categories of the collection lexicon as the tape lists them (FL-067). */
export const COLLECTION_CATEGORY_LABEL: Readonly<Record<CollectionCategory, string>> = {
  PAYMENT_EXHORTATION: "Exhortación de pago",
  CONSEQUENCE_THREAT: "Amenaza de consecuencias",
  DEBT_REMINDER: "Recordatorio de deuda",
  PAYMENT_INSTRUMENT: "Instrumento de pago",
  NEGOTIATION: "Negociación de deuda",
};

export const TAPE_DECISION_LABEL: Readonly<Record<TapeEntryKind, string>> = {
  ALLOWED: "PERMITIDO",
  BLOCKED: "BLOQUEADO",
  REROUTED: "REENCAMINADO",
  DEFERRED: "DIFERIDO",
  DISPATCH: "ENVÍO",
};

/** The allowed paths the console offers under a block (FL-064). */
export const REROUTE_LABEL: Readonly<Record<Reroute, string>> = {
  HUMAN_QUEUE: "Derivar a la cola humana",
  FORMAL_EMAIL: "Enviar aviso formal por email",
};

/**
 * The line of a tape entry: "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION · Política comercial de
 * WhatsApp (cobro de deudas)", with its English gloss.
 */
export function tapeBanner(decision: TapeEntryKind, source?: BlockSource): Glossed {
  const es = [TAPE_DECISION_LABEL[decision], TAPE_DECISION_GLOSS[decision]];
  const en = [TAPE_DECISION_GLOSS[decision]];
  if (source) {
    es.push(source, BLOCK_SOURCE_REASON[source].short);
    en.push(source, BLOCK_SOURCE_GLOSS[source].short);
  }
  return { es: es.join(" · "), en: en.join(" · ") };
}

export function gateFailureGloss(code: GateFailureCode): Glossed {
  return { es: GATE_FAILURE_REASON[code], en: GATE_FAILURE_GLOSS[code] };
}
