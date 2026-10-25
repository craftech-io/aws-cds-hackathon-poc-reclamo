// How the lexicons of the policy read a text (collection-lexicon.ts and the content lexicons of
// content.ts). The text is folded once: Unicode NFKD (full-width and compatibility forms become their
// plain letters) without combining marks ("pagá" → "paga", "ñ" → "n"), invisible format and control
// characters and invisible fillers deleted (a soft hyphen, a zero-width space or a Hangul filler never
// splits a word), Cyrillic, Greek and other look-alike letters read as the Latin letter they imitate
// (confusables.ts), lower case, every sentence or clause mark turned into a ` | ` boundary (so a
// pattern never spans two clauses), hyphens and every other symbol into spaces. Patterns are written
// over that folded form, and are also tried over a second reading where digits and symbols standing
// for letters inside a word are read as letters ("p4ga", "p@ga" → "paga"). A pattern marked `negatable` does not count when a negation ("no", "sin", "nunca",
// "jamás", "ni", "tampoco") sits in a free slot of the match or in the words before it in the same
// clause (three by default, `lookback` per pattern): "tu cuota ya no figura atrasada" is service, "tu
// cuota figura atrasada" is collection. A negation the pattern itself spells ("sin pagar") never
// cancels it. A pattern may also carry a refusal frame read over its whole clause ("no puedo gestionar
// un nuevo préstamo", "un nuevo préstamo está fuera de lo que puedo hacer").
// Pure: no clock, no I/O; the findings name pattern ids and categories, never the matched text.
import { INVISIBLE_FILLERS, toLatinSkeleton } from "./confusables";

export interface LexiconPattern<C extends string> {
  /** Stable id, shown in tests and in the rule detail. */
  readonly id: string;
  readonly category: C;
  readonly pattern: RegExp;
  readonly negatable?: boolean;
  /** Words before the match a negation is looked for in (default 3). */
  readonly lookback?: number;
  /**
   * A refusal frame over the folded clause of the match ("no puedo gestionar …", "… está fuera de lo que
   * puedo hacer"): when the clause carries it, the match names what is refused and does not count.
   */
  readonly refusal?: RegExp;
}

export interface LexiconFinding<C extends string> {
  readonly id: string;
  readonly category: C;
}

const NEGATIONS = new Set(["no", "sin", "nunca", "jamas", "ni", "tampoco"]);
const WORDS_BEFORE = 3;
/** Digits and symbols written for letters inside a word ("p4ga", "ab0na", "3vita", "p@ga", "$aldo"). */
const DIGIT_LETTERS: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/** The folded form every lexicon pattern is written against. */
export function foldText(text: string): string {
  const visible = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\p{Cf}+/gu, "")
    .replace(INVISIBLE_FILLERS, "")
    .replace(/[^\P{Cc}\r\n\t]+/gu, "");
  return ` ${toLatinSkeleton(visible)
    .toLowerCase()
    .replace(/[¿¡!?.,;:()[\]{}"'«»“”‘’\r\n\t…]+/gu, " | ")
    .replace(/[^a-z0-9$|@/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** The folded text with the digits and symbols of mixed words read as letters; pure numbers and amounts stay as they are. */
export function readDigitsAsLetters(folded: string): string {
  return folded.replace(/[a-z0-9@$]+/g, (word) => (/[a-z]/.test(word) && /[\d@$]/.test(word) ? word.replace(/[013457@$]/g, (digit) => DIGIT_LETTERS[digit] ?? digit) : word));
}

/** Whether the pattern still matches at `start` with the word at `at` replaced: the word sat in a free slot. */
function freeSlot(folded: string, start: number, at: number, length: number, entry: LexiconPattern<string>): boolean {
  const probe = `${folded.slice(0, at)}${"x".repeat(Math.max(2, length))}${folded.slice(at + length)}`;
  const sticky = new RegExp(entry.pattern.source, `${entry.pattern.flags.replace(/[gy]/g, "")}y`);
  sticky.lastIndex = start;
  const match = sticky.exec(probe);
  return match !== null && start + match[0].length >= at + length;
}

/** The clause (between two boundaries) the match at `start` sits in. */
function clauseAt(folded: string, start: number, length: number): string {
  const before = folded.slice(0, start).split("|").at(-1) ?? "";
  const after = folded.slice(start + length).split("|")[0] ?? "";
  return `${before}${folded.slice(start, start + length)}${after}`;
}

function negated(folded: string, start: number, match: string, entry: LexiconPattern<string>): boolean {
  if (entry.refusal !== undefined && entry.refusal.test(clauseAt(folded, start, match.length))) return true;
  const clause = folded.slice(0, start).split("|").at(-1) ?? "";
  const before = clause.trim().split(" ").filter(Boolean).slice(-(entry.lookback ?? WORDS_BEFORE));
  if (before.some((word) => NEGATIONS.has(word))) return true;
  for (const word of match.matchAll(/[a-z]+/g)) {
    if (NEGATIONS.has(word[0]) && freeSlot(folded, start, start + word.index, word[0].length, entry)) return true;
  }
  return false;
}

/** Whether `pattern` matches `folded` at least once without a negation around it. */
function hits(folded: string, entry: LexiconPattern<string>): boolean {
  const flags = entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`;
  for (const match of folded.matchAll(new RegExp(entry.pattern.source, flags))) {
    if (entry.negatable !== true || !negated(folded, match.index, match[0], entry)) return true;
  }
  return false;
}

/** Every pattern of `lexicon` the text trips, in lexicon order. */
export function matchLexicon<C extends string>(lexicon: readonly LexiconPattern<C>[], text: string): LexiconFinding<C>[] {
  const folded = foldText(text);
  const readings = [...new Set([folded, readDigitsAsLetters(folded)])];
  return lexicon.filter((entry) => readings.some((reading) => hits(reading, entry))).map(({ id, category }) => ({ id, category }));
}

/** The distinct categories of a list of findings, in first-seen order. */
export function categoriesOf<C extends string>(findings: readonly LexiconFinding<C>[]): C[] {
  return [...new Set(findings.map((finding) => finding.category))];
}

/** A whole-word alternation over the folded text: `words("paga", "abona")` → `\b(?:paga|abona)\b`. */
export function words(...alternatives: string[]): string {
  return `\\b(?:${alternatives.join("|")})\\b`;
}

/** Up to `n` arbitrary words after a fragment, inside one clause: `pagar${gap(3)} hoy`. */
export function gap(n: number): string {
  return `(?: [a-z0-9$]+){0,${n}}`;
}

/** A pattern over the folded text from fragments concatenated as written. */
export function rx(...parts: string[]): RegExp {
  return new RegExp(parts.join(""));
}

/**
 * A refusal in the clause of a credit or refinancing word: the author saying they cannot handle, offer or
 * manage it, or that it is outside what they do ("no puedo gestionar la solicitud de un nuevo préstamo",
 * "refinanciar el préstamo está fuera de lo que puedo hacer"). Read over the folded clause only: an offer
 * in another clause still counts.
 */
export const REFUSAL_FRAME = rx(
  words(
    "no (?:puedo|podemos|es posible|esta a mi alcance|esta a nuestro alcance|gestiono|gestionamos|ofrezco|ofrecemos|otorgo|otorgamos|tramito|tramitamos|hago|hacemos|manejo|manejamos)",
    "fuera de (?:lo que (?:puedo|podemos)|(?:mi|nuestro|nuestra|el|este) (?:alcance|gestion|atencion|competencia|servicio|canal))",
    "no forma parte de",
    "no esta dentro de",
    "excede (?:lo que|mi|nuestro)",
  ),
);
