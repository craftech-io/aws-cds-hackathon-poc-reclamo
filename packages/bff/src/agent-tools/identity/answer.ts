// Where an answer to the identity challenge may come from (CLAUDE.md, "Identidad fuera del modelo"):
// only from what the customer wrote. The model relays an answer; this module finds the fragment of the
// customer's own text that states it, and that fragment (never the model's string) is what the core
// compares. Pure: no clock, no network, no store.
//
//   LAST_DUE_DATE           a date the customer wrote: `5/10`, `05/10`, `5-10-26`, `05.10.2026`,
//                           `2026-10-05`, `5 de octubre`; day and month must be the answer's, and a year
//                           in the answer must be the customer's too (the model never adds one)
//   LAST_INSTALMENT_AMOUNT  an amount the customer wrote (es-AR: `.` thousands, `,` decimals): the same
//   LAST_MOVEMENT_AMOUNT    pesos, and the same centavos when the answer carries them
//
// An answer with no date or amount in it ("no me acuerdo") counts only when it is a whole message of the
// customer, word for word (folded case, accents and spaces).
import type { ChallengeKind } from "@reclamo/core-contract";

/** The core's limit on an answer (`verify_challenge.answer`). */
export const MAX_ANSWER_CHARS = 40;

interface DateMention {
  readonly raw: string;
  readonly day: number;
  readonly month: number;
  readonly year?: number;
}

interface AmountMention {
  readonly raw: string;
  readonly cents: number;
  readonly withCents: boolean;
}

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;

function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function collapsed(text: string): string {
  return folded(text).replace(/[\s.,;:!?¡¿]+/gu, " ").trim();
}

/** A month written in full or cut to three or four letters (`oct`, `sept`); `set`/`setiembre` too. */
function monthOf(word: string): number | undefined {
  if (word === "set" || word === "setiembre") return 9;
  const index = MONTH_NAMES.findIndex((name) => word === name || (word.length >= 3 && word.length <= 4 && name.startsWith(word)));
  return index < 0 ? undefined : index + 1;
}

function yearOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}

function dateMention(raw: string, day: number, month: number, year: number | undefined): DateMention | undefined {
  if (!Number.isInteger(day) || !Number.isInteger(month) || day < 1 || day > 31 || month < 1 || month > 12) return undefined;
  return year === undefined ? { raw: raw.trim(), day, month } : { raw: raw.trim(), day, month, year };
}

const ISO_DATE = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/gu;
const NUMERIC_DATE = /(?<![\d/.-])(\d{1,2}) ?([/.-]) ?(\d{1,2})(?: ?\2 ?(\d{4}|\d{2}))?(?![\d/])/gu;
const WORDED_DATE = /(?<!\d)(\d{1,2}) ?(?:de )?(\p{L}+)\.?(?: (?:de |del )?(\d{4}))?(?!\d)/gu;

/** Every date a text states, in the order they appear. */
export function datesIn(text: string): DateMention[] {
  const source = folded(text).replace(/\s+/gu, " ");
  const found: Array<DateMention & { readonly at: number }> = [];
  const taken: Array<readonly [number, number]> = [];
  const free = (start: number, end: number) => taken.every(([from, to]) => end <= from || start >= to);
  const keep = (match: RegExpMatchArray, mention: DateMention | undefined) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (mention === undefined || !free(start, end)) return;
    taken.push([start, end]);
    found.push({ ...mention, at: start });
  };
  for (const match of source.matchAll(ISO_DATE)) keep(match, dateMention(match[0], Number(match[3]), Number(match[2]), Number(match[1])));
  for (const match of source.matchAll(NUMERIC_DATE)) keep(match, dateMention(match[0], Number(match[1]), Number(match[3]), yearOf(match[4])));
  for (const match of source.matchAll(WORDED_DATE)) {
    const month = monthOf(match[2] ?? "");
    if (month !== undefined) keep(match, dateMention(match[0], Number(match[1]), month, yearOf(match[3])));
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...mention }) => mention);
}

/** Pesos as es-AR writes them: a last `,` or `.` followed by one or two digits starts the centavos. */
function amountMention(raw: string): AmountMention | undefined {
  const digits = raw.replace(/[\s$]/gu, "");
  const last = Math.max(digits.lastIndexOf(","), digits.lastIndexOf("."));
  const cut = last >= 0 && /^\d{1,2}$/u.test(digits.slice(last + 1)) ? last : -1;
  const pesos = (cut < 0 ? digits : digits.slice(0, cut)).replace(/[.,]/gu, "");
  const centavos = cut < 0 ? "" : digits.slice(cut + 1);
  if (!/^\d{1,12}$/u.test(pesos)) return undefined;
  return { raw: raw.trim(), cents: Number(pesos) * 100 + Number(centavos.padEnd(2, "0")), withCents: centavos !== "" };
}

const AMOUNT = /(?<![\d.,/-])(?:\$ ?)?\d(?:[\d.,]*\d)?(?![\d/-])/gu;

/** A dotted day and month without a year (`12.50`) reads as an amount before it reads as a date. */
const AMOUNT_LIKE_DATE = /^\d{1,2}\.\d{1,2}$/u;

/** Every amount a text states, in the order they appear (a date's numbers are not amounts). */
export function amountsIn(text: string): AmountMention[] {
  const source = folded(text).replace(/\s+/gu, " ");
  const dates = datesIn(source).map((mention) => mention.raw).filter((raw) => !AMOUNT_LIKE_DATE.test(raw));
  const withoutDates = dates.reduce((rest, raw) => rest.replace(raw, " ".repeat(raw.length)), source);
  return [...withoutDates.matchAll(AMOUNT)].flatMap((match) => {
    const mention = amountMention(match[0]);
    return mention === undefined ? [] : [mention];
  });
}

function coversDate(answer: DateMention, written: DateMention): boolean {
  return answer.day === written.day && answer.month === written.month && (answer.year === undefined || answer.year === written.year);
}

function coversAmount(answer: AmountMention, written: AmountMention): boolean {
  if (answer.withCents) return written.withCents && written.cents === answer.cents;
  return Math.floor(written.cents / 100) * 100 === answer.cents;
}

/**
 * The fragment of `text` (one message of the customer) that states `answer` for this kind of
 * challenge, or `undefined` when the customer did not write it. An answer that states two values,
 * or none of the kind, is only the customer's when it is the whole message.
 */
export function writtenFragment(kind: ChallengeKind, answer: string, text: string): string | undefined {
  if (kind === "LAST_DUE_DATE") {
    const stated = datesIn(answer);
    if (stated.length === 1 && stated[0] !== undefined) {
      const wanted = stated[0];
      return datesIn(text).find((mention) => coversDate(wanted, mention))?.raw;
    }
  } else {
    const stated = amountsIn(answer);
    if (stated.length === 1 && stated[0] !== undefined) {
      const wanted = stated[0];
      return amountsIn(text).find((mention) => coversAmount(wanted, mention))?.raw;
    }
  }
  const whole = collapsed(text);
  return whole !== "" && whole === collapsed(answer) && text.trim().length <= MAX_ANSWER_CHARS ? text.trim() : undefined;
}
