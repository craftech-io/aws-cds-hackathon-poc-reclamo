// Letters of other scripts that a reader takes for Latin ones (a confusables skeleton, after Unicode
// TS #39, narrowed to what reads as Spanish): Cyrillic, Greek, Armenian and the Latin letters NFKD
// leaves alone (dotless i, IPA forms). lexicon-match.ts maps them to Latin before folding, so "Pаgá"
// with a Cyrillic а reads "paga" as a WhatsApp reader sees it. Upper and lower case are mapped
// separately because a capital and its small letter can look like different Latin letters (Greek
// Η is H, η is n).
// Also the invisible fillers that are not format characters (\p{Cf}): Hangul fillers, the braille
// blank and the Mongolian vowel separator render as nothing and are deleted, never read as a space.

const SKELETON: Readonly<Record<string, string>> = {
  // Cyrillic, capitals
  А: "A", В: "B", Е: "E", З: "3", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", Ѕ: "S", І: "I", Ј: "J", Ӏ: "I", Ԛ: "Q", Ԝ: "W", Ү: "Y",
  // Cyrillic, small letters
  а: "a", в: "b", г: "r", е: "e", к: "k", м: "m", н: "h", о: "o", п: "n", р: "p", с: "c", т: "t", у: "y", х: "x", ь: "b", ѕ: "s", і: "i", ј: "j", һ: "h", ԁ: "d", ԛ: "q", ԝ: "w", ӏ: "l", ү: "y",
  // Greek, capitals
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  // Greek, small letters
  α: "a", β: "b", γ: "y", ε: "e", η: "n", ι: "i", κ: "k", μ: "u", ν: "v", ο: "o", ρ: "p", ς: "c", σ: "o", τ: "t", υ: "u", χ: "x", ω: "w",
  // Armenian
  Ս: "U", Օ: "O", հ: "h", ո: "n", ս: "u", ց: "g", օ: "o",
  // Latin letters NFKD does not reduce to a-z
  ı: "i", ȷ: "j", ɑ: "a", ɡ: "g", ɩ: "i", ʋ: "u", ʏ: "y",
};

const SKELETON_PATTERN = new RegExp(`[${Object.keys(SKELETON).join("")}]`, "gu");

/** Invisible fillers outside \p{Cf}: deleted, never a word boundary (U+3164 and U+FFA0 reach NFKD as U+1160). */
export const INVISIBLE_FILLERS = /[ᅟᅠ᠎⠀ㅤﾠ]+/gu;

/** The text with every look-alike letter of another script replaced by the Latin letter it imitates. */
export function toLatinSkeleton(text: string): string {
  return text.replace(SKELETON_PATTERN, (letter) => SKELETON[letter] ?? letter);
}
