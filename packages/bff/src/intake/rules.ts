// Step 1 of the intake classifier (docs/architecture-integrations.md §10, ADR-0015, ADR-0016): the
// deterministic rules that run before any model, in this order:
//
//   button        a resolved button that needs a decision (`CONFIRM_CLOSURE` registers the closure;
//                 the rest open a turn with the button's meaning)
//   human         "hablar con una persona" / "con alguien" (FL-060): a person, without a turn
//   small talk    a greeting, "ok" or "gracias" alone: a turn, never the model (FL-001, ALWAYS_ANSWER)
//   complaint     the patterns of each `ComplaintType` (FL-010): every complaint script of
//                 copy/persona-scripts.ts is resolved here, so the number on the spot never depends
//                 on the model in a scenario
//   open          a short message about an open complaint of the customer (FL-013, "¿y mi pago?"):
//                 the existing number, never a new one
//   consulta      questions about the account answered in the act (FL-008)
//
// The text arrives normalized and masked (channels/normalizer.ts); the rules fold it (case, accents,
// punctuation) and only look at it. Nothing here reads a store or calls a service.
import type { ComplaintType, WaButtonAction } from "@reclamo/shared";
import { foldKeyword } from "../channels/whatsapp/opt-out";

/** What a rule decides; the classifier adds the source and the confidence. */
export type RuleDecision =
  | { readonly kind: "RECLAMO"; readonly type: ComplaintType; readonly rule: string }
  | { readonly kind: "CONSULTA" | "UNCLEAR"; readonly rule: string; readonly complaintId?: string }
  | { readonly kind: "HUMAN"; readonly rule: string; readonly complaintId?: string }
  | { readonly kind: "FOLLOW_UP"; readonly rule: string; readonly complaintId: string; readonly type: ComplaintType; readonly repeatAck: boolean };

/** An open complaint of the customer, as the rules see it. */
export interface OpenComplaintRef {
  readonly complaintId: string;
  readonly type: ComplaintType;
  /** Newest first is the caller's order. */
  readonly filedAtSim: string;
}

export interface RuleInput {
  /** The normalized, masked text (may be empty for an image without caption). */
  readonly text: string;
  readonly hasImage: boolean;
  readonly button?: { readonly action: WaButtonAction; readonly complaintId?: string; readonly loanId?: string };
  /** The customer's open complaints, newest first. */
  readonly openComplaints: readonly OpenComplaintRef[];
}

interface TypePattern {
  readonly type: ComplaintType;
  readonly rule: string;
  readonly pattern: RegExp;
}

// Folded text: lower case, no accents, no punctuation, single spaces ("Pagué la cuota" → "pague la cuota").
// Order matters: a more specific type goes before a broader one that could also match.
export const COMPLAINT_PATTERNS: readonly TypePattern[] = [
  { type: "DUPLICATE_DEBIT", rule: "DEBITED_TWICE", pattern: /\b(debitaron|debito|descontaron)\b.*\b(dos veces|doble|duplicad[oa])\b|\bdos debitos\b|\bdebito (doble|duplicado)\b/ },
  { type: "UNRECOGNIZED_CHARGE", rule: "CHARGED", pattern: /\bme (cobraron|cobran|estan cobrando|cobro)\b|\b(cargo|cobro|comision|seguro) que no (reconozco|pedi|contrate|corresponde)\b/ },
  { type: "UNKNOWN_OPERATION", rule: "NOT_MINE", pattern: /\b(que|la|lo|el) yo no (hice|realice|autorice|reconozco)\b|\bno (la|lo) hice yo\b|\b(operacion|movimiento|transferencia|compra) que no (hice|realice|autorice|reconozco)\b/ },
  { type: "PAYOFF_CERTIFICATE", rule: "PAYOFF", pattern: /\blibre deuda\b|\bcertificado de (cancelacion|libre)\b/ },
  { type: "CLOSURE_OR_EARLY_PAYOFF", rule: "CLOSURE", pattern: /\b(dar|darme|doy|dame) de baja (la|mi) cuenta\b|\b(cerrar|cancelar) (la|mi) cuenta\b|\bcancelar (todo )?(el|mi) prestamo\b|\bcancelacion anticipada\b|\bprecancelar\b/ },
  { type: "ACCOUNT_BLOCKED", rule: "BLOCKED", pattern: /\b(bloquearon|suspendieron|inhabilitaron) (la|mi) cuenta\b|\bcuenta (bloqueada|suspendida|inhabilitada)\b|\bno puedo (entrar|ingresar)\b/ },
  { type: "DATA_CHANGE", rule: "DATA_CHANGE", pattern: /\b(cambie|cambiar|actualizar|modificar|corregir) (de |el |la |mi |mis )?(domicilio|direccion|email|mail|correo|telefono|numero|celular|datos)\b/ },
  { type: "DISBURSEMENT_NOT_RECEIVED", rule: "DISBURSEMENT", pattern: /\b(aprobaron|otorgaron|dieron) (el|mi) prestamo\b.*\b(no|nunca|todavia)\b|\bdesembolso\b/ },
  {
    type: "TRANSFER_NOT_CREDITED",
    rule: "TRANSFER",
    pattern: /\btransferencia\b.*\b(no (me |les |le )?(llego|acredit\w*)|todavia no|rechaz\w*|no volvio)\b|\brechazaron una transferencia\b|\b(mande|envie|transferi)\b.*\bno (les |le |me )?llego\b|\bme (mandaron|transfirieron|enviaron) (plata|dinero)\b.*\bno (la |lo )?(veo|llego|aparece)\b/,
  },
  {
    type: "PAYMENT_NOT_REFLECTED",
    rule: "PAID_NOT_REFLECTED",
    pattern: /\bpague\b.*\b(no (se )?(refleja|reflejan|figura|impacta|impacto|acredito|aparece)|sigue (figurando|apareciendo) (atrasad\w*|impag\w*|vencid\w*|pendiente)|sigue impaga)\b|\b(el|mi) pago no (se )?(refleja|impacto|aparece|figura)\b/,
  },
];

const HUMAN = /\b(hablar|comunicarme|atienda|atiende|atender|pasame|pasar|derivame)\b.*\b(una persona|alguien|un humano|un operador|un asesor|persona real)\b/;

const SMALL_TALK: ReadonlySet<string> = new Set(
  ["hola", "holaa", "buenas", "buen dia", "buenos dias", "buenas tardes", "buenas noches", "hola buenas", "hola buen dia", "ok", "okey", "oka", "dale", "listo", "perfecto", "genial", "gracias", "muchas gracias", "mil gracias", "ok gracias", "hola como estas", "como estas"].map(foldKeyword),
);

const CONSULTA = /\bcuanto me falta\b|\bcuando vence\b|\b(fechas?|dia|dias) de vencimiento\b|\bmi saldo\b|\bcuanto debo\b|\bdetalle de (todos )?(los|mis) pagos\b|\bproxima cuota\b/;

/** A status question about a complaint already filed: "¿y mi pago?", "¿novedades?", "¿qué pasó con mi reclamo?". */
const STATUS_QUESTION = /^(y )?(mi|el|la) (pago|reclamo|transferencia|cargo|debito|libre deuda|prestamo|plata)\b|\bnovedad(es)?\b|\bque paso con\b|\bcomo va\b|\ben que (anda|esta)\b/;

/** Words that point an open-complaint message at one complaint type. */
const TOPIC_OF: readonly (readonly [RegExp, readonly ComplaintType[]])[] = [
  [/\bpag(o|ue)\b|\bcuota\b|\bcomprobante\b/, ["PAYMENT_NOT_REFLECTED"]],
  [/\btransferencia\b/, ["TRANSFER_NOT_CREDITED", "UNKNOWN_OPERATION"]],
  [/\bcargo\b|\bcobro\b|\bcomision\b/, ["UNRECOGNIZED_CHARGE"]],
  [/\bdebito\b/, ["DUPLICATE_DEBIT"]],
  [/\blibre deuda\b/, ["PAYOFF_CERTIFICATE"]],
  [/\bprestamo\b|\bplata\b/, ["DISBURSEMENT_NOT_RECEIVED", "CLOSURE_OR_EARLY_PAYOFF"]],
  [/\bcuenta\b|\bdesbloque\w*\b/, ["ACCOUNT_BLOCKED", "UNKNOWN_OPERATION", "CLOSURE_OR_EARLY_PAYOFF"]],
];

/** A follow-up is short: longer texts are new presentations and go to the patterns or the model. */
export const FOLLOW_UP_MAX_WORDS = 8;

/** The complaint type the folded text describes, by the first pattern that matches. */
export function complaintTypeOf(folded: string): TypePattern | undefined {
  return COMPLAINT_PATTERNS.find((candidate) => candidate.pattern.test(folded));
}

function wordsOf(folded: string): number {
  return folded === "" ? 0 : folded.split(" ").length;
}

/** The open complaint a follow-up is about: the one of the topic it names, or the newest. */
function openComplaintFor(folded: string, open: readonly OpenComplaintRef[]): OpenComplaintRef | undefined {
  for (const [pattern, types] of TOPIC_OF) {
    if (!pattern.test(folded)) continue;
    const match = open.find((complaint) => types.includes(complaint.type));
    if (match !== undefined) return match;
  }
  return open[0];
}

function buttonRule(button: NonNullable<RuleInput["button"]>): RuleDecision {
  if (button.action === "CONFIRM_CLOSURE") return { kind: "RECLAMO", type: "CLOSURE_OR_EARLY_PAYOFF", rule: "BUTTON_CONFIRM_CLOSURE" };
  return { kind: "UNCLEAR", rule: `BUTTON_${button.action}`, ...(button.complaintId === undefined ? {} : { complaintId: button.complaintId }) };
}

/** The deterministic decision of a message, or `undefined` when only the model can tell. */
export function applyRules(input: RuleInput): RuleDecision | undefined {
  if (input.button !== undefined) return buttonRule(input.button);
  const folded = foldKeyword(input.text);
  const newest = input.openComplaints[0];
  if (HUMAN.test(folded)) return { kind: "HUMAN", rule: "TALK_TO_HUMAN", ...(newest === undefined ? {} : { complaintId: newest.complaintId }) };
  if (SMALL_TALK.has(folded)) return { kind: "UNCLEAR", rule: "SMALL_TALK" };
  const typed = complaintTypeOf(folded);
  const short = wordsOf(folded) <= FOLLOW_UP_MAX_WORDS;
  if (typed !== undefined) {
    // A short message that names the type of an open complaint is that complaint, not a new one.
    const sameType = input.openComplaints.find((complaint) => complaint.type === typed.type);
    if (sameType !== undefined && short) return { kind: "FOLLOW_UP", rule: "OPEN_COMPLAINT", complaintId: sameType.complaintId, type: sameType.type, repeatAck: true };
    return { kind: "RECLAMO", type: typed.type, rule: typed.rule };
  }
  if (newest !== undefined && (short || folded === "")) {
    const target = openComplaintFor(folded, input.openComplaints) ?? newest;
    return { kind: "FOLLOW_UP", rule: "OPEN_COMPLAINT", complaintId: target.complaintId, type: target.type, repeatAck: STATUS_QUESTION.test(folded) };
  }
  if (CONSULTA.test(folded)) return { kind: "CONSULTA", rule: "ACCOUNT_QUESTION" };
  if (folded === "" && input.hasImage) return { kind: "UNCLEAR", rule: "IMAGE_ONLY" };
  return undefined;
}
