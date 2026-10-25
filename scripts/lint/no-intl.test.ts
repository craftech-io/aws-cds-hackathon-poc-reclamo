import { describe, expect, it } from "vitest";
import { findIntlUsages } from "./no-intl";

describe("no-intl", () => {
  it("flags Intl and toLocale* calls with their line", () => {
    const source = [
      "const a = new Intl.DateTimeFormat('es-AR');",
      "const b = date.toLocaleDateString('es-AR');",
      "const c = amount.toLocaleString();",
      "const d = text.toUpperCase();",
    ].join("\n");
    expect(findIntlUsages("gen.ts", source)).toEqual([
      { file: "gen.ts", line: 1 },
      { file: "gen.ts", line: 2 },
      { file: "gen.ts", line: 3 },
    ]);
  });

  it("ignores comments and identifiers that only contain the word", () => {
    const source = ["// never use Intl here", " * nor toLocaleString()", "const international = 1;", "const IntlFree = 2;"].join("\n");
    expect(findIntlUsages("gen.ts", source)).toEqual([]);
  });
});
