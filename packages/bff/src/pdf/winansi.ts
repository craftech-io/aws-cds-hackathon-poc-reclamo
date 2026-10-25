// Text of the PDF documents (docs/architecture-integrations.md §8). The writer uses the standard
// Helvetica and Courier fonts, which cover WinAnsiEncoding only, so every text goes through
// `toWinAnsi` before it is laid out: `ñ`, `á`, `¿`, `¡`, `•`, `·` and `—` are WinAnsi and stay;
// `≤`, `→`, `✓` and the typographic quotes and dashes outside WinAnsi become their ASCII pair; any
// other code point keeps the WinAnsi part of its compatibility decomposition (`ő` → `o`, `ﬁ` → `fi`)
// or is dropped (emojis, scripts the font cannot draw). The result never depends on the runtime.

/** WinAnsiEncoding (cp1252) above Latin-1's ASCII range: the 27 characters of 0x80-0x9F. */
const WIN_ANSI_HIGH: Readonly<Record<string, number>> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** Characters outside WinAnsi with a readable ASCII (or WinAnsi) equivalent. */
const REPLACEMENTS: Readonly<Record<string, string>> = {
  "≤": "<=", "≥": ">=", "≠": "!=", "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "⇐": "<=",
  "✓": "OK", "✔": "OK", "☑": "OK", "✗": "X", "✘": "X",
  "‐": "-", "‑": "-", "‒": "-", "―": "-", "−": "-", "⁃": "-",
  "′": "'", "‛": "'", "″": "\"", "‟": "\"", "⁄": "/", "∙": "·", "‧": "·",
};

const FORMAT_CHARS = /\p{Cf}/gu;
const COMBINING_MARKS = /\p{M}/gu;
const LINE_BREAKS = /\r\n?/g;

/** True when `char` (one code point) has a WinAnsi code and is printable. */
export function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (char.length === 0 || [...char].length !== 1) return false;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_HIGH[char] !== undefined;
}

/** The WinAnsi form of one code point outside WinAnsi (possibly empty). */
function fold(char: string): string {
  const replacement = REPLACEMENTS[char];
  if (replacement !== undefined) return replacement;
  if (/\s/u.test(char)) return " ";
  if (/\p{Cc}/u.test(char)) return "";
  return [...char.normalize("NFKD").replace(COMBINING_MARKS, "")].filter((part) => isWinAnsi(part) && part !== " ").join("");
}

/**
 * `text` with every character drawable by the standard fonts: NFC, no format characters, line
 * breaks as `\n`, no-break and other spaces as a plain space, runs of spaces left by a dropped
 * character folded into one, and no trailing spaces on a line.
 */
export function toWinAnsi(text: string): string {
  const folded = [...text.normalize("NFC").replace(FORMAT_CHARS, "").replace(LINE_BREAKS, "\n")]
    .map((char) => (char === "\n" ? char : char === " " ? " " : isWinAnsi(char) ? char : fold(char)))
    .join("");
  return folded
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trimEnd())
    .join("\n");
}

/** The WinAnsi bytes of `text`, which must already be WinAnsi (see `toWinAnsi`). */
export function winAnsiBytes(text: string): number[] {
  return [...text].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    if (!isWinAnsi(char)) throw new RangeError(`character U+${code.toString(16).toUpperCase().padStart(4, "0")} has no WinAnsi code`);
    return WIN_ANSI_HIGH[char] ?? code;
  });
}
