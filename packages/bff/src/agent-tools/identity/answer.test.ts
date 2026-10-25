import { describe, expect, it } from "vitest";
import { CHALLENGE_PROMPT, WHATSAPP_TEXT } from "../../copy";
import { ChallengeKind } from "../../copy/types";
import { amountsIn, datesIn, writtenFragment } from "./answer";

describe("[FL-003] the answer comes from what the customer wrote", () => {
  it("[FL-003] finds the dates a customer writes: d/m, dd/mm, with or without year, ISO and in words", () => {
    expect(datesIn("Es el 5/10")).toEqual([{ raw: "5/10", day: 5, month: 10 }]);
    expect(datesIn("05/10")).toMatchObject([{ day: 5, month: 10 }]);
    expect(datesIn("vence 05-10-2026, creo")).toMatchObject([{ day: 5, month: 10, year: 2026 }]);
    expect(datesIn("5.10.26")).toMatchObject([{ day: 5, month: 10, year: 2026 }]);
    expect(datesIn("2026-10-05")).toMatchObject([{ day: 5, month: 10, year: 2026 }]);
    expect(datesIn("el 5 de Octubre")).toMatchObject([{ day: 5, month: 10 }]);
    expect(datesIn("6 de oct. de 2026")).toMatchObject([{ day: 6, month: 10, year: 2026 }]);
    expect(datesIn("pagué $ 118.640 el R-2026-000123")).toEqual([]);
    expect(datesIn("31/13 y 0/5")).toEqual([]);
  });

  it("[FL-003] finds the amounts a customer writes in es-AR, never a date's numbers", () => {
    expect(amountsIn("$ 118.640,00")).toEqual([{ raw: "$ 118.640,00", cents: 11_864_000, withCents: true }]);
    expect(amountsIn("fueron 118640 pesos")).toMatchObject([{ cents: 11_864_000, withCents: false }]);
    expect(amountsIn("$45.000")).toMatchObject([{ cents: 4_500_000 }]);
    expect(amountsIn("el 5/10 pagué 1.500")).toMatchObject([{ cents: 150_000 }]);
  });

  it("[FL-003] states the customer's fragment for an answer they wrote, normalized", () => {
    expect(writtenFragment("LAST_DUE_DATE", "5/10", "Es el 05/10")).toBe("05/10");
    expect(writtenFragment("LAST_DUE_DATE", "05/10/2026", "me venció el 5-10-2026")).toBe("5-10-2026");
    expect(writtenFragment("LAST_DUE_DATE", "5 de octubre", "el 5/10")).toBe("5/10");
    expect(writtenFragment("LAST_DUE_DATE", "5/10", "05/10/2025")).toBe("05/10/2025");
    expect(writtenFragment("LAST_INSTALMENT_AMOUNT", "118640", "$ 118.640,00")).toBe("$ 118.640,00");
    expect(writtenFragment("LAST_MOVEMENT_AMOUNT", "$ 45.000", "45000")).toBe("45000");
    expect(writtenFragment("LAST_DUE_DATE", "no me acuerdo", "No me acuerdo.")).toBe("No me acuerdo.");
  });

  it("[FL-003] states nothing for an answer the customer did not write", () => {
    // The model's own value: the customer only greeted.
    expect(writtenFragment("LAST_DUE_DATE", "5/10", "hola")).toBeUndefined();
    // A different date, a year the customer never wrote, a substring of another date.
    expect(writtenFragment("LAST_DUE_DATE", "5/10", "el 15/10")).toBeUndefined();
    expect(writtenFragment("LAST_DUE_DATE", "5/10/2026", "el 5/10")).toBeUndefined();
    // Centavos the customer never wrote, another amount, two values in one answer.
    expect(writtenFragment("LAST_INSTALMENT_AMOUNT", "118640,50", "118640")).toBeUndefined();
    expect(writtenFragment("LAST_INSTALMENT_AMOUNT", "118640", "11864")).toBeUndefined();
    expect(writtenFragment("LAST_DUE_DATE", "5/10 o 6/10", "5/10")).toBeUndefined();
    // Free text only as a whole message, word for word.
    expect(writtenFragment("LAST_DUE_DATE", "no sé", "no sé si pagué")).toBeUndefined();
    expect(writtenFragment("LAST_DUE_DATE", "", "")).toBeUndefined();
  });

  it("[FL-003] a copy of a challenge prompt is never an answer: no prompt states a date or an amount", () => {
    for (const kind of ChallengeKind.options) {
      const prompt = WHATSAPP_TEXT[CHALLENGE_PROMPT[kind]];
      expect(datesIn(prompt), kind).toEqual([]);
      expect(amountsIn(prompt), kind).toEqual([]);
      expect(writtenFragment(kind, prompt, "hola"), kind).toBeUndefined();
    }
  });
});
