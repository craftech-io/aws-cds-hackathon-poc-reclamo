import { describe, expect, it } from "vitest";
import { spelledAmounts } from "./figure-text";
import { ungroundedFigures } from "./grounding";

// The turn's results as the verification reads them: tool outputs carry `{ amount, text }` and ids.
const RESULTS = [
  JSON.stringify({ complaintNumber: "R-2026-000001", refund: { amount: 2500, text: "$ 250.000,00" }, dueDate: "05/10/2026", instalment: 4 }),
  JSON.stringify({ operationCode: "OP-88213", charge: { amount: 2500, text: "$ 2.500,00" } }),
];
const NONE = { amounts: [], numbers: [], spelled: [] };
// A result that grounds $ 500 only: the probes below must not borrow it for a bigger figure.
const FIVE_HUNDRED = [JSON.stringify({ refund: { text: "$ 500,00" } })];

describe("grounding of outbound text", () => {
  it("passes a text whose amounts and long numbers all come from the results", () => {
    const text = "Tu reclamo R-2026-000001 está resuelto: te reintegramos $ 250.000,00 (cuota 4, vencía el 05/10/2026). Operación OP-88213, cargo de $ 2.500.";
    expect(ungroundedFigures(text, RESULTS)).toEqual(NONE);
    expect(ungroundedFigures("Te reintegramos $ 500,00, no te cobramos ni un peso más", FIVE_HUNDRED)).toEqual(NONE);
  });

  it("blocks an invented amount written without the sign, grouping or decimals", () => {
    expect(ungroundedFigures("Te reintegramos 3500 pesos hoy", RESULTS).amounts).toEqual(["3500"]);
    expect(ungroundedFigures("Te reintegramos ARS 3500 hoy", RESULTS).amounts).toEqual(["3500"]);
    expect(ungroundedFigures("Te reintegramos 3,5 mil pesos", RESULTS).amounts).toEqual(["3,5"]);
    expect(ungroundedFigures("Te reintegramos $3,500.00", RESULTS).amounts).toEqual(["3,500.00"]);
  });

  it("blocks a bare number of four or more digits no result shows", () => {
    expect(ungroundedFigures("Te reintegramos 3500 hoy", RESULTS)).toEqual({ ...NONE, numbers: ["3500"] });
    expect(ungroundedFigures("Tu reclamo es el R-2027-000009", RESULTS).numbers).toEqual(["2027", "000009"]);
    expect(ungroundedFigures("Código 12.345.678", RESULTS).amounts).toEqual(["12.345.678"]);
    expect(ungroundedFigures("cuota 12 de 36, a las 10:10", RESULTS)).toEqual(NONE);
  });

  it("reads thousands split by a space, NBSP, thin space, hidden character, apostrophe or underscore as one amount", () => {
    for (const text of [
      "Te reintegramos 3 500 pesos",
      "3 500 pesos",
      "3 500 pesos",
      "3 500 pesos",
      "3 500 pesos",
      "3​500 pesos",
      "3⁠500 pesos",
      "3'500 pesos",
      "3’500 pesos",
      "3_500 pesos",
    ]) {
      expect(ungroundedFigures(text, FIVE_HUNDRED), text).toEqual({ ...NONE, amounts: ["3500"] });
    }
    expect(ungroundedFigures("Te reintegramos 1 000 000,00", FIVE_HUNDRED).amounts).toEqual(["1000000,00"]);
    expect(ungroundedFigures("Te reintegramos 250 000,00", RESULTS)).toEqual(NONE);
  });

  it("reads fullwidth and other scripts' digits", () => {
    expect(ungroundedFigures("３５００ pesos", FIVE_HUNDRED).amounts).toEqual(["3500"]);
    expect(ungroundedFigures("٣٥٠٠ pesos", FIVE_HUNDRED).amounts).toEqual(["3500"]);
    expect(ungroundedFigures("३५०० pesos", FIVE_HUNDRED).amounts).toEqual(["3500"]);
    expect(ungroundedFigures("５００ pesos", FIVE_HUNDRED)).toEqual(NONE);
  });

  it("treats a number of any length next to another currency, slang or `en/de pesos` as an amount", () => {
    for (const text of ["999 dólares", "999 dolares", "USD 999", "U$S 999", "US$ 999", "999 en pesos", "999 de pesos", "999 lucas", "999k", "999 K", "5 palos", "999 mangos", "999 euros"]) {
      expect(ungroundedFigures(text, FIVE_HUNDRED).amounts, text).toHaveLength(1);
    }
    expect(ungroundedFigures("500 dólares", FIVE_HUNDRED).amounts).toEqual(["500"]);
    expect(ungroundedFigures("US$ 500", FIVE_HUNDRED).amounts).toEqual(["500"]);
    expect(ungroundedFigures("500 en pesos", FIVE_HUNDRED)).toEqual(NONE);
    expect(ungroundedFigures("5 kilos y 3 kilómetros", FIVE_HUNDRED)).toEqual(NONE);
  });

  it("reports amounts written in words so an amount-bearing message fails closed", () => {
    expect(ungroundedFigures("mil quinientos pesos", FIVE_HUNDRED).spelled).toEqual(["mil quinientos pesos"]);
    expect(ungroundedFigures("un millón de pesos", FIVE_HUNDRED).spelled).toEqual(["un millón de pesos"]);
    expect(ungroundedFigures("Te reintegramos quinientos pesos", FIVE_HUNDRED).spelled).toEqual(["quinientos pesos"]);
    expect(ungroundedFigures("son tres lucas", FIVE_HUNDRED).spelled).toEqual(["tres lucas"]);
    expect(ungroundedFigures("una luca", FIVE_HUNDRED).spelled).toEqual(["una luca"]);
    expect(ungroundedFigures("veinte dólares", FIVE_HUNDRED).spelled).toEqual(["veinte dólares"]);
    expect(ungroundedFigures("USD mil", FIVE_HUNDRED).spelled).toEqual(["USD mil"]);
    expect(ungroundedFigures("MIL QUINIENTOS PESOS", FIVE_HUNDRED).spelled).toEqual(["MIL QUINIENTOS PESOS"]);
    expect(ungroundedFigures("ｍｉｌ pesos", FIVE_HUNDRED).spelled).toEqual(["mil pesos"]);
    expect(ungroundedFigures("tres cuotas, un peso de diferencia, dos veces", FIVE_HUNDRED).spelled).toEqual([]);
  });

  it("never reads a pronoun before a figure with its sign as an amount written in words", () => {
    expect(spelledAmounts("Veo dos cargos: uno de $ 47.000,00 y otro de $ 273,49.")).toEqual([]);
    expect(spelledAmounts("uno de $47.000,00")).toEqual([]);
    expect(spelledAmounts("otro de US$ 20")).toEqual([]);
    expect(spelledAmounts("uno de $ mil")).not.toEqual([]);
    expect(spelledAmounts("son dos mil $")).toEqual(["dos mil $"]);
  });
});
