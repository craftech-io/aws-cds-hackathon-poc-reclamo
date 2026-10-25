// The other content readers of the policy (docs/design-brief.md §7), next to the collection lexicon:
//
//   credit offers       `CH-NO-CREDIT-OFFER`: new loans, pre-approvals, preferential rates, limit raises
//   sensitive data      `CH-NO-SENSITIVE-ASK`: a text that asks for passwords, PINs, codes, cards, bank
//                       data or documents, or that carries a full card, CBU/CVU or CUIT (the patterns of
//                       lib/mask.ts, the one source of masking patterns)
//   foreign contacts    `CH-NO-FOREIGN-LINKS`: links, domains, emails or phones that are not the stage's;
//                       masked records ("v•••@…", "+54*******0103") never match
//
// Refusals and safety texts negate what they name ("nunca te pedimos tu clave", "no ofrecemos
// créditos"), so the offer and ask patterns are negatable (lexicon-match.ts); a new loan and refinancing
// also read a refusal frame over their clause ("no puedo gestionar la solicitud de un nuevo préstamo").
import { MASK_PATTERNS, type MaskLabel, asciiSpaces, containsCard } from "../lib/mask";
import { type LexiconPattern, REFUSAL_FRAME, gap, matchLexicon, rx, words } from "./lexicon-match";

type OfferCategory = "CREDIT_OFFER";
type AskCategory = "SENSITIVE_ASK";

const LOAN = "(?:prestamos?|creditos?|adelantos?)";

const CREDIT_OFFER: readonly LexiconPattern<OfferCategory>[] = [
  { id: "CO-NEW-LOAN", category: "CREDIT_OFFER", negatable: true, refusal: REFUSAL_FRAME, pattern: rx(words(`(?:nuevo|otro|segundo|adicional|mas) ${LOAN}`, `${LOAN} (?:nuevos?|preaprobados?|pre aprobados?|adicionales?|express|inmediatos?|disponibles?|a tasa)`)) },
  {
    id: "CO-OFFER",
    category: "CREDIT_OFFER",
    negatable: true,
    pattern: rx(words("tasa preferencial", "tasa especial", "tasa promocional", "preaprobad[a-z]*", "pre aprobad[a-z]*", "precalificad[a-z]*", "te ofrecemos", "le ofrecemos", "ofrecerte", "tenemos para vos", "tenemos una oferta", "ofertas?", "promocion(?:es)?", "promo", "beneficio exclusivo", "calificas para", "calificaste para")),
  },
  { id: "CO-LIMIT", category: "CREDIT_OFFER", negatable: true, pattern: rx(words("aument[a-z]*", "ampli[a-z]*", "increment[a-z]*", "eleva[a-z]*", "subimos", "subirte"), gap(2), " ", words("limites?", "cupos?", "linea de credito")) },
  { id: "CO-TAKE-LOAN", category: "CREDIT_OFFER", negatable: true, pattern: rx(words("pedi", "pedir", "solicita", "solicitar", "saca", "sacar", "toma", "tomar", "accede a", "acceder a", "obtene", "obtener"), gap(2), " (?:un|tu|otro|nuevo) ", LOAN, "\\b") },
  { id: "CO-WANT-LOAN", category: "CREDIT_OFFER", negatable: true, pattern: rx(words("queres", "quiere", "te gustaria", "necesitas", "necesita"), " (?:un|otro|mas) (?:prestamo|credito|dinero|plata|efectivo|adelanto)\\b") },
  { id: "CO-REFINANCE", category: "CREDIT_OFFER", negatable: true, refusal: REFUSAL_FRAME, pattern: rx(words("refinanci[a-z]*", "adelanto de (?:sueldo|haberes)")) },
];

const SENSITIVE_NOUNS = [
  "claves?",
  "contrasenas?",
  "password",
  "pin",
  "codigos? de (?:verificacion|seguridad|acceso|ingreso)",
  "codigo que te (?:llego|enviamos|mandamos)",
  "tokens?",
  "numero de (?:tarjeta|cuenta|documento|dni|cuit|cuil)",
  "tarjetas?",
  "cvv",
  "cvc",
  "vencimiento de (?:tu|la) tarjeta",
  "cbu",
  "cvu",
  "datos bancarios",
  "dni",
  "documentos?",
  "cuit",
  "cuil",
  "clave fiscal",
  "selfie",
  "usuario y clave",
];

const ASK_VERBS = [
  "mandame",
  "mandanos",
  "pasame",
  "pasanos",
  "enviame",
  "envianos",
  "ingresa",
  "ingrese",
  "escribime",
  "escribinos",
  "escribi",
  "compartime",
  "compartinos",
  "comparti",
  "confirmame",
  "confirmanos",
  "confirma",
  "indicame",
  "indicanos",
  "indica",
  "decime",
  "decinos",
  "dame",
  "danos",
  "necesito",
  "necesitamos",
  "pedimos",
  "requerimos",
  "precisamos",
  "solicitamos",
  "informanos",
  "informame",
  "brindanos",
  "proporcionanos",
  "carga",
  "cargame",
  "responde con",
];

const SENSITIVE_ASK: readonly LexiconPattern<AskCategory>[] = [{ id: "SA-ASK", category: "SENSITIVE_ASK", negatable: true, pattern: rx(words(...ASK_VERBS), gap(6), " ", words(...SENSITIVE_NOUNS)) }];

/** Kinds of full sensitive number a text may not carry (lib/mask.ts). */
const SHARED_NUMBERS: readonly MaskLabel[] = ["TARJETA", "CBU", "CUIT"];

/** The credit-offer patterns a text trips. */
export function creditOfferFindings(text: string): string[] {
  return matchLexicon(CREDIT_OFFER, text).map((finding) => finding.id);
}

/** What the text asks for or carries: `SA-ASK`, `SHARES-TARJETA`, `SHARES-CBU`, `SHARES-CUIT`. */
export function sensitiveFindings(text: string): string[] {
  const findings = matchLexicon(SENSITIVE_ASK, text).map((finding) => finding.id);
  const spaced = asciiSpaces(text);
  for (const label of SHARED_NUMBERS) {
    const source = MASK_PATTERNS.find(([candidate]) => candidate === label)?.[1];
    if (source === undefined) continue;
    const carried = label === "TARJETA" ? containsCard(spaced) : new RegExp(source.source, source.flags).test(spaced);
    if (carried) findings.push(`SHARES-${label}`);
  }
  return findings;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+/giu;
const TLDS = "com|net|org|io|ar|info|app|me|ly|co|xyz|site|online|link|biz|us|uk|es|br|cl|uy|py|mx|pe|bo|gob|edu|dev|ai|tv|gl|to|cc|page|store|shop|club|top|gg|sh|click|ws|ru|cn|de|fr|it|eu";
const DOMAIN = new RegExp(`(?<![\\p{L}\\p{N}@._-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))(?![\\p{L}\\p{N}_@-]|\\.[\\p{L}\\p{N}])`, "giu");

function emailPattern(): RegExp {
  const source = MASK_PATTERNS.find(([label]) => label === "EMAIL")?.[1];
  if (source === undefined) throw new Error("lib/mask.ts has no EMAIL pattern");
  return new RegExp(source.source, source.flags);
}

function phonePattern(): RegExp {
  const source = MASK_PATTERNS.find(([label]) => label === "TELEFONO")?.[1];
  if (source === undefined) throw new Error("lib/mask.ts has no TELEFONO pattern");
  return new RegExp(source.source, source.flags);
}

function hostOf(url: string): string {
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function inStage(host: string, stageDomains: readonly string[]): boolean {
  const clean = host.replace(/\.$/, "").toLowerCase();
  return stageDomains.some((domain) => clean === domain || clean.endsWith(`.${domain}`));
}

/** Links, domains, emails and phones of the text that are not the stage's: `URL`, `DOMAIN`, `EMAIL`, `PHONE`. */
export function foreignContactFindings(text: string, stageDomains: readonly string[]): string[] {
  const findings = new Set<string>();
  const urls = [...text.matchAll(URL_PATTERN)].map((match) => match[0]);
  if (urls.some((url) => !inStage(hostOf(url), stageDomains))) findings.add("URL");
  const emails = [...text.matchAll(emailPattern())].map((match) => match[0]);
  if (emails.some((email) => !inStage(email.slice(email.lastIndexOf("@") + 1), stageDomains))) findings.add("EMAIL");
  const rest = urls.concat(emails).reduce((acc, item) => acc.split(item).join(" "), text);
  if ([...rest.matchAll(DOMAIN)].some((match) => !inStage(match[1] ?? "", stageDomains))) findings.add("DOMAIN");
  if (phonePattern().test(rest)) findings.add("PHONE");
  return [...findings];
}
