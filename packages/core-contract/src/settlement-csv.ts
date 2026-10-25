// Codec of a settlement file (docs/architecture-integrations.md §6.1): UTF-8 without BOM, `;` as
// separator, the fixed header, one payment per line, amounts in pesos with two decimals. The
// network mock writes it, the seed generates the historical ones, and reconciliation reads the
// published ones; reading is all-or-nothing: a file with one bad line proves nothing.
import { type CollectionNetwork, SettlementLine } from "./networks";

export const SETTLEMENT_CSV_HEADER = "network;businessDate;operationCode;paidAt;amount;customerRef;loanRef;instalment;terminal";
export const SETTLEMENT_CSV_MAX_LINES = 5000;
export const SETTLEMENT_CSV_MAX_BYTES = 1_048_576;

const AMOUNT = /^(\d{1,11})\.(\d{2})$/;
const INTEGER = /^\d{1,2}$/;

export class SettlementCsvError extends Error {
  override readonly name = "SettlementCsvError";
  /** 1-based line of the file (the header is line 1); 0 for the file as a whole. */
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(line === 0 ? message : `line ${line}: ${message}`);
  }
}

export interface ExpectedBatch {
  readonly network?: CollectionNetwork;
  readonly businessDate?: string;
}

/** "118640.00" for 11864000 centavos. */
export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`amount must be non-negative integer centavos, got ${cents}`);
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** 11864000 for "118640.00"; undefined for anything that is not pesos with exactly two decimals. */
export function decimalToCents(text: string): number | undefined {
  const match = AMOUNT.exec(text);
  if (!match) return undefined;
  return Number(match[1]) * 100 + Number(match[2]);
}

function parseLine(cells: readonly string[], lineNumber: number): SettlementLine {
  const [network, businessDate, operationCode, paidAt, amount, customerRef, loanRef, instalment, terminal] = cells;
  const cents = amount === undefined ? undefined : decimalToCents(amount);
  if (cents === undefined) throw new SettlementCsvError(lineNumber, "amount must be pesos with two decimals");
  if (instalment === undefined || !INTEGER.test(instalment)) throw new SettlementCsvError(lineNumber, "instalment must be an integer");
  const parsed = SettlementLine.safeParse({
    network,
    businessDate,
    operationCode,
    paidAt,
    amount: cents,
    customerRef,
    loanRef,
    instalment: Number(instalment),
    terminal,
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ");
    throw new SettlementCsvError(lineNumber, `invalid ${fields}`);
  }
  return parsed.data;
}

/** Parses a whole settlement file; throws `SettlementCsvError` at the first problem. */
export function parseSettlementCsv(text: string, expected: ExpectedBatch = {}): SettlementLine[] {
  if (new TextEncoder().encode(text).length > SETTLEMENT_CSV_MAX_BYTES) throw new SettlementCsvError(0, "file larger than 1 MB");
  if (text.startsWith("﻿")) throw new SettlementCsvError(1, "byte order mark not allowed");
  if (text.includes("\r")) throw new SettlementCsvError(0, "line endings must be LF");
  const rows = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (rows[0] !== SETTLEMENT_CSV_HEADER) throw new SettlementCsvError(1, "unexpected header");
  if (rows.length - 1 > SETTLEMENT_CSV_MAX_LINES) throw new SettlementCsvError(0, `more than ${SETTLEMENT_CSV_MAX_LINES} lines`);

  const seen = new Set<string>();
  const lines: SettlementLine[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const lineNumber = index + 2;
    const cells = row.split(";");
    if (cells.length !== 9) throw new SettlementCsvError(lineNumber, `expected 9 fields, got ${cells.length}`);
    const line = parseLine(cells, lineNumber);
    if (expected.network !== undefined && line.network !== expected.network) throw new SettlementCsvError(lineNumber, "network of another batch");
    if (expected.businessDate !== undefined && line.businessDate !== expected.businessDate) {
      throw new SettlementCsvError(lineNumber, "business date of another batch");
    }
    const key = `${line.network}#${line.operationCode}`;
    if (seen.has(key)) throw new SettlementCsvError(lineNumber, "operation code repeated in the file");
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

/** Writes a settlement file with a trailing newline; the lines are validated first. */
export function formatSettlementCsv(lines: readonly SettlementLine[]): string {
  const rows = lines.map((input) => {
    const line = SettlementLine.parse(input);
    return [
      line.network,
      line.businessDate,
      line.operationCode,
      line.paidAt,
      centsToDecimal(line.amount),
      line.customerRef,
      line.loanRef,
      String(line.instalment),
      line.terminal,
    ].join(";");
  });
  return `${[SETTLEMENT_CSV_HEADER, ...rows].join("\n")}\n`;
}
