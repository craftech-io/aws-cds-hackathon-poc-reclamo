// Fixed texts of the eight PDF documents (docs/architecture-integrations.md §8). pdf/ lays them
// out; the facts, amounts and dates come from the core and the register, never from here. Every
// string is WinAnsi-encodable as written (copy.test.ts checks it), so pdf/winansi.ts never has to
// degrade one: ñ, á, ¿, ¡, •, · and — are fine; ≤, → and emojis are not.
import type { Channel } from "@reclamo/shared";
import { EMAIL_TEXT } from "./es-AR";
import type { DocKind } from "./types";

type Texts = Readonly<Record<string, string>>;

/** Letterhead, footer and field names every document shares. */
export const PDF_COMMON = {
  LETTERHEAD: "Jarilla — préstamos y billetera (prestamista ficticio)",
  BRAND: "Reclamo en regla · Powered by Craftech",
  SYNTHETIC_LEGEND: "Documento de demostración con datos sintéticos",
  PRODUCER: "reclamo-en-regla",
  COMPLAINT_NUMBER: "Número de reclamo",
  ISSUED_AT: "Fecha de emisión",
  FILED_AT: "Fecha de presentación",
  COMPLAINT_TYPE: "Tipo",
  CHANNEL: "Canal",
  CUSTOMER: "Cliente",
  DOCUMENT: "Documento",
  SIGNATURE: "Servicio de atención al usuario de Jarilla (ficticio)",
  BCRA_RIGHT: EMAIL_TEXT.FOOTER_BCRA,
  CREDITOR_IDENTIFICATION: "Jarilla — préstamos y billetera (prestamista ficticio) · CUIT {{cuit}} (sintético) · {{address}}",
  PAGE: "Página {{page}} de {{pages}}",
} as const satisfies Texts;

export const PDF_CHANNEL_LABEL: Readonly<Record<Channel, string>> = { WHATSAPP: "WhatsApp", EMAIL: "Email" };

/** Status of an instalment in the account statement. */
export const PDF_INSTALMENT_STATUS: Readonly<Record<"DUE" | "PAID" | "PARTIALLY_PAID" | "OVERDUE", string>> = {
  DUE: "A vencer",
  PAID: "Pagada",
  PARTIALLY_PAID: "Pagada en parte",
  OVERDUE: "Vencida",
};

/** Title (also the `Title` metadata), `Subject` metadata and the labels of each document. */
export const PDF_DOC = {
  ACK: {
    TITLE: "Acuse de recibo",
    SUBJECT: "Acuse de recibo del reclamo {{complaintNumber}}",
    DEADLINE: "Plazo de respuesta",
    DEADLINE_VALUE: "{{deadlineText}} (10 días hábiles)",
    NEXT_STEPS_TITLE: "Cómo seguir",
    NEXT_STEPS: "Te vamos a responder por escrito, por email, a más tardar en la fecha del plazo. Mientras tanto podés escribirnos por WhatsApp o pedir hablar con una persona.",
    REGISTER_HASH: "Hash de la entrada del registro (FILED)",
  },
  ANSWER: {
    TITLE: "Respuesta escrita",
    SUBJECT: "Respuesta escrita del reclamo {{complaintNumber}}",
    FACTS: "Hechos",
    RESOLUTION: "Resolución",
    OUTCOME: "Resultado",
    ACTIONS: "Acciones e importes",
    NO_ACTIONS: "Sin acciones sobre la cuenta.",
    ATTACHMENTS: "Adjuntos",
    REGISTER_HASHES: "Hashes del registro (FILED y FINAL_ANSWER)",
  },
  PAYOFF_CERTIFICATE: {
    TITLE: "Certificado de libre deuda",
    SUBJECT: "Libre deuda del préstamo {{loanLabel}}",
    LOAN: "Préstamo",
    PRINCIPAL: "Capital",
    CANCELLED_AT: "Fecha de cancelación",
    STATEMENT: "No registra deuda por este préstamo.",
  },
  CREDIT_NOTE: {
    TITLE: "Nota de crédito",
    SUBJECT: "Nota de crédito {{creditNoteId}}",
    CONCEPT: "Concepto",
    AMOUNT: "Importe",
    COMPENSATORY_INTEREST: "Interés compensatorio",
    RATE: "Tasa de referencia sintética: {{rate}} nominal anual (supuesto)",
    TOTAL: "Total acreditado",
    CREDITED_AT: "Fecha de acreditación",
  },
  STATEMENT: {
    TITLE: "Estado de cuenta del préstamo",
    SUBJECT: "Estado de cuenta del préstamo {{loanLabel}}",
    INSTALMENT: "Cuota",
    DUE_DATE: "Vencimiento",
    AMOUNT: "Importe",
    PAID: "Pagado",
    OUTSTANDING: "Saldo",
    STATUS: "Estado",
    PAYMENTS: "Pagos imputados",
    APPLIED_AT: "Fecha de imputación",
    LOAN_OUTSTANDING: "Saldo del préstamo",
  },
  CLOSURE: {
    TITLE: "Constancia de pedido de baja",
    SUBJECT: "Pedido de baja {{complaintNumber}}",
    REQUESTED_AT: "Fecha del pedido",
    ACCOUNT_STATUS: "Estado de la cuenta",
    CLOSING: "Baja en curso",
    CONDITIONS: "Condiciones",
  },
  DATA_CHANGE: {
    TITLE: "Constancia de pedido de cambio de datos",
    SUBJECT: "Cambio de datos {{complaintNumber}}",
    FIELD: "Dato",
    REQUESTED_AT: "Fecha del pedido",
    STATUS: "Estado",
    PENDING_CONFIRMATION: "Pendiente de confirmación",
    REFERRED: "Derivado a una persona",
  },
  COLLECTION_NOTICE: {
    TITLE: "Aviso formal de deuda",
    SUBJECT: "Aviso formal de deuda del préstamo {{loanLabel}}",
    CREDITOR: "Acreedor",
    LOAN: "Préstamo",
    OVERDUE_INSTALMENTS: "Cuotas vencidas",
    DUE_DATE: "Vencimiento",
    AMOUNT: "Importe",
    TOTAL: "Total al {{dateText}}",
    SERVICE_CHANNELS: "Canales de atención: el WhatsApp de Jarilla (ficticio) o la atención por una persona.",
    RIGHTS: EMAIL_TEXT.COLLECTION_NOTICE_RIGHTS,
  },
} as const satisfies Readonly<Record<DocKind, Texts>>;
