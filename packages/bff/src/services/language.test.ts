import { describe, expect, it } from "vitest";
import { detectLanguage, passesSpanishCheck } from "./language";

describe("language check of outbound texts (ADR-0012)", () => {
  it("recognises rioplatense Spanish, with or without accents", () => {
    expect(detectLanguage("Hola Valeria, ya registramos tu reclamo con el número R-2026-000001. Te respondemos por escrito en 10 días hábiles.")).toBe("SPANISH");
    expect(detectLanguage("Recibimos tu comprobante y lo estamos revisando con la red de cobro")).toBe("SPANISH");
    expect(detectLanguage("¿Querés que te mandemos la respuesta por email?")).toBe("SPANISH");
  });

  it("flags English, whatever the amounts and codes around it", () => {
    expect(detectLanguage("Your complaint R-2026-000001 has been registered and we will answer within 10 business days.")).toBe("NOT_SPANISH");
    expect(detectLanguage("Please send us the receipt of your payment of $ 118.640,00")).toBe("NOT_SPANISH");
    expect(passesSpanishCheck("Thanks for your message, we are looking into it.")).toBe(false);
  });

  it("does not decide on texts too short to tell", () => {
    expect(detectLanguage("R-2026-000001")).toBe("UNDETERMINED");
    expect(detectLanguage("OK")).toBe("UNDETERMINED");
    expect(detectLanguage("https://reclamo.demo.craftech.io $ 2.500,00")).toBe("UNDETERMINED");
    expect(passesSpanishCheck("Hablar con alguien")).toBe(true);
  });
});
