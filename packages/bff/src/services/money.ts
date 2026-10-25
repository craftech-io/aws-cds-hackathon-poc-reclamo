// Money of the edge: amounts are integer centavos inside, and every text shows them in es-AR
// (`$ 118.640,00`) without `Intl`, so the output is byte-identical on every runtime. Formatting
// lives in @reclamo/shared; this module adds what the BFF needs on top: reading the amounts a
// text carries (outbound verification compares them with the turn's results) and exact arithmetic.
import { type Money, formatPesos, pesosFromCents } from "@reclamo/shared";
import { FOREIGN_AFTER, FOREIGN_BEFORE, MULTIPLIER_AFTER, PESO_AFTER, PESO_BEFORE, multiplierOf, normalizeFigures } from "./figure-text";

export { formatPesos, pesosFromCents };
export type { Money };

// A number token: digits with dot or comma separators (`3500`, `118.640,00`, `3,5`, `3,500.00`),
// never started or ended inside a longer run of digits and separators.
const NUMBER = /(?<!\d)(?<!\d[.,])\d+(?:[.,]\d+)*/g;
const ES_AR = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?$/;
const EN_US = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;
const CONTEXT = 20;

/** Centavos of one es-AR amount (`"$ 118.640,00"` → 11864000), or `undefined` if it is not one. */
export function parsePesos(text: string): number | undefined {
  const match = /^-?\$?\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?$/.exec(text.trim());
  if (!match || match[1] === undefined) return undefined;
  const cents = Number(match[1].replaceAll(".", "")) * 100 + Number(match[2] ?? "0");
  if (!Number.isSafeInteger(cents)) return undefined;
  return text.trim().startsWith("-") ? -cents : cents;
}

/** Centavos of `whole,fraction × multiplier` pesos, rounded half up; `undefined` out of range. */
function toCents(whole: string, fraction: string, multiplier: bigint): number | undefined {
  const scale = 10n ** BigInt(fraction.length);
  const exact = (BigInt(whole) * scale + BigInt(fraction || "0")) * multiplier * 100n;
  const cents = Number((exact * 2n + scale) / (2n * scale));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

export interface NumberToken {
  /** The token as the normalized text writes it (`3,500.00`; `3 500` becomes `3500`). */
  readonly raw: string;
  /** Its digits without separators (`350000`): what a bare-number check compares. */
  readonly digits: string;
  /** Centavos when the token is an amount in pesos (see `amountsIn`). */
  readonly cents?: number;
  /** An amount that no peso result can ground: another currency, or a shape that does not parse. */
  readonly unverifiable?: true;
}

/**
 * Every number of a text, read on `normalizeFigures(text)`. A token is an amount when a currency
 * sign or word is right before or after it (also `en/de pesos`, after a multiplier), when a
 * multiplier (`mil`, `millón`, `k`, `lucas`, `palos`) follows it, or when it is written with
 * grouping or two decimals. es-AR reading first (`3.500` is three thousand five hundred), the US one
 * (`3,500.00`) only when es-AR cannot read it. An amount in another currency (`USD`, `U$S`, `dólares`)
 * or one that parses neither way is `unverifiable`.
 */
export function numberTokens(input: string): NumberToken[] {
  const text = normalizeFigures(input);
  return [...text.matchAll(NUMBER)].map((match) => {
    const raw = match[0];
    const before = text.slice(Math.max(0, match.index - CONTEXT), match.index);
    const after = text.slice(match.index + raw.length, match.index + raw.length + CONTEXT);
    const multiplierMatch = MULTIPLIER_AFTER.exec(after);
    const rest = multiplierMatch ? after.slice(multiplierMatch[0].length) : after;
    const foreign = FOREIGN_BEFORE.test(before) || FOREIGN_AFTER.test(rest);
    const esAr = ES_AR.exec(raw);
    const enUs = esAr ? null : EN_US.exec(raw);
    const whole = (esAr?.[1] ?? enUs?.[1])?.replaceAll(/[.,]/g, "");
    const fraction = esAr?.[2] ?? enUs?.[2] ?? "";
    const grouped = /\d[.,]\d{3}(?!\d)/.test(raw) && fraction.length !== 3;
    const currency = foreign || PESO_BEFORE.test(before) || PESO_AFTER.test(rest);
    const amount = currency || multiplierMatch !== null || grouped || fraction.length === 2;
    const digits = raw.replaceAll(/[.,]/g, "");
    if (!amount) return { raw, digits };
    const cents = whole === undefined || foreign ? undefined : toCents(whole, fraction, multiplierOf(multiplierMatch?.[1]));
    return cents === undefined ? { raw, digits, unverifiable: true } : { raw, digits, cents };
  });
}

/** Every amount a text shows (see `numberTokens`), in centavos. */
export function amountsIn(text: string): number[] {
  return numberTokens(text).flatMap((token) => (token.cents === undefined ? [] : [token.cents]));
}

/** Exact sum of centavos; a sum that leaves the safe range fails instead of rounding. */
export function sumCents(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount)) throw new RangeError(`not an integer number of centavos: ${amount}`);
    total += amount;
    if (!Number.isSafeInteger(total)) throw new RangeError("sum of centavos out of range");
  }
  return total;
}
