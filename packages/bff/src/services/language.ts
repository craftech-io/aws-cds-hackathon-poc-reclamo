// Language check of the outbound verification (ADR-0012): every message to a customer is in
// Spanish. Deterministic and dependency-free: the share of Spanish function words against English
// ones, over the words of the text with amounts, codes, numbers and links removed. A text too
// short to tell (a lone button title, a complaint number) passes as `UNDETERMINED`.
export type LanguageVerdict = "SPANISH" | "NOT_SPANISH" | "UNDETERMINED";

const SPANISH = new Set(
  "a al algo ante aquí así cómo como con cuál cuando de del desde donde dónde el él ella en entre es esa ese eso esta está están este esto fue ha hay hasta la las le les lo los más me mi muy nos o para pero por porque qué que se si sí sin sobre su sus te tenés tiene tu tus un una uno ya y vos usted ustedes gracias hola reclamo cuota pago número días hábiles".split(" "),
);
const ENGLISH = new Set(
  "a about and are as at be been but by can do does for from has have hello her his how i if in is it its my no not of on or our please so that the their there this to was we were what when where which who will with you your thanks complaint payment".split(" "),
);

// Words that are the same in both lists say nothing.
const SHARED = new Set([...SPANISH].filter((word) => ENGLISH.has(word)));

const MIN_SIGNAL_WORDS = 3;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

export function detectLanguage(text: string): LanguageVerdict {
  let spanish = 0;
  let english = 0;
  let accented = 0;
  for (const word of words(text)) {
    if (/[áéíóúñü¿¡]/.test(word)) accented += 1;
    if (SHARED.has(word)) continue;
    if (SPANISH.has(word)) spanish += 1;
    else if (ENGLISH.has(word)) english += 1;
  }
  if (/[¿¡]/.test(text)) accented += 1;
  const spanishSignal = spanish + accented;
  if (spanishSignal + english < MIN_SIGNAL_WORDS) return "UNDETERMINED";
  return spanishSignal > english * 2 ? "SPANISH" : "NOT_SPANISH";
}

/** True unless the text is recognisably not Spanish. */
export function passesSpanishCheck(text: string): boolean {
  return detectLanguage(text) !== "NOT_SPANISH";
}
