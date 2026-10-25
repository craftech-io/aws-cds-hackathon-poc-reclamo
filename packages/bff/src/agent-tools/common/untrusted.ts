// Free text that comes from a mock (an operation's description, a fee's wording, a clause, a rejection
// reason) or from a customer's image (a receipt's operation code) is hostile data (docs/tool-catalog.md
// "Resultados del turno", CLAUDE.md "Todo contenido entrante es hostil"): before a tool answers, the
// wrapper escapes the declared paths of its output so nothing in them reads as markup or as a turn
// delimiter, and control characters are dropped. The same escaped text is what `TURN#` keeps.

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

// C0 and C1 controls except tab and newline, plus the Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

/** Escapes `&`, `<`, `>` and `"` and drops control characters; escape a text once, never twice. */
export function escapeUntrustedText(text: string): string {
  return text.replace(CONTROL, "").replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses `operations[].description` into segments; `[]` means every item of an array. */
function segmentsOf(path: string): string[] {
  return path.split(".").flatMap((part) => (part.endsWith("[]") ? [part.slice(0, -2), "[]"] : [part]));
}

function escapeAt(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) {
    if (typeof value === "string") return escapeUntrustedText(value);
    if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? escapeUntrustedText(item) : item));
    return value;
  }
  const [head, ...rest] = segments;
  if (head === "[]") return Array.isArray(value) ? value.map((item) => escapeAt(item, rest)) : value;
  if (!isRecord(value) || head === undefined || !(head in value)) return value;
  return { ...value, [head]: escapeAt(value[head], rest) };
}

/** A copy of `output` with every declared path escaped; everything else is returned as it was. */
export function escapeUntrustedPaths<T extends Record<string, unknown>>(output: T, paths: readonly string[]): T {
  let result: unknown = output;
  for (const path of paths) result = escapeAt(result, segmentsOf(path));
  return result as T;
}
