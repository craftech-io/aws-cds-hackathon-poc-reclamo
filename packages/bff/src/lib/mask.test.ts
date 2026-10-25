import { describe, expect, it } from "vitest";
import { type MaskLabel, containsCard, luhnValid, maskLabels, maskSensitive } from "./mask";

// Synthetic values only: the card numbers are the public test numbers of the card networks.
describe("maskSensitive [FL-059]", () => {
  it("masks each kind of sensitive value with its token", () => {
    expect(maskSensitive("mi dni es 30.123.456")).toBe("mi dni es [DNI]");
    expect(maskSensitive("dni 30123456 gracias")).toBe("dni [DNI] gracias");
    expect(maskSensitive("el reintegro de $ 1.500.000 no llegó")).toBe("el reintegro de $ 1.500.000 no llegó");
    expect(maskSensitive("me cobraron $1.180.640,00 y 1.180.640,00 otra vez")).toBe("me cobraron $1.180.640,00 y 1.180.640,00 otra vez");
    expect(maskSensitive("CUIT 20-30123456-7")).toBe("CUIT [CUIT]");
    expect(maskSensitive("cuil 20301234567")).toBe("cuil [CUIT]");
    expect(maskSensitive("CVU 0000003100000000000001")).toBe("CVU [CBU]");
    expect(maskSensitive("tarjeta 4111 1111 1111 1111")).toBe("tarjeta [TARJETA]");
    expect(maskSensitive("escribime a cliente.c01@example.test")).toBe("escribime a [EMAIL]");
    expect(maskSensitive("mi cel +54 9 11 0000-1001")).toBe("mi cel [TELEFONO]");
    expect(maskSensitive("llamame al 11 0000 1001")).toBe("llamame al [TELEFONO]");
  });

  it("masks numbers grouped with spaces, dots or dashes", () => {
    expect(maskSensitive("mi CBU es 0110 5995 2000 0012 3456 78")).toBe("mi CBU es [CBU]");
    expect(maskSensitive("CBU 0110.5995.2000.0012.3456.78 ok")).toBe("CBU [CBU] ok");
    expect(maskSensitive("cvu 0000003100-0000000000001")).toBe("cvu [CBU]");
    expect(maskSensitive("dni 30 123 456")).toBe("dni [DNI]");
    expect(maskSensitive("dni 7 123 456 y listo")).toBe("dni [DNI] y listo");
    expect(maskSensitive("tarjeta 4111.1111.1111.1111")).toBe("tarjeta [TARJETA]");
    expect(maskSensitive("cuit 20 30123456 7")).toBe("cuit [CUIT]");
    expect(maskSensitive("cuit 20.30123456.7")).toBe("cuit [CUIT]");
    expect(maskSensitive("CUIT 20-30.123.456-7")).toBe("CUIT [CUIT]");
    expect(maskSensitive("cuit 20 30.123.456 7")).toBe("cuit [CUIT]");
  });

  it("reads every Unicode space as a space and allows ' - ' and repeated separators between groups", () => {
    for (const space of ["\u00a0", "\u202f", "\u2009", "\u3000"]) {
      const group = (...parts: string[]) => parts.join(space);
      expect(maskSensitive(`tarjeta ${group("4111", "1111", "1111", "1111")}`), JSON.stringify(space)).toBe("tarjeta [TARJETA]");
      expect(maskSensitive(`cbu ${group("0110", "5995", "2000", "0012", "3456", "78")}`), JSON.stringify(space)).toBe("cbu [CBU]");
      expect(maskSensitive(`dni ${group("30", "123", "456")}`), JSON.stringify(space)).toBe("dni [DNI]");
      expect(maskSensitive(`cuit ${group("20", "30123456", "7")}`), JSON.stringify(space)).toBe("cuit [CUIT]");
    }
    expect(maskSensitive("cbu 0110 - 5995 - 2000 - 0012 - 3456 - 78")).toBe("cbu [CBU]");
    expect(maskSensitive("tarjeta 4111  1111  1111  1111")).toBe("tarjeta [TARJETA]");
    expect(maskSensitive("tarjeta 4111 - 1111 - 1111 - 1111")).toBe("tarjeta [TARJETA]");
    expect(maskSensitive("dni 30  123  456")).toBe("dni [DNI]");
    expect(maskSensitive("CUIT 20 - 30123456 - 7")).toBe("CUIT [CUIT]");
    expect(maskSensitive("pagué $\u00a01.500.000 el 22/10")).toBe("pagué $ 1.500.000 el 22/10");
  });

  it("finds the card at a group boundary when a CVV or an expiry is glued to it", () => {
    expect(maskSensitive("tarjeta 4111 1111 1111 1111 123")).toBe("tarjeta [TARJETA]");
    expect(maskSensitive("tarjeta 4111111111111111 123")).toBe("tarjeta [TARJETA]");
    expect(maskSensitive("tarjeta 4111-1111-1111-1111 12 27")).toBe("tarjeta [TARJETA]");
    expect(maskSensitive("tarjeta 4111 1111 1111 1111 1234 gracias")).toBe("tarjeta [TARJETA] gracias");
    expect(maskSensitive("ref 12 4111 1111 1111 1111")).toBe("ref 12 [TARJETA]");
    expect(maskSensitive("dos 4111 1111 1111 1111 5500 0000 0000 0004")).toBe("dos [TARJETA] [TARJETA]");
    expect(maskSensitive("operación 4509 9535 6623 3705 123")).toBe("operación 4509 9535 6623 3705 123");
    expect(containsCard("tarjeta 4111 1111 1111 1111 123")).toBe(true);
    expect(containsCard("tarjeta 4111\u00a01111\u00a01111\u00a01111")).toBe(true);
    expect(containsCard("CBU 4111 1111 1111 1111 0000 00")).toBe(false);
  });

  it("never masks a slice of a longer grouped number as something shorter", () => {
    expect(maskSensitive("cuit 20 30123456 7")).not.toContain("[DNI]");
    expect(maskSensitive("CBU 4111 1111 1111 1111 0000 00")).toBe("CBU [CBU]");
  });

  it("masks a secret written next to clave, PIN or código, and keeps the word", () => {
    expect(maskSensitive("mi clave es 4821")).toBe("mi clave es [CLAVE]");
    expect(maskSensitive("el PIN: 123456")).toBe("el PIN: [CLAVE]");
    expect(maskSensitive("el código de verificación es 998877")).toBe("el código de verificación es [CLAVE]");
  });

  it("leaves amounts, dates, ids and complaint numbers alone", () => {
    const text = "pagué $ 118.640,00 el 22/10 en la cuota 3; reclamo R-2026-000123, operación NTE-20261022-004411";
    expect(maskSensitive(text)).toBe(text);
  });

  it("does not take a non-Luhn run of digits for a card", () => {
    expect(maskSensitive("referencia 4111 1111 1111 1112")).not.toContain("[TARJETA]");
  });
});

describe("cards", () => {
  it("checks Luhn and detects a full card in free text", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(containsCard("te paso la tarjeta 5500-0000-0000-0004 para que me cobren")).toBe(true);
    expect(containsCard("mi reclamo es R-2026-000123")).toBe(false);
  });
});

describe("local phone numbers, only on request [FL-121]", () => {
  const LOCAL = new Set<MaskLabel>(["LOCAL_PHONE"]);

  it("[FL-121] masks 8 to 15 digits with spaces or dashes when asked, counted as TELEFONO", () => {
    expect(maskLabels("0351 456-7890", LOCAL)).toEqual({ text: "[TELEFONO]", counts: { TELEFONO: 1 } });
    expect(maskLabels("llamá al 45678901 o al 011 4567 8901 234", LOCAL).text).toBe("llamá al [TELEFONO] o al [TELEFONO]");
    expect(maskLabels("1234567", LOCAL).text).toBe("1234567");
  });

  it("[FL-121] leaves dates, complaint numbers, amounts and ids alone", () => {
    for (const text of ["2026-10-09", "09-10-2026", "R-2026-000123", "2026-000123", "$ 15000000", "1.500.000", "1.180.640,00", "op-12345678", "#12345678"]) {
      expect(maskLabels(text, LOCAL).text, text).toBe(text);
    }
  });

  it("[FL-121] is never part of the default masking, so logs keep their ids and counters", () => {
    expect(maskSensitive("ref 0351 456-7890")).toBe("ref 0351 456-7890");
  });
});
