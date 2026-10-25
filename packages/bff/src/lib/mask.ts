// The ONE source of masking patterns (docs/architecture.md §12-§13): channels/normalizer.ts masks
// inbound text with it before persisting and before the Harness envelope, and lib/log.ts redacts
// every log line with it. Bedrock Guardrails (G1 ANONYMIZE) is a second layer, never the first.
//
// Every Unicode space (a no-break space copied from an app, a thin space) is an ASCII space first
// (`asciiSpaces`), and a grouped number may separate its groups with a dot or a dash (spaces around
// it allowed, `0110 - 5995`) or with one to three spaces.
//
//   [CBU]       22-digit CBU/CVU (one digit more or less: a typo still masks), contiguous or
//               grouped
//   [TARJETA]   13-19 digits, contiguous or grouped, that pass Luhn; in a longer run of groups the
//               card is found at a group boundary (`4111 1111 1111 1111 123`) and a CVV or an
//               expiry glued to it (up to two groups of 2-4 digits) is masked with it
//   [CUIT]      CUIT/CUIL, `20-12345678-3`, `20 30.123.456 7`, `20.30123456.7` or 11 digits
//   [DNI]       7-8 digits, `12.345.678`, `12 345 678` or plain, standing alone (never a peso amount:
//               `$ 1.500.000` or `1.180.640,00` stays as written)
//   [CLAVE]     a 4-8 digit secret next to "clave", "PIN", "código", "contraseña" or "token"
//   [TELEFONO]  E.164 or an Argentine mobile written with spaces, dots or dashes; and, only where a
//               caller asks for `LOCAL_PHONE` (the inbound text of a self-signup world), any other
//               run of 8 to 15 digits written plain or with spaces or dashes (never a date, a
//               complaint number or a peso amount), which nothing else masked first
//   [EMAIL]     any address
//
// Order matters: the longest and most specific numbers go first so a grouped CBU is never half
// masked as a card, nor a card as a DNI. Nothing here reads the clock or the network.

export type MaskLabel = "TARJETA" | "CBU" | "CUIT" | "DNI" | "CLAVE" | "TELEFONO" | "LOCAL_PHONE" | "EMAIL";

export const MASK_TOKEN: Readonly<Record<MaskLabel, string>> = {
  TARJETA: "[TARJETA]",
  CBU: "[CBU]",
  CUIT: "[CUIT]",
  DNI: "[DNI]",
  CLAVE: "[CLAVE]",
  TELEFONO: "[TELEFONO]",
  LOCAL_PHONE: "[TELEFONO]",
  EMAIL: "[EMAIL]",
};

/** Luhn check of a digit string (payment cards). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// Not glued to a letter, a digit or an id separator on either side (infra/guardrail-policies.ts
// rewrites these boundaries for G1: change both together).
const START = "(?<![\\p{L}\\p{N}_#/-])";
const END = "(?![\\p{L}\\p{N}_#/])";
// Between two groups: a dot or a dash with up to two spaces on each side, or one to three spaces.
const GROUP_SEP = "(?: {0,2}[.-] {0,2}| {1,3})";
const SEP = `${GROUP_SEP}?`;
const DOT_OR_SPACES = "(?: {0,2}\\. {0,2}| {1,3})";
// A DNI is never a peso amount: not right after `$` (one optional space) nor followed by `,<cents>`.
const DNI_START = `${START}(?<!\\$\\s?)`;
const DNI_END = `${END}(?!,\\d)`;
const CUIT_PREFIX = "(?:20|23|24|27|30|33|34)";
const DASH = " {0,2}- {0,2}";

export const MASK_PATTERNS: ReadonlyArray<readonly [MaskLabel, RegExp]> = [
  ["EMAIL", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu],
  ["CLAVE", /\b(clave|pin|c[oó]digo|contrase[nñ]a|token)(\s*(de\s+\p{L}+\s*)?(es|:|=)?\s*)(\d{4,8})(?!\d)/giu],
  ["CBU", new RegExp(`${START}\\d(?:${SEP}\\d){20,22}${END}`, "gu")],
  // A run of 13 to 39 digits: the card is looked for inside it at a group boundary (maskCardRun).
  ["TARJETA", new RegExp(`${START}\\d(?:${SEP}\\d){12,38}${END}`, "gu")],
  ["CUIT", new RegExp(`${START}(?:\\d{2}${DASH}(?:\\d{8}|\\d{2}\\.\\d{3}\\.\\d{3})${DASH}\\d|${CUIT_PREFIX}${SEP}(?:\\d{8}|\\d{2}${DOT_OR_SPACES}\\d{3}${DOT_OR_SPACES}\\d{3})${SEP}\\d)${END}`, "gu")],
  ["TELEFONO", new RegExp(`${START}(?:\\+\\d[\\d\\s().-]{6,18}\\d|(?:11|15)[\\s.-]?\\d{4}[\\s.-]?\\d{4})${END}`, "gu")],
  ["DNI", new RegExp(`${DNI_START}(?:\\d{1,2}${DOT_OR_SPACES}\\d{3}${DOT_OR_SPACES}\\d{3}|\\d{7,8})${DNI_END}`, "gu")],
  // Opt-in (not in the default set): 8 to 15 digits with spaces or dashes and no dot, so a peso amount
  // (`1.500.000`) never matches; a date (`2026-10-09`, `09-10-2026`) or a complaint number without its
  // `R-` (`2026-000123`) is left alone.
  ["LOCAL_PHONE", new RegExp(`${DNI_START}(?!\\d{4}-\\d{2}-\\d{2}${END}|\\d{2}-\\d{2}-\\d{4}${END}|\\d{4}-\\d{6}${END})\\d(?:[ -]{0,2}\\d){7,14}${DNI_END}`, "gu")],
];

/** Labels a caller has to ask for by name: masking them everywhere would hide ids and amounts in logs. */
const OPT_IN_LABELS: ReadonlySet<MaskLabel> = new Set<MaskLabel>(["LOCAL_PHONE"]);
const ALL_LABELS: ReadonlySet<MaskLabel> = new Set(MASK_PATTERNS.map(([label]) => label).filter((label) => !OPT_IN_LABELS.has(label)));
const CARD_LABELS: ReadonlySet<MaskLabel> = new Set<MaskLabel>(["CBU", "TARJETA"]);

/** Every Unicode space (no-break, narrow, thin, ideographic) as an ASCII space: masking reads only those. */
export function asciiSpaces(text: string): string {
  return text.replace(/\p{Zs}/gu, " ");
}

interface DigitGroup {
  readonly start: number;
  readonly end: number;
  readonly digits: string;
}

/** The last group of the longest card (13-19 digits, Luhn) that starts at group `from`. */
function cardEndingFrom(groups: readonly DigitGroup[], from: number): number | undefined {
  let digits = "";
  let found: number | undefined;
  for (let index = from; index < groups.length; index += 1) {
    digits += groups[index]?.digits ?? "";
    if (digits.length > 19) break;
    if (digits.length >= 13 && luhnValid(digits)) found = index;
  }
  return found;
}

/** A run of digit groups with every card in it masked, a CVV or expiry glued to a card included. */
export function maskCardRun(run: string): { readonly text: string; readonly cards: number } {
  const groups: DigitGroup[] = [...run.matchAll(/\d+/g)].map((match) => ({ start: match.index, end: match.index + match[0].length, digits: match[0] }));
  let out = "";
  let cursor = 0;
  let cards = 0;
  let index = 0;
  while (index < groups.length) {
    const end = cardEndingFrom(groups, index);
    if (end === undefined) {
      index += 1;
      continue;
    }
    let last = end;
    for (let extra = 0; extra < 2; extra += 1) {
      const next = groups[last + 1];
      if (next === undefined || !/^\d{2,4}$/.test(next.digits) || cardEndingFrom(groups, last + 1) !== undefined) break;
      last += 1;
    }
    out += `${run.slice(cursor, groups[index]?.start)}${MASK_TOKEN.TARJETA}`;
    cursor = groups[last]?.end ?? run.length;
    cards += 1;
    index = last + 1;
  }
  return { text: `${out}${run.slice(cursor)}`, cards };
}

export interface MaskResult {
  readonly text: string;
  /** How many values of each kind were masked. */
  readonly counts: Partial<Record<MaskLabel, number>>;
}

/** Masks the kinds of `labels` in the order of MASK_PATTERNS, counting what each one replaced. */
export function maskLabels(text: string, labels: ReadonlySet<MaskLabel> = ALL_LABELS): MaskResult {
  const counts: Partial<Record<MaskLabel, number>> = {};
  const count = (label: MaskLabel, n: number) => {
    const key: MaskLabel = label === "LOCAL_PHONE" ? "TELEFONO" : label;
    if (n > 0) counts[key] = (counts[key] ?? 0) + n;
  };
  let out = asciiSpaces(text);
  for (const [label, pattern] of MASK_PATTERNS) {
    if (!labels.has(label)) continue;
    out = out.replace(new RegExp(pattern.source, pattern.flags), (match: string, ...groups: unknown[]) => {
      if (label === "TARJETA") {
        const masked = maskCardRun(match);
        count(label, masked.cards);
        return masked.text;
      }
      count(label, 1);
      return label === "CLAVE" ? `${String(groups[0])}${String(groups[1])}${MASK_TOKEN.CLAVE}` : MASK_TOKEN[label];
    });
  }
  return { text: out, counts };
}

/** Masks every sensitive value of `text` with its token; the text around it stays as it was. */
export function maskSensitive(text: string): string {
  return maskLabels(text).text;
}

/** True when `text` carries a full payment card (G1 blocks the turn and the agent sends SAFETY_GUIDANCE); a grouped CBU is read as a CBU first, never as a card. */
export function containsCard(text: string): boolean {
  return (maskLabels(text, CARD_LABELS).counts.TARJETA ?? 0) > 0;
}
