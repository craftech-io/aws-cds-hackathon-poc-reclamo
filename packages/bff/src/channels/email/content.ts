// Text and HTML parts of a customer email (docs/architecture-integrations.md §1, "Cuerpo"): the fixed
// texts of copy/es-AR.ts around the paragraphs the gate hands over (fixed copy, or the text the agent
// or an operator drafted, already through G2 and outbound/verify.ts). Everything is escaped for the
// HTML part; the HTML has no script, no link, no image and no external resource, so the console's
// sandboxed viewer shows it as is. The footer is fixed: the complaint number, the right to go to the
// BCRA when the email is a written answer (our reading, a fixed text) and the synthetic-data notice.
import { EMAIL_TEXT } from "../../copy";
import { fill } from "../../copy/helpers";

export interface EmailContentInput {
  /** The greeting already filled (`EMAIL_TEXT.GREETING`), or none. */
  readonly greeting?: string;
  /** Body paragraphs in order; a blank line inside one starts a new paragraph. */
  readonly paragraphs: readonly string[];
  readonly complaintNumber?: string;
  /** The BCRA line: written answers and closure notices carry it. */
  readonly bcraFooter: boolean;
}

export interface EmailContent {
  readonly text: string;
  readonly html: string;
}

const MAX_PARAGRAPHS = 40;
const MAX_PARAGRAPH_CHARS = 8_000;

const HTML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function blocksOf(paragraphs: readonly string[]): string[] {
  return paragraphs
    .flatMap((paragraph) => paragraph.replace(/\r\n?/g, "\n").split(/\n{2,}/))
    .map((block) => block.trim())
    .filter((block) => block !== "");
}

function footerOf(input: EmailContentInput): string[] {
  return [
    EMAIL_TEXT.NO_REPLY,
    ...(input.complaintNumber === undefined ? [] : [fill(EMAIL_TEXT.FOOTER_COMPLAINT, { complaintNumber: input.complaintNumber })]),
    ...(input.bcraFooter ? [EMAIL_TEXT.FOOTER_BCRA] : []),
    EMAIL_TEXT.FOOTER_SYNTHETIC,
  ];
}

function htmlParagraph(block: string, style: string): string {
  return `<p style="${style}">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`;
}

export function renderEmailContent(input: EmailContentInput): EmailContent {
  if (input.paragraphs.length === 0 || input.paragraphs.length > MAX_PARAGRAPHS) throw new RangeError(`an email has 1 to ${MAX_PARAGRAPHS} paragraphs`);
  if (input.paragraphs.some((paragraph) => paragraph.length > MAX_PARAGRAPH_CHARS)) throw new RangeError(`a paragraph has at most ${MAX_PARAGRAPH_CHARS} characters`);
  const body = [...(input.greeting === undefined ? [] : [input.greeting]), ...blocksOf(input.paragraphs)];
  const footer = footerOf(input);
  const text = [...body, "--", ...footer].join("\n\n") + "\n";
  const html = [
    "<!doctype html>",
    '<html lang="es-AR"><head><meta charset="utf-8"><title>' + escapeHtml(EMAIL_TEXT.FROM_NAME) + "</title></head>",
    '<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">',
    ...body.map((block) => htmlParagraph(block, "margin:0 0 16px")),
    '<hr style="border:0;border-top:1px solid;opacity:0.2;margin:24px 0">',
    ...footer.map((line) => htmlParagraph(line, "margin:0 0 8px;font-size:12px;opacity:0.75")),
    "</body></html>",
  ].join("\n");
  return { text, html };
}
