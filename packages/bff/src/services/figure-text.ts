// How a reader sees the figures of a text. The outbound verification compares figures, never the
// raw characters: a model (or a prompt injection) can write an amount with fullwidth or other
// non-ASCII digits, hide a zero-width character inside it, split its thousands with a space or an
// apostrophe, name another currency or spell it out in words. This module folds all of that into
// what `numberTokens` (money.ts) reads, and finds the amounts written in words.

// Zero-width and other format characters (U+200B, U+2060, U+FEFF, U+00AD...): invisible to the reader.
const FORMAT = /\p{Cf}/gu;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;
// Space-like characters, apostrophes, primes, underscores and middle dots between a digit and a
// group of exactly three digits: `3 500`, `3'500`, `3_500`, `3·500` all read as 3500.
const GROUP_SEPARATOR = /(?<=\d)[\t    '‘’ʼ′_·‧∙٬]+(?=\d{3}(?!\d))/gu;

/** ASCII value of a decimal digit of any script: its offset inside its run of ten digits. */
function asciiDigit(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  let start = code;
  while (code - start < 100 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((code - start) % 10);
}

/**
 * The text with its figures as a reader sees them: NFKC (fullwidth digits and letters, NBSP and thin
 * spaces), no format characters, ASCII digits for every script, and thousands groups joined.
 */
export function normalizeFigures(text: string): string {
  return text.normalize("NFKC").replace(FORMAT, "").replace(NON_ASCII_DIGIT, asciiDigit).replace(GROUP_SEPARATOR, "");
}

const LETTER = "a-záéíóúüñ";
/** Currencies other than the peso: an amount in one of them can never be grounded on a peso result. */
const FOREIGN_CODE = String.raw`u\$[sd]|us\$|usd|eur|€|r\$`;
const FOREIGN_WORD = "d[oó]lar(?:es)?|euros?|reales?|verdes";
const FOREIGN = `${FOREIGN_CODE}|${FOREIGN_WORD}`;
const PESO_WORD = "ars|pesos?|mangos?";
// `en/de` joins a number to a currency word (`999 en pesos`), never to a sign (`cuota 4 de $ 500`).
const CONNECTOR = String.raw`(?:(?:en|de)\s+)?`;

export const FOREIGN_BEFORE = new RegExp(String.raw`(?:(?<![${LETTER}])(?:${FOREIGN}))\s*$`, "iu");
export const FOREIGN_AFTER = new RegExp(String.raw`^\s*(?:${FOREIGN_CODE}|${CONNECTOR}(?:${FOREIGN_WORD}))(?![${LETTER}])`, "iu");
export const PESO_BEFORE = new RegExp(String.raw`(?:\$|(?<![${LETTER}])(?:${PESO_WORD}))\s*$`, "iu");
export const PESO_AFTER = new RegExp(String.raw`^\s*(?:\$|${CONNECTOR}(?:${PESO_WORD})(?![${LETTER}]))`, "iu");
/** A multiplier right after a number: `mil`, `millón`, `millones`, `k`, `luca(s)`, `palo(s)`. */
export const MULTIPLIER_AFTER = new RegExp(String.raw`^\s*(mil(?:lones|l[oó]n)?|k|lucas?|palos?)(?![${LETTER}])`, "iu");

/** Pesos a multiplier word stands for. */
export function multiplierOf(word: string | undefined): bigint {
  if (word === undefined) return 1n;
  return /^(?:mil|k|lucas?)$/i.test(word) ? 1_000n : 1_000_000n;
}

const NUMERAL = [
  "cero", "un[oa]?", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
  "diez", "once", "doce", "trece", "catorce", "quince", `dieci[${LETTER}]+`,
  "veinte", `veinti[${LETTER}]+`, "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa",
  "cien", "ciento", "(?:dos|tres|cuatro|seis|ocho)cient[oa]s", "quinient[oa]s", "setecient[oa]s", "novecient[oa]s",
  "medio", "mil", "mill[oó]n", "millones",
].join("|");
const PHRASE = String.raw`(?:${NUMERAL})(?:\s+(?:y\s+)?(?:${NUMERAL}))*`;
// A sign or a code followed by digits names the currency of that written amount (`uno de $ 47.000,00`
// is a pronoun and a figure), never of the words before it.
const CURRENCY_WORD = String.raw`(?:${PESO_WORD}|lucas?|palos?|centavos?|${FOREIGN_WORD}|(?:${FOREIGN_CODE}|\$)(?!\s*\d))`;
const CURRENCY_SIGN = String.raw`(?:ars|usd|u\$[sd]|us\$|\$|€)`;
const SPELLED = new RegExp(
  String.raw`(?<![${LETTER}])(?:(?:${PHRASE})\s*(?:(?:de|en)\s+)?${CURRENCY_WORD}|${CURRENCY_SIGN}\s*(?:${PHRASE}))(?![${LETTER}])`,
  "giu",
);
// "ni un peso": a single article before the unit is not a figure anyone reads as a refund.
const ONE_UNIT = /^un[oa]?\s+(?:peso|centavo|mango)$/iu;

/** Amounts written in words next to a currency (`mil quinientos pesos`, `un millón de pesos`, `tres lucas`). */
export function spelledAmounts(text: string): string[] {
  return [...normalizeFigures(text).matchAll(SPELLED)].map((match) => match[0]).filter((raw) => !ONE_UNIT.test(raw.trim()));
}
