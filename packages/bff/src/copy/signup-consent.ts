// Versioned texts of the two consents of the self-signup form (docs/landing-spec.md §9.2,
// docs/architecture-guests.md §4): accepting the terms and the privacy policy (required to create the
// account) and letting Craftech get in touch about this solution (optional). Both boxes start
// unticked. `signup.start` stores, per consent, the real instant and the `version` the visitor saw;
// the console renders these same strings, so what is stored is what was shown. A published version
// never changes: a new wording is a new version (copy/signup-consent.test.ts recomputes each hash).

export type SignupLocale = "es" | "en";

export interface SignupConsentTexts {
  readonly version: string;
  /** `{terms}` and `{privacy}` are where the console puts the links to /legal/terms.html and /legal/privacy.html. */
  readonly terms: Readonly<Record<SignupLocale, string>>;
  readonly contact: Readonly<Record<SignupLocale, string>>;
  /** SHA-256 (hex) of the four texts joined by "\n", in the order es terms, en terms, es contact, en contact. */
  readonly sha256: string;
}

export const SIGNUP_CONSENT_VERSIONS = {
  "signup-v1": {
    version: "signup-v1",
    terms: {
      es: "Acepto los {terms} y la {privacy}.",
      en: "I accept the {terms} and the {privacy}.",
    },
    contact: {
      es: "Craftech puede contactarme sobre esta solución.",
      en: "Craftech may contact me about this solution.",
    },
    sha256: "656f62ccf4eb3e25a58469c986f7eaa0739542e4aa14fc46ae67d2dd64316ae4",
  },
} as const satisfies Readonly<Record<string, SignupConsentTexts>>;

export type SignupConsentVersion = keyof typeof SIGNUP_CONSENT_VERSIONS;

/** The version the form shows today. */
export const CURRENT_SIGNUP_CONSENT: SignupConsentTexts = SIGNUP_CONSENT_VERSIONS["signup-v1"];

/** Link texts of the terms consent, per language. */
export const SIGNUP_CONSENT_LINKS: Readonly<Record<SignupLocale, { readonly terms: string; readonly privacy: string }>> = {
  es: { terms: "Términos", privacy: "Política de privacidad" },
  en: { terms: "Terms", privacy: "Privacy Policy" },
};
