// CSV exports of the console (docs/tool-catalog.md: `tape.export`, `register.export`,
// `metrics.export`; FL-096) and the file format of a chain export, which `scripts/register/verify.ts`
// reads back without access to the stage. Pure: no AWS, no tRPC, so the script imports it as is.
//
//   csvCell     RFC 4180 quoting plus the spreadsheet guard: a cell that starts with `=`, `+`, `-`,
//               `@`, a tab or a carriage return gets a single quote in front, so no cell of an export
//               ever runs as a formula
//   parseCsv    the inverse (quoted fields, doubled quotes, CRLF), for the verifier
//   ChainExport the JSON export of one chain of a world and epoch: the verification header (result,
//               head hash, the published key, unanchored and conflicting `seq`), every anchor with
//               its stream and `ingestionTime`, and every entry as stored. The CSV carries the same:
//               one `meta` row, one row per anchor and one per entry, each with its JSON in `data`
import { z } from "zod";

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell: guarded against formulas and quoted when it needs it. */
export function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  const guarded = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) || guarded !== guarded.trim() ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** A CSV document with CRLF line ends (RFC 4180). */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n").concat("\r\n");
}

/** The rows of a CSV document, quotes resolved; the formula guard is kept (see `unguard`). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);
  return rows;
}

/** A cell as it was before the formula guard. */
export function unguard(cell: string): string {
  return cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell;
}

// ---- Chain export ----------------------------------------------------------------------------

export const EXPORT_FORMAT = "reclamo-chain-export/1";

export const ExportChain = z.enum(["REG", "RRI", "TAPE"]);
export type ExportChain = z.infer<typeof ExportChain>;

export const ExportHeader = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    worldId: z.string().min(1).max(24),
    epoch: z.number().int().nonnegative(),
    chain: ExportChain,
    result: z.enum(["ok", "partial", "broken"]),
    entries: z.number().int().nonnegative(),
    headHash: z.string().max(128).optional(),
    brokenAt: z.number().int().positive().optional(),
    unanchored: z.array(z.number().int().positive()),
    anchorConflicts: z.array(z.number().int().positive()),
    foreignAnchors: z.number().int().nonnegative(),
    /** The published `RegisterChainKey` (ADR-0014): with it anyone recomputes every hash. */
    key: z.string().min(1),
    exportedAtReal: z.string().min(1).max(40),
  })
  .strict();
export type ExportHeader = z.infer<typeof ExportHeader>;

export const ExportAnchor = z
  .object({ stream: z.string().min(1).max(512), ingestionTime: z.number().int().nonnegative(), timestamp: z.number().int().optional(), message: z.string().max(4_096) })
  .strict();
export type ExportAnchor = z.infer<typeof ExportAnchor>;

const ExportEntry = z.looseObject({ seq: z.number().int().positive(), prevHash: z.string().max(128), hash: z.string().min(1).max(128) });
export type ExportEntry = z.infer<typeof ExportEntry>;

export const ChainExport = z.object({ header: ExportHeader, anchors: z.array(ExportAnchor), entries: z.array(ExportEntry) }).strict();
export type ChainExport = z.infer<typeof ChainExport>;

/** Columns of the CSV form: readable columns, then the full JSON of the row in `data`. */
export const EXPORT_COLUMNS = ["record", "chain", "seq", "atSim", "eventType", "complaintNumber", "status", "reason", "decision", "hash", "prevHash", "stream", "ingestionTime", "data"] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The CSV form of an export: a `meta` row, the anchors and the entries in `seq` order. */
export function chainExportCsv(file: ChainExport): string {
  const { header } = file;
  const meta = ["meta", header.chain, "", "", "", "", "", "", header.result, header.headHash ?? "", "", "", "", header];
  const anchors = file.anchors.map((anchor) => ["anchor", header.chain, "", "", "", "", "", "", "", "", "", anchor.stream, anchor.ingestionTime, anchor]);
  const entries = [...file.entries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => ["entry", header.chain, entry.seq, text(entry.atSim), text(entry.eventType), text(entry.complaintNumber), text(entry.status), text(entry.reason), text(entry.decision), entry.hash, entry.prevHash, "", "", entry]);
  return toCsv(EXPORT_COLUMNS, [meta, ...anchors, ...entries]);
}

/** The JSON form, stable for a hash. */
export function chainExportJson(file: ChainExport): string {
  return `${JSON.stringify(ChainExport.parse(file), null, 2)}\n`;
}

/** Reads either form back (the verifier); throws a ZodError or a RangeError on a malformed file. */
export function parseChainExport(content: string): ChainExport {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{")) return ChainExport.parse(JSON.parse(trimmed));
  const rows = parseCsv(content);
  const [columns, ...body] = rows;
  if (!columns || columns.join(",") !== EXPORT_COLUMNS.join(",")) throw new RangeError("not a chain export: unexpected columns");
  const dataAt = EXPORT_COLUMNS.indexOf("data");
  const json = (row: readonly string[]): unknown => JSON.parse(unguard(row[dataAt] ?? ""));
  const metas = body.filter((row) => row[0] === "meta");
  if (metas.length !== 1 || !metas[0]) throw new RangeError("a chain export has exactly one meta row");
  return ChainExport.parse({
    header: json(metas[0]),
    anchors: body.filter((row) => row[0] === "anchor").map(json),
    entries: body.filter((row) => row[0] === "entry").map(json),
  });
}
