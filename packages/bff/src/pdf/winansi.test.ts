import { describe, expect, it } from "vitest";
import { charWidth, textWidth, wrapText } from "./metrics";
import { isWinAnsi, toWinAnsi, winAnsiBytes } from "./winansi";
import { pdfString, pdfTextString, writePdf, type PdfRow } from "./writer";

describe("toWinAnsi", () => {
  it("keeps the Spanish characters and the WinAnsi punctuation", () => {
    const text = "ñ Ñ á é í ó ú ü ¿ ¡ • · — – … “ ” ‘ ’ € «»";
    expect(toWinAnsi(text)).toBe(text);
  });

  it("maps symbols outside WinAnsi to their ASCII pair", () => {
    expect(toWinAnsi("≤ 3 ≥ 1 → ✓ ✗ ‐ ― − ′ ″")).toBe("<= 3 >= 1 -> OK X - - - ' \"");
  });

  it("drops emojis and format characters and folds the space they leave", () => {
    expect(toWinAnsi("hola 👋 che​!")).toBe("hola che!");
    expect(toWinAnsi("listo 👍🏽")).toBe("listo");
  });

  it("keeps the WinAnsi part of a compatibility decomposition", () => {
    expect(toWinAnsi("Erdős ﬁn Ａ1")).toBe("Erdos fin A1");
  });

  it("composes decomposed accents and turns no-break spaces, tabs and CR/LF into plain text", () => {
    expect(toWinAnsi("árbol y\tmás\r\nlínea")).toBe("árbol y más\nlínea");
  });

  it("produces only WinAnsi characters for any input", () => {
    const sample = "Ζ日本語 ∑ ∞ ★ 🙂 ĳ ŉ \u0007 ok";
    for (const char of toWinAnsi(sample).replaceAll("\n", "")) expect(isWinAnsi(char), char).toBe(true);
  });
});

describe("winAnsiBytes and PDF strings", () => {
  it("encodes the cp1252 range and refuses what is not WinAnsi", () => {
    expect(winAnsiBytes("ñ—•€")).toEqual([0xf1, 0x97, 0x95, 0x80]);
    expect(() => winAnsiBytes("≤")).toThrow(RangeError);
  });

  it("escapes parentheses and backslashes and writes high bytes in octal", () => {
    expect(pdfString("a(b)c\\ñ")).toBe("(a\\(b\\)c\\\\\\361)");
  });

  it("writes ASCII metadata as a literal and anything else as UTF-16BE with BOM", () => {
    expect(pdfTextString("Acuse de recibo")).toBe("(Acuse de recibo)");
    expect(pdfTextString("préstamo")).toBe("<FEFF0070007200E9007300740061006D006F>");
  });
});

describe("metrics", () => {
  it("has the Helvetica widths in code order and the base width for accented letters", () => {
    expect(charWidth(" ", "regular")).toBe(278);
    expect(charWidth("~", "regular")).toBe(584);
    expect(charWidth("~", "bold")).toBe(584);
    expect(charWidth("á", "regular")).toBe(charWidth("a", "regular"));
    expect(charWidth("Ñ", "bold")).toBe(charWidth("N", "bold"));
    expect(textWidth("abc", "mono", 10)).toBe(18);
  });

  it("wraps at spaces and breaks a word longer than the line", () => {
    expect(wrapText("uno dos tres", textWidth("uno dos", "regular", 10), "regular", 10)).toEqual(["uno dos", "tres"]);
    expect(wrapText("a".repeat(30), textWidth("a".repeat(10), "mono", 10), "mono", 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(10)]);
    expect(wrapText("", 100, "regular", 10)).toEqual([""]);
  });
});

describe("writePdf pagination", () => {
  const line = (text: string, extra: Partial<PdfRow> = {}): PdfRow => ({ runs: [{ text, x: 56, font: "regular", size: 10 }], height: 14, ...extra });
  const spec = (body: PdfRow[]) => ({ info: [["Title", "t"]] as const, header: [line("header")], footer: () => [line("footer")], body });

  it("moves a heading to the next page instead of leaving it last on a page", () => {
    const filler = Array.from({ length: 200 }, (_, index) => line(`row ${index}`));
    const plain = writePdf(spec(filler));
    const rowsPerPage = Math.floor(200 / plain.pageCount);
    const lastOnFirstPage = Buffer.from(plain.bytes).toString("latin1").split("endstream")[0]?.match(/\(row (\d+)\)/g)?.length ?? 0;
    expect(rowsPerPage).toBeGreaterThan(0);
    const body = [...filler.slice(0, lastOnFirstPage - 1), line("HEADING", { keepWithNext: true }), line("content")];
    const firstPage = Buffer.from(writePdf(spec(body)).bytes).toString("latin1").split("endstream")[0] ?? "";
    expect(firstPage).not.toContain("(HEADING)");
  });

  it("repeats header and footer on every page", () => {
    const { bytes, pageCount } = writePdf(spec(Array.from({ length: 120 }, (_, index) => line(`row ${index}`))));
    const raw = Buffer.from(bytes).toString("latin1");
    expect(pageCount).toBeGreaterThan(1);
    expect(raw.match(/\(header\) Tj/g)).toHaveLength(pageCount);
    expect(raw.match(/\(footer\) Tj/g)).toHaveLength(pageCount);
  });
});
