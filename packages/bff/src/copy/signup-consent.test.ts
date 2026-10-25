// The consent texts of the self-signup never change in place (FL-112): the stored version names
// exactly what the visitor saw.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signupCodeMail, recoveryCodeMail } from "./auth-mail";
import { CURRENT_SIGNUP_CONSENT, SIGNUP_CONSENT_VERSIONS } from "./signup-consent";

describe("signup consent texts [FL-112]", () => {
  it.each(Object.values(SIGNUP_CONSENT_VERSIONS))("keeps $version as published", (consent) => {
    const joined = [consent.terms.es, consent.terms.en, consent.contact.es, consent.contact.en].join("\n");
    expect(createHash("sha256").update(joined, "utf8").digest("hex")).toBe(consent.sha256);
  });

  it("names Craftech in the optional contact consent and links both legal pages in the required one", () => {
    expect(CURRENT_SIGNUP_CONSENT.contact.es).toContain("Craftech");
    for (const text of Object.values(CURRENT_SIGNUP_CONSENT.terms)) {
      expect(text).toContain("{terms}");
      expect(text).toContain("{privacy}");
    }
  });

  it("writes every auth email in both languages with the code", () => {
    for (const locale of ["es", "en"] as const) {
      expect(signupCodeMail(locale).html).toContain("{####}");
      expect(recoveryCodeMail(locale).html).toContain("{####}");
    }
  });
});
