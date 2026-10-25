// Dependency-free PDF writer of the documents the product emits (docs/architecture-integrations.md
// §8). Output is PDF 1.4 text only: the standard Helvetica, Helvetica-Bold and Courier fonts in
// WinAnsiEncoding (referenced by name, never embedded, so no font file is read), A4 pages with the
// same header and footer on each, uncompressed content streams and an information dictionary
// without dates, author or ids. Same spec, same bytes: nothing here reads a clock or a random source.
import { type FontKey } from "./metrics";
import { toWinAnsi, winAnsiBytes } from "./winansi";

export const PAGE_WIDTH = 595;
export const PAGE_HEIGHT = 842;
export const MARGIN_X = 56;
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;

const TOP_Y = 800;
/** Lowest baseline of the body; the footer lives below it. */
const BODY_BOTTOM_Y = 86;
const FOOTER_TOP_Y = 62;
const HEADER_BODY_GAP = 14;

const FONT_RESOURCE: Readonly<Record<FontKey, string>> = { regular: "/F1", bold: "/F2", mono: "/F3" };
const BASE_FONTS: readonly string[] = ["Helvetica", "Helvetica-Bold", "Courier"];

/** One string drawn at a horizontal position of its row. */
export interface PdfRun {
  readonly text: string;
  /** From the left edge of the page, in points. */
  readonly x: number;
  readonly font: FontKey;
  readonly size: number;
  /** Secondary text (legend, brand): drawn in grey. */
  readonly muted?: boolean;
}

/** A line of the page: its runs share a baseline. */
export interface PdfRow {
  readonly runs: readonly PdfRun[];
  /** Vertical space the row takes, in points (its baseline sits at the bottom of it). */
  readonly height: number;
  /** Extra space above the row; dropped when the row starts a page. */
  readonly gapBefore?: number;
  /** A heading: moved to the next page rather than left alone at the bottom of one. */
  readonly keepWithNext?: boolean;
  /** Draws a thin horizontal rule across the content width below the row's runs. */
  readonly rule?: boolean;
}

export interface PdfDocumentSpec {
  /** Information dictionary entries (`Title`, `Subject`, `Producer`), written in this order. */
  readonly info: ReadonlyArray<readonly [string, string]>;
  /** Rows repeated at the top of every page. */
  readonly header: readonly PdfRow[];
  /** Rows repeated at the bottom of every page, given its number and the page count. */
  readonly footer: (page: number, pages: number) => readonly PdfRow[];
  readonly body: readonly PdfRow[];
}

/** A PDF literal string in pure ASCII: parentheses and backslash escaped, bytes above 0x7E in octal. */
export function pdfString(text: string): string {
  let out = "(";
  for (const byte of winAnsiBytes(toWinAnsi(text).replaceAll("\n", " "))) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte > 0x7e) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

/** A text string of the information dictionary: ASCII as a literal, anything else as UTF-16BE with BOM. */
export function pdfTextString(text: string): string {
  const clean = toWinAnsi(text).replaceAll("\n", " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return pdfString(clean);
  let hex = "FEFF";
  for (let index = 0; index < clean.length; index += 1) hex += clean.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0");
  return `<${hex}>`;
}

function pdfName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new RangeError(`invalid PDF name ${name}`);
  return `/${name}`;
}

/** At most two decimals, no exponent: coordinates written the same way on every machine. */
function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function rowOps(row: PdfRow, baseline: number): string[] {
  const ops: string[] = [];
  for (const run of row.runs) {
    if (run.text === "") continue;
    const text = `BT ${FONT_RESOURCE[run.font]} ${num(run.size)} Tf ${num(run.x)} ${num(baseline)} Td ${pdfString(run.text)} Tj ET`;
    ops.push(run.muted ? `0.35 g ${text} 0 g` : text);
  }
  if (row.rule) ops.push(`0.6 G 0.5 w ${num(MARGIN_X)} ${num(baseline - 5)} m ${num(MARGIN_X + CONTENT_WIDTH)} ${num(baseline - 5)} l S 0 G`);
  return ops;
}

function stackHeight(rows: readonly PdfRow[], skipFirstGap: boolean): number {
  return rows.reduce((total, row, index) => total + row.height + (index === 0 && skipFirstGap ? 0 : row.gapBefore ?? 0), 0);
}

/** Body rows split into pages, each page with the y where its first row starts. */
function paginate(body: readonly PdfRow[], bodyTop: number): PdfRow[][] {
  const pages: PdfRow[][] = [[]];
  let cursor = bodyTop;
  body.forEach((row, index) => {
    const page = pages.at(-1) ?? [];
    const gap = page.length === 0 ? 0 : row.gapBefore ?? 0;
    const next = body[index + 1];
    const needed = row.height + gap + (row.keepWithNext && next ? next.height + (next.gapBefore ?? 0) : 0);
    if (page.length > 0 && cursor - needed < BODY_BOTTOM_Y) {
      pages.push([row]);
      cursor = bodyTop - row.height;
      return;
    }
    page.push(row);
    cursor -= row.height + gap;
  });
  return pages;
}

function drawStack(rows: readonly PdfRow[], top: number): string[] {
  const ops: string[] = [];
  let cursor = top;
  rows.forEach((row, index) => {
    cursor -= row.height + (index === 0 ? 0 : row.gapBefore ?? 0);
    ops.push(...rowOps(row, cursor));
  });
  return ops;
}

function pageContent(spec: PdfDocumentSpec, rows: readonly PdfRow[], bodyTop: number, page: number, pages: number): string {
  const ops = [...drawStack(spec.header, TOP_Y), ...drawStack(rows, bodyTop), ...drawStack(spec.footer(page, pages), FOOTER_TOP_Y)];
  return `${ops.join("\n")}\n`;
}

export interface WrittenPdf {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

/** The PDF of `spec`: identical spec, identical bytes. */
export function writePdf(spec: PdfDocumentSpec): WrittenPdf {
  const bodyTop = TOP_Y - stackHeight(spec.header, true) - HEADER_BODY_GAP;
  const pages = paginate(spec.body, bodyTop);
  const fontCount = BASE_FONTS.length;
  const firstPage = 3 + fontCount;
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pages.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  for (const font of BASE_FONTS) objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
  const fonts = BASE_FONTS.map((_, index) => `/F${index + 1} ${index + 3} 0 R`).join(" ");
  pages.forEach((rows, index) => {
    const content = pageContent(spec, rows, bodyTop, index + 1, pages.length);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << ${fonts} >> >> /Contents ${firstPage + index * 2 + 1} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  });
  objects.push(`<< ${spec.info.map(([key, value]) => `${pdfName(key)} ${pdfTextString(value)}`).join(" ")} >>`);
  const infoRef = objects.length;

  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoRef} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { bytes: new Uint8Array(Buffer.from(out, "latin1")), pageCount: pages.length };
}
