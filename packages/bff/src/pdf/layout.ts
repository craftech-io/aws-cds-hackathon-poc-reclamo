// Building blocks of the documents' body: titles, label-value fields, headings, wrapped paragraphs,
// bullet lists, tables and hashes, as rows for writer.ts. Every text is folded to WinAnsi here, so
// the widths used for line breaking are the widths of what gets drawn.
import { type FontKey, textWidth, wrapText } from "./metrics";
import { toWinAnsi } from "./winansi";
import { CONTENT_WIDTH, MARGIN_X, type PdfRow, type PdfRun } from "./writer";

const BODY_SIZE = 10;
const LINE_HEIGHT = 14;
const LABEL_WIDTH = 170;
const BULLET_INDENT = 14;
const MONO_SIZE = 8.5;
/** Width of the tag column before a hash, in monospaced characters (`FINAL_ANSWER` and a space). */
const HASH_TAG_CHARS = 13;

function run(text: string, x: number, font: FontKey, size: number, muted = false): PdfRun {
  return muted ? { text, x, font, size, muted } : { text, x, font, size };
}

/** Wrapped lines of `text` (paragraphs split at `\n`) for a column of `width`. */
function lines(text: string, width: number, font: FontKey, size: number): string[] {
  return toWinAnsi(text)
    .split("\n")
    .flatMap((paragraph) => wrapText(paragraph, width, font, size));
}

/** A single line in a given style (letterhead, brand, signature). */
export function textRow(text: string, options: { font?: FontKey; size?: number; muted?: boolean; gapBefore?: number; rule?: boolean } = {}): PdfRow {
  const size = options.size ?? BODY_SIZE;
  return {
    runs: [run(toWinAnsi(text), MARGIN_X, options.font ?? "regular", size, options.muted)],
    height: size + 4,
    ...(options.gapBefore === undefined ? {} : { gapBefore: options.gapBefore }),
    ...(options.rule ? { rule: true } : {}),
  };
}

/** The document's title, below the header. */
export function title(text: string): PdfRow[] {
  return lines(text, CONTENT_WIDTH, "bold", 15).map((line, index) => ({ runs: [run(line, MARGIN_X, "bold", 15)], height: 20, gapBefore: index === 0 ? 4 : 0 }));
}

/** A section heading, kept on the page of its first line. */
export function heading(text: string): PdfRow[] {
  return lines(text, CONTENT_WIDTH, "bold", 11).map((line, index) => ({ runs: [run(line, MARGIN_X, "bold", 11)], height: 15, gapBefore: index === 0 ? 10 : 0, keepWithNext: true }));
}

/** "Label    value", the value wrapped in its own column. */
export function field(label: string, value: string): PdfRow[] {
  const labelLines = lines(label, LABEL_WIDTH - 8, "bold", BODY_SIZE);
  const valueLines = lines(value, CONTENT_WIDTH - LABEL_WIDTH, "regular", BODY_SIZE);
  const count = Math.max(labelLines.length, valueLines.length);
  return Array.from({ length: count }, (_, index) => ({
    runs: [run(labelLines[index] ?? "", MARGIN_X, "bold", BODY_SIZE), run(valueLines[index] ?? "", MARGIN_X + LABEL_WIDTH, "regular", BODY_SIZE)],
    height: LINE_HEIGHT,
    gapBefore: index === 0 ? 2 : 0,
  }));
}

/** Wrapped text across the content width; `\n` starts a new paragraph. */
export function paragraph(text: string, options: { font?: FontKey; gapBefore?: number } = {}): PdfRow[] {
  const font = options.font ?? "regular";
  return lines(text, CONTENT_WIDTH, font, BODY_SIZE).map((line, index) => ({
    runs: [run(line, MARGIN_X, font, BODY_SIZE)],
    height: LINE_HEIGHT,
    gapBefore: index === 0 ? options.gapBefore ?? 4 : 0,
  }));
}

/** One bullet (•) per item, with a hanging indent. */
export function bullets(items: readonly string[]): PdfRow[] {
  return items.flatMap((item) =>
    lines(item, CONTENT_WIDTH - BULLET_INDENT, "regular", BODY_SIZE).map((line, index) => ({
      runs: [run(index === 0 ? "•" : "", MARGIN_X + 2, "regular", BODY_SIZE), run(line, MARGIN_X + BULLET_INDENT, "regular", BODY_SIZE)],
      height: LINE_HEIGHT,
      gapBefore: index === 0 ? 2 : 0,
    })),
  );
}

export interface Column {
  readonly header: string;
  /** Share of the content width, in points. */
  readonly width: number;
  readonly align?: "left" | "right";
}

function cellRun(text: string, x: number, column: Column, font: FontKey): PdfRun {
  const value = toWinAnsi(text);
  const left = column.align === "right" ? x + column.width - 6 - textWidth(value, font, BODY_SIZE) : x;
  return run(value, left, font, BODY_SIZE);
}

/**
 * A table with a bold header row. A cell wider than its column wraps inside it, and the table row
 * takes as many lines as its tallest cell.
 */
export function table(columns: readonly Column[], rows: ReadonlyArray<readonly string[]>): PdfRow[] {
  const starts = columns.map((_, index) => MARGIN_X + columns.slice(0, index).reduce((sum, column) => sum + column.width, 0));
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  if (total > CONTENT_WIDTH) throw new RangeError(`table wider than the page: ${total}`);
  const toRows = (cells: readonly string[], font: FontKey, header: boolean): PdfRow[] => {
    const wrapped = columns.map((column, index) => lines(cells[index] ?? "", column.width - 6, font, BODY_SIZE));
    const count = Math.max(...wrapped.map((cell) => cell.length));
    return Array.from({ length: count }, (_, line) => ({
      runs: columns.map((column, index) => cellRun(wrapped[index]?.[line] ?? "", starts[index] ?? MARGIN_X, column, font)),
      height: LINE_HEIGHT,
      ...(header ? { rule: line === count - 1, keepWithNext: true, gapBefore: line === 0 ? 4 : 0 } : { gapBefore: line === 0 ? 2 : 0 }),
    }));
  };
  return [...toRows(columns.map((column) => column.header), "bold", true), ...rows.flatMap((cells) => toRows(cells, "regular", false))];
}

/** A register hash in a monospaced font, optionally after a short tag (`FILED`). */
export function hashRow(hash: string, tag?: string): PdfRow {
  const hashX = tag === undefined ? MARGIN_X : MARGIN_X + textWidth("X".repeat(HASH_TAG_CHARS), "mono", MONO_SIZE);
  return { runs: [...(tag === undefined ? [] : [run(tag, MARGIN_X, "mono", MONO_SIZE)]), run(hash, hashX, "mono", MONO_SIZE)], height: 12, gapBefore: 2 };
}
