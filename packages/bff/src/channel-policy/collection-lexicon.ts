// The collection lexicon (docs/design-brief.md §7): what `CH-WA-NO-COLLECTION` and
// `CH-WA-NO-PAYMENT-REQUEST` read in every WhatsApp text, from any sender, templates included. Five
// categories:
//
//   PAYMENT_EXHORTATION  "pagá", "aboná", "regularizá", "cancelá tu deuda", "tenés que pagar"
//   CONSEQUENCE_THREAT   "evitá recargos", "informaremos", "acciones legales", "si no pagás…"
//   DEBT_REMINDER        a proactive reminder of a debt or an overdue instalment
//   PAYMENT_INSTRUMENT   a payment request, link, CVU/alias or code to pay
//   NEGOTIATION          payment plans, debt reductions, refinancing
//
// Service stays out: "tu cuota ya no figura atrasada", "tu saldo pendiente es $ X", "tu préstamo
// tiene 3 cuotas pendientes", "tu pago ya se refleja" pass (negations, neutral balances, past
// payments). Calibrated against the single labelled corpus of the seed
// (scripts/seed/data/evals/collection-corpus.json, WP-14): 0 false negatives, at most 5 % false
// positives. A change of a pattern bumps `COLLECTION_LEXICON_VERSION` (it lands on every tape entry).
// The patterns read the folded text of lexicon-match.ts (no accents, lower case, clauses split).
import type { CollectionCategory } from "../copy/types";
import { type LexiconFinding, type LexiconPattern, REFUSAL_FRAME, categoriesOf, gap, matchLexicon, rx, words } from "./lexicon-match";

export const COLLECTION_LEXICON_VERSION = "lex-2026.10.20.1";

type Entry = LexiconPattern<CollectionCategory>;

const PAY_IMPERATIVE = ["paga", "abona", "regulariza", "cancela", "salda", "deposita", "pague", "abone", "regularice", "cancele", "salde", "deposite", "paguen", "abonen", "regularicen", "cancelen", "salden"];
const PAY_SUBJUNCTIVE = ["pagues", "abones", "regularices", "canceles", "saldes", "deposites", "transfieras"];
const PAY_INFINITIVE = ["pagar", "abonar", "cancelar", "regularizar", "saldar", "depositar"];
const DEBT_NOUNS = ["cuotas?", "(?<!libre )deudas?", "saldos?", "vencimientos?", "vencid[ao]s?", "impag[ao]s?", "atrasad[ao]s?", "mora", "adeud[a-z]*", "atrasos?"];
/** Words that, right before an imperative-looking form, make it a third-person statement ("el pago cancela la cuota"). */
const NOT_IMPERATIVE_AFTER = ["pago", "pagos", "red", "transferencia", "debito", "que", "se", "cliente", "importe", "monto", "operacion", "imputacion", "eso", "ese", "esto", "este", "cual", "quien", "lo", "le", "te", "nos", "les", "sistema", "jarilla", "billetera"];
/** Temporal subjunctives ("cuando canceles el préstamo", "cuando lo cancelés") describe, they do not exhort. */
const TEMPORAL = ["cuando", "una vez que", "apenas", "hasta que", "en cuanto", "despues de que", "luego de que"];
/** The one object pronoun a temporal subjunctive may carry before its verb ("una vez que lo canceles"). */
const CLITIC = ["lo", "la", "los", "las", "le", "les", "te", "me", "nos"];

/**
 * The contractual right to pay a loan off early, as a clause states it ("podés cancelar tu préstamo en
 * forma total o parcial en cualquier momento", "se puede pagar el préstamo antes de su vencimiento"): an
 * answer to "¿puedo cancelar…?", never a way to pay nor a deadline to pay by.
 */
const EARLY_PAYOFF_RIGHT = "(?:prestamo|credito) (?:en forma (?:total|parcial|anticipada)|de forma anticipada|anticipadamente|total o parcial(?:mente)?|en cualquier momento|antes del?(?: su| tu)? (?:vencimiento|plazo|tiempo))";
/** The loan itself followed by that right, right after a pay verb ("pagar el préstamo antes de su vencimiento"). */
const EARLY_PAYOFF_OBJECT = `(?! (?:el|tu|su) ${EARLY_PAYOFF_RIGHT})`;
/**
 * The impersonal form a clause is written in ("las cuotas se pueden pagar en…"): it describes the terms,
 * as "las cuotas se pagan en…" does; "podés pagar…" invites the customer to pay.
 */
const NOT_IMPERSONAL = "(?<!\\bse )";

const EXHORTATION: readonly Entry[] = [
  { id: "EX-IMPERATIVE", category: "PAYMENT_EXHORTATION", pattern: rx(`(?<!\\b(?:${NOT_IMPERATIVE_AFTER.join("|")}) )\\b(?:${PAY_IMPERATIVE.join("|")})(?:la|lo|las|los|le|te)?\\b`) },
  { id: "EX-SUBJUNCTIVE", category: "PAYMENT_EXHORTATION", pattern: rx(`(?<!\\b(?:${TEMPORAL.join("|")})(?: (?:${CLITIC.join("|")}))? )`, words(...PAY_SUBJUNCTIVE)) },
  {
    id: "EX-HAVE-TO",
    category: "PAYMENT_EXHORTATION",
    negatable: true,
    pattern: rx(words("tenes", "tienes", "tiene", "debes", "debe", "deberias", "deberia", "deberas", "debera", "necesitas", "necesita", "hay", "tendras", "tendra", "tenga", "tengas"), `(?: que)? (?:${PAY_INFINITIVE.join("|")}|transferir|ponerte al dia|ponerse al dia)\\b`),
  },
  { id: "EX-DONT-FORGET", category: "PAYMENT_EXHORTATION", pattern: rx(words("no te olvides", "no se olvide", "no olvides", "no olvide", "acordate", "recorda", "recuerde", "recordarte"), `(?: de| que)? (?:${PAY_INFINITIVE.join("|")})\\b`) },
  {
    id: "EX-URGENCY",
    category: "PAYMENT_EXHORTATION",
    pattern: rx(`(?<!\\bpara )`, words("pagar", "abonar", "regularizar", "saldar", "cancelar", "pagando", "abonando", "regularizando", "cancelando", "saldando"), EARLY_PAYOFF_OBJECT, gap(3), " ", words("hoy", "ya", "ahora", "cuanto antes", "a la brevedad", "inmediatamente", "de inmediato", "lo antes posible", "urgente", "sin demora", "antes del?")),
  },
  { id: "EX-CATCH-UP", category: "PAYMENT_EXHORTATION", pattern: rx(words("ponete", "ponerte", "pongase", "ponerse", "pongas", "quedate"), " al dia\\b") },
  { id: "EX-REGULARIZE", category: "PAYMENT_EXHORTATION", pattern: rx(words("regularizar", "regulariza", "regularice", "regularices", "normalizar", "normaliza", "normalice"), " (?:tu|su|la|el) (?:situacion|deuda|cuenta|saldo|mora|cuota|cuotas|atraso)\\b") },
  { id: "EX-MAKE-PAYMENT", category: "PAYMENT_EXHORTATION", pattern: rx(words("realiza", "realice", "realizar", "efectua", "efectue", "efectuar", "hace", "haga", "hacer"), "(?:lo)? (?:el|la|tu|su|un|una) (?:pago|abono|deposito|transferencia)\\b") },
  { id: "EX-AWAIT-PAYMENT", category: "PAYMENT_EXHORTATION", pattern: rx(words("esperamos", "aguardamos", "quedamos a la espera de", "esperando"), " (?:tu|su) (?:pago|abono|regularizacion|transferencia|deposito)\\b") },
  { id: "EX-WE-ASK", category: "PAYMENT_EXHORTATION", pattern: rx(words("te", "le", "les"), " ", words("pedimos", "solicitamos", "rogamos", "instamos", "exigimos", "requerimos", "intimamos"), `(?: que)? (?:${[...PAY_SUBJUNCTIVE, ...PAY_INFINITIVE, "pague", "abone", "regularice", "cancele", "el pago"].join("|")})\\b`) },
  { id: "EX-DEBT-OBJECT", category: "PAYMENT_EXHORTATION", pattern: rx(words(...PAY_INFINITIVE), " (?:tu|su|la|el total de tu|el total de la) deuda\\b") },
];

const THREAT: readonly Entry[] = [
  {
    id: "TH-AVOID",
    category: "CONSEQUENCE_THREAT",
    pattern: rx(words("evita", "evite", "eviten", "evitar", "evitaras", "evitas", "evitando"), gap(2), " ", words("recargos?", "intereses", "punitorios?", "multas?", "acciones", "consecuencias", "embargos?", "sanciones", "gastos", "mora", "bloqueos?", "suspension", "que tu deuda", "que la deuda", "mayores")),
  },
  {
    id: "TH-REPORT",
    category: "CONSEQUENCE_THREAT",
    pattern: rx(words("informaremos", "reportaremos", "vamos a informar", "vamos a reportar", "seras informad[oa]", "seras reportad[oa]", "sera informad[oa]", "daremos aviso", "notificaremos"), gap(6), " ", words("centrales?", "deudor(?:es)?", "riesgo", "bureau", "organismos?", "registros?", "tu situacion", "su situacion", "la mora", "tu mora", "incumplimiento", "tu deuda", "su deuda", "la deuda", "morosidad", "moros[oa]s?")),
  },
  { id: "TH-DEBTOR-LISTS", category: "CONSEQUENCE_THREAT", pattern: rx(words("centrales? de (?:deudores|riesgo)", "bases? de (?:deudores|morosos)", "registros? de (?:deudores|morosos)", "listas? de (?:deudores|morosos)", "moros[oa]s?", "morosidad")) },
  {
    id: "TH-LEGAL",
    category: "CONSEQUENCE_THREAT",
    pattern: rx(words("acciones legales", "accion legal", "acciones judiciales", "accion judicial", "via judicial", "gestion judicial", "reclamo judicial", "demanda judicial", "cobro judicial", "instancia judicial", "juicio", "embargos?", "embargar", "embargaremos", "intimacion", "intimamos", "intimarte", "carta documento", "estudio juridico")),
  },
  {
    id: "TH-IF-NOT",
    category: "CONSEQUENCE_THREAT",
    pattern: rx(words("si no", "en caso de no", "de no"), " ", words("pagas", "abonas", "regularizas", "cancelas", "saldas", "pagues", "abones", "regularices", "canceles", "pagar", "abonar", "regularizar", "cancelar", "saldar", "te pones al dia", "se pone al dia", "realizas el pago", "haces el pago", "efectuas el pago", "realiza el pago")),
  },
  {
    id: "TH-WILL-ACCRUE",
    category: "CONSEQUENCE_THREAT",
    pattern: rx(words("se generaran", "se sumaran", "se aplicaran", "se cobraran", "se devengaran", "se acumularan", "generara", "generaran", "sumara", "sumaran", "aplicaremos", "cobraremos", "tendras", "vas a tener", "te cobraremos", "devengara", "devengaran", "seguiran? (?:sumando|generando|aumentando|creciendo)"), gap(3), " ", words("recargos?", "intereses", "punitorios?", "multas?", "cargos? por mora", "gastos de cobranza", "costos")),
  },
  { id: "TH-SUSPEND", category: "CONSEQUENCE_THREAT", pattern: rx(words("suspenderemos", "bloquearemos", "inhabilitaremos", "vamos a (?:suspender|bloquear|inhabilitar)", "perderas", "podrias perder", "vas a perder")) },
  { id: "TH-LAST-NOTICE", category: "CONSEQUENCE_THREAT", pattern: rx(words("ultimo aviso", "aviso final", "ultima notificacion", "ultima oportunidad", "ultimo recordatorio")) },
  { id: "TH-CONSEQUENCES", category: "CONSEQUENCE_THREAT", pattern: rx(words("consecuencias")) },
  { id: "TH-BEFORE-LATE", category: "CONSEQUENCE_THREAT", pattern: rx(words("antes de que (?:sea tarde|tomemos|iniciemos|se generen|aumente|crezca|pasemos)")) },
  { id: "TH-COLLECTION-AGENCY", category: "CONSEQUENCE_THREAT", pattern: rx(words("(?:gestion|agencia|area|departamento|estudio|empresa|gestor|gestores) de cobranzas?", "cobranza (?:judicial|extrajudicial)", "(?:derivaremos|pasaremos|transferiremos|enviaremos) (?:tu|su|la) (?:deuda|cuenta|caso) (?:a|al) (?:cobranzas?|legales|un estudio|una agencia|recupero)")) },
];

const REMINDER: readonly Entry[] = [
  { id: "DR-WE-REMIND", category: "DEBT_REMINDER", negatable: true, pattern: rx(words("te recordamos", "le recordamos", "les recordamos", "te recuerdo", "queremos recordarte", "recordarte"), gap(8), " ", words(...DEBT_NOUNS)) },
  { id: "DR-REMEMBER", category: "DEBT_REMINDER", negatable: true, pattern: rx(words("recorda", "recuerde", "recordas", "acordate", "acuerdese"), gap(6), " ", words(...DEBT_NOUNS)) },
  { id: "DR-DONT-FORGET", category: "DEBT_REMINDER", pattern: rx(words("no te olvides", "no se olvide", "no olvides", "no olvide", "que no se te pase", "no se te pase", "no dejes pasar"), gap(6), " ", words(...DEBT_NOUNS)) },
  {
    id: "DR-OVERDUE-STATE",
    category: "DEBT_REMINDER",
    negatable: true,
    pattern: rx(words("cuotas?", "deudas?", "saldos?", "pagos?", "prestamos?", "importes?", "montos?", "obligacion(?:es)?", "cuenta"), gap(4), " ", words("vencid[ao]s?", "impag[ao]s?", "atrasad[ao]s?", "en mora", "en atraso", "adeudad[ao]s?", "sin pagar", "sin abonar", "sin cancelar", "pendientes? de pago", "pendientes? de cancelacion", "moros[ao]s?")),
  },
  {
    id: "DR-YOU-OWE",
    category: "DEBT_REMINDER",
    negatable: true,
    pattern: rx(words("tenes", "tiene", "tienes", "registras", "registra", "mantenes", "mantiene", "posees", "posee", "acumulas", "acumula", "figuras con", "figura con"), gap(3), " ", words("(?<!libre )deudas?", "cuotas? (?:vencidas?|impagas?|atrasadas?)", "saldos? (?:vencidos?|impagos?|deudores?|adeudados?)", "atrasos?", "mora", "montos? adeudados?")),
  },
  { id: "DR-OWE-AMOUNT", category: "DEBT_REMINDER", negatable: true, pattern: rx(words("adeudas", "adeuda", "adeudan", "debes", "debe", "debemos recibir"), " (?:\\$|\\d|la |las |el |los |una |un |tu |su |cuotas?|dinero|plata|pesos)") },
  { id: "DR-IN-ARREARS", category: "DEBT_REMINDER", negatable: true, pattern: rx(words("estas", "esta", "estan", "seguis", "sigue", "siguen", "continuas", "continua", "quedaste", "quedo", "figuras", "figura", "te encontras", "se encuentra"), gap(2), " ", words("en mora", "en atraso", "atrasad[ao]s?", "moros[ao]s?", "en situacion irregular", "vencid[ao]s?")) },
  { id: "DR-DUE-NOW", category: "DEBT_REMINDER", negatable: true, pattern: rx(words("vence hoy", "vence manana", "vencio ayer", "vencio hoy", "ya vencio", "ya vencieron", "esta por vencer", "estan por vencer", "proxima a vencer", "vencida desde", "dias de atraso", "dias de mora", "dias vencida")) },
  { id: "DR-STILL-OWE", category: "DEBT_REMINDER", negatable: true, pattern: rx(words("seguis", "sigue", "siguen", "estas", "esta", "estan", "quedaste", "quedo", "quedaron"), " debiendo\\b") },
  { id: "DR-STILL-UNPAID", category: "DEBT_REMINDER", pattern: rx(words("cuotas?", "deudas?", "saldos?", "prestamos?", "importes?"), gap(3), " ", words("sigue", "siguen", "esta", "estan", "quedo", "quedaron", "continua", "continuan", "permanece"), " sin ", words("pagar", "abonar", "cancelar", "regularizar", "pago")) },
  { id: "DR-NOT-PAID", category: "DEBT_REMINDER", pattern: rx(words("no recibimos", "no registramos", "no nos llego", "no vimos", "no pagaste", "no abonaste", "no cancelaste", "no regularizaste"), gap(4), " ", words("cuotas?", "deudas?", "saldos? (?:vencidos?|adeudados?)", "vencimientos?")) },
  // Only the word right before negates it ("sin tu deuda", "ni tu deuda"): "no queremos que tu deuda…" is a threat.
  { id: "DR-YOUR-DEBT", category: "DEBT_REMINDER", negatable: true, lookback: 1, pattern: rx(words("tu deuda", "su deuda", "tus deudas", "sus deudas")) },
  { id: "DR-NOTICE", category: "DEBT_REMINDER", pattern: rx(words("(?:recordatorio|aviso) de (?:pago|vencimiento|deuda|mora|cuota)")) },
  { id: "DR-OWED-BALANCE", category: "DEBT_REMINDER", negatable: true, pattern: rx(words("saldos?", "montos?", "importes?", "total"), " ", words("adeudados?", "deudor", "vencidos?", "impagos?", "en mora", "a regularizar")) },
];


const INSTRUMENT: readonly Entry[] = [
  {
    id: "PI-LINK",
    category: "PAYMENT_INSTRUMENT",
    pattern: rx(words("link", "enlace", "boton", "codigo", "cupon", "qr", "alias", "cvu", "cbu", "numero de cuenta", "cuenta bancaria", "datos bancarios"), gap(2), " ", words("de pago", "para (?:pagar|abonar|transferir|depositar|cancelar|regularizar)", "de cobro", "de cobranzas?")),
  },
  {
    id: "PI-YOU-CAN-PAY",
    category: "PAYMENT_INSTRUMENT",
    pattern: rx(NOT_IMPERSONAL, words("podes", "puedes", "puede", "pueden", "podra", "podras", "te invitamos a", "te sugerimos", "te recomendamos", "recomendamos", "sugerimos"), gap(2), " ", words(`pagar${EARLY_PAYOFF_OBJECT}`, "abonar", `cancelar (?:tu|la)(?! ${EARLY_PAYOFF_RIGHT})`, "cancelar (?:el saldo|tu deuda|la deuda|lo adeudado)", "regularizar", "saldar")),
  },
  {
    id: "PI-PAY-VIA",
    category: "PAYMENT_INSTRUMENT",
    pattern: rx(words("paga", "pague", "pagar", "abona", "abone", "abonar", "pagalo", "pagala", "abonalo", "abonala", "transferi", "transfiera", "transferir", "deposita", "deposite", "depositar"), gap(4), " ", words("en", "con", "desde", "al", "a la", "por", "mediante", "a traves de", "via", "a este", "a esta", "a nuestro", "a nuestra"), " ", words("cvu", "cbu", "alias", "link", "enlace", "qr", "codigo", "cuenta", "caja", "sucursal", "punto de pago", "red de cobro", "la app", "nuestra app", "homebanking", "home banking", "billetera", "tarjeta", "efectivo", "este", "esta")),
  },
  { id: "PI-SEND-TO", category: "PAYMENT_INSTRUMENT", pattern: rx(words("transferi", "transfiera", "transferinos", "deposita", "deposite", "depositanos", "envianos", "enviame"), " (?:a|al|a la|en) ", words("cvu", "cbu", "alias", "cuenta", "nuestra", "nuestro", "este", "esta")) },
  { id: "PI-NUMBER", category: "PAYMENT_INSTRUMENT", pattern: rx(words("cvu", "cbu", "alias"), gap(3), " \\d{6,}") },
  { id: "PI-GO-AND-PAY", category: "PAYMENT_INSTRUMENT", pattern: rx(words("ingresa", "ingrese", "entra", "entre", "accede", "acceda", "hace click", "haga click", "toca", "toque", "escanea", "escanee"), gap(5), " ", words("para", "y"), " ", words("pagar", "abonar", "regularizar", "cancelar", "saldar")) },
  { id: "PI-PAY-LINK", category: "PAYMENT_INSTRUMENT", pattern: rx(words("pago", "pagar", "abonar", "paga"), gap(3), " ", words("https?", "www")) },
];

// Refusals name what they refuse ("no ofrecemos refinanciaciones ni planes de pago"): negatable, and a
// plan or a refinancing also reads the refusal frame of its clause ("refinanciar está fuera de lo que puedo hacer").
const NEGOTIATION: readonly Entry[] = [
  { id: "NG-PLAN", category: "NEGOTIATION", negatable: true, refusal: REFUSAL_FRAME, pattern: rx(words("plan(?:es)? de (?:pagos?|cuotas|financiacion|regularizacion|refinanciacion|facilidades)", "facilidades de pago")) },
  { id: "NG-REFINANCE", category: "NEGOTIATION", negatable: true, refusal: REFUSAL_FRAME, pattern: rx(words("refinanci[a-z]*", "reestructur[a-z]*", "reprogram[a-z]* (?:tu|la|su) deuda")) },
  { id: "NG-REDUCTION", category: "NEGOTIATION", negatable: true, pattern: rx(words("(?:una|la|tu|su|con|de|del) quitas?", "quitas? (?:del?|sobre|en|de hasta|especial|de intereses|de capital|\\d+)")) },
  { id: "NG-FORGIVE", category: "NEGOTIATION", negatable: true, pattern: rx(words("condona[a-z]*", "condonar", "perdonamos", "perdonaremos", "perdonar (?:tu|la|su) deuda")) },
  { id: "NG-AGREEMENT", category: "NEGOTIATION", negatable: true, pattern: rx(words("acuerdos?", "convenios?", "arreglos?", "propuestas?", "alternativas?"), " (?:de|para) ", words("pagos?", "pagar", "regularizacion", "regularizar", "cancelacion de (?:tu|la) deuda", "tu deuda", "la deuda", "refinanciacion", "saldar")) },
  { id: "NG-DISCOUNT", category: "NEGOTIATION", negatable: true, pattern: rx(words("descuento", "bonificacion", "rebaja", "reduccion", "bonificamos", "bonificaremos", "descontamos", "descontaremos"), gap(3), " ", words("si", "por", "para", "al"), " ", words("pagas", "pagar", "abonas", "abonar", "cancelas", "cancelar", "regularizas", "regularizar", "saldas", "saldar", "pago", "pagos", "pagando")) },
  { id: "NG-WAIVE", category: "NEGOTIATION", negatable: true, pattern: rx(words("bonificamos", "bonificaremos", "descontamos", "descontaremos", "reducimos", "reduciremos", "congelamos", "congelaremos"), gap(2), " ", words("intereses", "punitorios?", "recargos?", "deuda", "mora")) },
  { id: "NG-NEGOTIATE", category: "NEGOTIATION", negatable: true, pattern: rx(words("negociar", "negociemos", "negociacion", "financiar (?:tu|la) deuda", "financiamos (?:tu|la) deuda", "(?:tu|la|su) deuda en (?:\\d+ )?cuotas", "arreglar (?:tu|su|la) deuda", "arreglemos (?:tu|su|la) deuda", "solucionar (?:tu|su|la) deuda", "financiacion de (?:tu |su |la )?deudas?", "opciones de (?:financiacion|refinanciacion)")) },
  { id: "NG-FOR-DEBTORS", category: "NEGOTIATION", negatable: true, pattern: rx(words("para (?:deudores|morosos|clientes (?:en mora|con deuda|atrasados|morosos))")) },
  { id: "NG-PARTIAL", category: "NEGOTIATION", negatable: true, pattern: rx(words("aceptamos", "admitimos", "ofrecemos", "tomamos", "podes hacer", "podes realizar"), gap(1), " ", words("pagos? parcial(?:es)?", "pagos? a cuenta", "entregas? parcial(?:es)?")) },
  { id: "NG-STOP-ARREARS", category: "NEGOTIATION", negatable: true, pattern: rx(words("(?:frenar|detener|parar|cortar|congelar) (?:la|tu|su) (?:mora|deuda)")) },
];

/** The lexicon, category by category. */
export const COLLECTION_LEXICON: readonly Entry[] = [...EXHORTATION, ...THREAT, ...REMINDER, ...INSTRUMENT, ...NEGOTIATION];

export interface CollectionFindings {
  readonly version: string;
  readonly categories: readonly CollectionCategory[];
  readonly findings: readonly LexiconFinding<CollectionCategory>[];
}

/** The collection categories a text trips (empty for a service text). */
export function classifyCollection(text: string): CollectionFindings {
  const findings = matchLexicon(COLLECTION_LEXICON, text);
  return { version: COLLECTION_LEXICON_VERSION, categories: categoriesOf(findings), findings };
}

/** Whether the lexicon reads the text as collection (any category). */
export function isCollection(text: string): boolean {
  return classifyCollection(text).categories.length > 0;
}
