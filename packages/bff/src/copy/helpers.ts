// String helpers of copy/. Texts carry named placeholders (`{{complaintNumber}}`); WhatsApp
// templates carry Meta's positional ones (`{{1}}`). Filling is strict: a missing or unused value
// throws, so a renamed placeholder breaks a test instead of sending "{{deadlineText}}" to a customer.

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*|[1-9]\d*)\}\}/g;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type CopyParamErrorCode = "MISSING_PARAM" | "UNUSED_PARAM" | "INVALID_VALUE";

export class CopyParamError extends Error {
  override readonly name = "CopyParamError";

  constructor(
    readonly code: CopyParamErrorCode,
    readonly param: string,
  ) {
    super(`${code}: ${param}`);
  }
}

/** Placeholder names of `text`, unique and sorted. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""))].sort();
}

/**
 * Replaces every `{{name}}` of `text` with its value. Every placeholder needs a value, every value
 * needs a placeholder, and no value may carry a control character (a CR/LF would break an email
 * header or a WhatsApp template parameter).
 */
export function fill(text: string, params: Readonly<Record<string, string>>): string {
  const names = placeholdersOf(text);
  for (const name of names) {
    const value = params[name];
    if (value === undefined) throw new CopyParamError("MISSING_PARAM", name);
    if (value.trim() === "" || CONTROL.test(value)) throw new CopyParamError("INVALID_VALUE", name);
  }
  for (const name of Object.keys(params)) if (!names.includes(name)) throw new CopyParamError("UNUSED_PARAM", name);
  return text.replace(PLACEHOLDER, (_, name: string) => params[name] ?? "");
}

/** Characters as Meta counts them for button titles: Unicode code points of the NFC form. */
export function charCount(text: string): number {
  return [...text.normalize("NFC")].length;
}

/** First letter in upper case ("pago no reflejado" → "Pago no reflejado"). */
export function capitalize(text: string): string {
  const [first = "", ...rest] = [...text];
  return first.toUpperCase() + rest.join("");
}

function comparable(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[\s.·,;:]+/g, " ").trim();
}

/** `text` when it says more than `label`; `undefined` when it only repeats it (case and spacing aside). */
export function beyondLabel(label: string, text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  return comparable(text) === comparable(label) ? undefined : text;
}
