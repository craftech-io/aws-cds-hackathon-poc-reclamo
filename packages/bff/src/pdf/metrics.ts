// Glyph widths of the three standard fonts the documents use, in 1/1000 of the font size, from the
// Adobe metrics of Helvetica, Helvetica-Bold and Courier. ASCII has its exact widths; an accented
// Latin letter takes its base letter's width (as in the fonts); the rest of WinAnsi uses the table
// below or the width of a digit. Only line breaking and right alignment depend on them.

export type FontKey = "regular" | "bold" | "mono";

// Codes 0x20-0x7E, in order.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** WinAnsi characters above ASCII that are not an accented letter: [regular, bold]. */
const SPECIAL: Readonly<Record<string, readonly [number, number]>> = {
  "•": [350, 350], "—": [1000, 1000], "–": [556, 556], "·": [278, 278], "¿": [611, 611], "¡": [333, 333],
  "«": [556, 556], "»": [556, 556], "°": [400, 400], "º": [365, 365], "ª": [370, 370], "€": [556, 556],
  "…": [1000, 1000], "‘": [222, 278], "’": [222, 278], "‚": [222, 278], "“": [333, 500], "”": [333, 500],
  "„": [333, 500], "‹": [333, 333], "›": [333, 333], "§": [556, 556], "©": [737, 737], "®": [737, 737],
  "Æ": [1000, 1000], "æ": [889, 889], "Œ": [1000, 1000], "œ": [944, 944], "ß": [611, 611], "Ø": [778, 778],
  "ø": [611, 611], "×": [584, 584], "÷": [584, 584], "‰": [1000, 1000], "™": [1000, 1000], " ": [278, 278],
};

const MONO_WIDTH = 600;
const FALLBACK = 556;

function asciiWidth(code: number, font: FontKey): number | undefined {
  const table = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  return code >= 0x20 && code <= 0x7e ? table[code - 0x20] : undefined;
}

/** Width of one character in 1/1000 of the font size. */
export function charWidth(char: string, font: FontKey): number {
  if (font === "mono") return MONO_WIDTH;
  const direct = asciiWidth(char.codePointAt(0) ?? 0, font);
  if (direct !== undefined) return direct;
  const special = SPECIAL[char];
  if (special) return font === "bold" ? special[1] : special[0];
  const base = char.normalize("NFD").charAt(0);
  return asciiWidth(base.codePointAt(0) ?? 0, font) ?? FALLBACK;
}

/** Width of `text` in points at `size`. */
export function textWidth(text: string, font: FontKey, size: number): number {
  let units = 0;
  for (const char of text) units += charWidth(char, font);
  return (units * size) / 1000;
}

/** Splits a word wider than `maxWidth` (a hash, a long id) into pieces that fit. */
function breakWord(word: string, maxWidth: number, font: FontKey, size: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const char of word) {
    if (current !== "" && textWidth(current + char, font, size) > maxWidth) {
      pieces.push(current);
      current = "";
    }
    current += char;
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/**
 * Greedy line breaking of one paragraph (no `\n`) at spaces; a word wider than the line is broken
 * by characters. An empty paragraph is one empty line.
 */
export function wrapText(paragraph: string, maxWidth: number, font: FontKey, size: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of paragraph.split(" ").filter((part) => part !== "")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (textWidth(candidate, font, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    const pieces = breakWord(word, maxWidth, font, size);
    current = pieces.pop() ?? "";
    lines.push(...pieces);
  }
  lines.push(current);
  return lines;
}
