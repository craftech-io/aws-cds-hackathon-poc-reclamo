import { describe, expect, it } from "vitest";
import type { SettlementLine } from "./networks";
import {
  SETTLEMENT_CSV_HEADER,
  SETTLEMENT_CSV_MAX_LINES,
  SettlementCsvError,
  centsToDecimal,
  decimalToCents,
  formatSettlementCsv,
  parseSettlementCsv,
} from "./settlement-csv";

// The sample line of docs/architecture-integrations.md §6.1.
const SAMPLE = "NORTE;2026-10-07;NTE-20261006-004817-7;2026-10-06T18:40:00-03:00;118640.00;cus-0001;L-0001;4;T-0412";
const OTHER_PAYER = "NORTE;2026-10-07;NTE-20261006-004901-3;2026-10-06T19:02:00-03:00;52300.50;cus-1017;L-1017;2;T-0077";

const line: SettlementLine = {
  network: "NORTE",
  businessDate: "2026-10-07",
  operationCode: "NTE-20261006-004817-7",
  paidAt: "2026-10-06T18:40:00-03:00",
  amount: 11864000,
  customerRef: "cus-0001",
  loanRef: "L-0001",
  instalment: 4,
  terminal: "T-0412",
};

const file = (...rows: string[]) => `${[SETTLEMENT_CSV_HEADER, ...rows].join("\n")}\n`;

function failure(text: string, expected = {}): SettlementCsvError {
  try {
    parseSettlementCsv(text, expected);
  } catch (error) {
    if (error instanceof SettlementCsvError) return error;
    throw error;
  }
  throw new Error("expected the file to be refused");
}

describe("amounts", () => {
  it("convert between centavos and pesos with two decimals without floating point", () => {
    expect(centsToDecimal(11864000)).toBe("118640.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(decimalToCents("118640.00")).toBe(11864000);
    expect(decimalToCents("52300.50")).toBe(5230050);
    expect(decimalToCents("0.10")).toBe(10);
  });

  it("refuse any other notation", () => {
    for (const text of ["118640", "118640.0", "118.640,00", "-1.00", "1e3.00", " 1.00"]) expect(decimalToCents(text), text).toBeUndefined();
    expect(() => centsToDecimal(1.5)).toThrow(RangeError);
    expect(() => centsToDecimal(-1)).toThrow(RangeError);
  });
});

describe("parseSettlementCsv", () => {
  it("reads the documented line and payers that are not personas", () => {
    expect(parseSettlementCsv(file(SAMPLE, OTHER_PAYER))).toEqual([
      line,
      { ...line, operationCode: "NTE-20261006-004901-3", paidAt: "2026-10-06T19:02:00-03:00", amount: 5230050, customerRef: "cus-1017", loanRef: "L-1017", instalment: 2, terminal: "T-0077" },
    ]);
  });

  it("reads an empty batch and a file without the final newline", () => {
    expect(parseSettlementCsv(`${SETTLEMENT_CSV_HEADER}\n`)).toEqual([]);
    expect(parseSettlementCsv(`${SETTLEMENT_CSV_HEADER}\n${SAMPLE}`)).toEqual([line]);
  });

  it("round-trips with formatSettlementCsv byte for byte", () => {
    const text = file(SAMPLE, OTHER_PAYER);
    expect(formatSettlementCsv(parseSettlementCsv(text))).toBe(text);
  });

  it("checks the batch it was asked for", () => {
    expect(parseSettlementCsv(file(SAMPLE), { network: "NORTE", businessDate: "2026-10-07" })).toHaveLength(1);
    expect(failure(file(SAMPLE), { network: "SUR" }).message).toBe("line 2: network of another batch");
    expect(failure(file(SAMPLE), { businessDate: "2026-10-08" }).message).toBe("line 2: business date of another batch");
  });

  it("refuses the whole file at the first bad line, with its number", () => {
    const cases: Array<[string, string]> = [
      [`﻿${file(SAMPLE)}`, "line 1: byte order mark not allowed"],
      [file(SAMPLE).replaceAll("\n", "\r\n"), "line endings must be LF"],
      [`network;businessDate\n${SAMPLE}\n`, "line 1: unexpected header"],
      [file(SAMPLE, "NORTE;2026-10-07;x"), "line 3: expected 9 fields, got 3"],
      [file(SAMPLE.replace("118640.00", "118640.0")), "line 2: amount must be pesos with two decimals"],
      [file(SAMPLE.replace(";4;", ";cuatro;")), "line 2: instalment must be an integer"],
      [file(SAMPLE.replace("NORTE;", "OESTE;")), "line 2: invalid network"],
      [file(SAMPLE.replace("cus-0001", "0001")), "line 2: invalid customerRef"],
      [file(SAMPLE, ""), "line 3: expected 9 fields, got 1"],
      [file(SAMPLE, SAMPLE), "line 3: operation code repeated in the file"],
    ];
    for (const [text, message] of cases) expect(failure(text).message, message).toBe(message);
  });

  it("refuses files over the line and size limits", () => {
    const rows = Array.from({ length: SETTLEMENT_CSV_MAX_LINES + 1 }, (_, index) => SAMPLE.replace("004817-7", `${String(index).padStart(6, "0")}-1`));
    expect(failure(file(...rows)).message).toBe(`more than ${SETTLEMENT_CSV_MAX_LINES} lines`);
    expect(failure(`${SETTLEMENT_CSV_HEADER}\n${"x".repeat(1_048_577)}`).message).toBe("file larger than 1 MB");
  });
});

describe("formatSettlementCsv", () => {
  it("validates every line before writing", () => {
    expect(() => formatSettlementCsv([{ ...line, amount: 0 }])).toThrow();
    expect(formatSettlementCsv([])).toBe(`${SETTLEMENT_CSV_HEADER}\n`);
  });
});
