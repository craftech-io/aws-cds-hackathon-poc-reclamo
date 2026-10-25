// Texts of the public access screens (docs/landing-spec.md §9): `/login`, `/signup`, `/signup/verify`,
// `/signup/provisioning`, `/login/recover` and `/login/recover/reset`, in Spanish and English with a
// switch (CLAUDE.md, "Idiomas"). The consents come from the BFF's versioned texts
// (copy/signup-consent.ts), so what is stored with a lead is what the form showed. The staff-only
// steps of the sign-in (new password, TOTP) and the console's step-up keep views/login/copy.ts.
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import type { PasswordRule } from "../../lib/auth/credentials";
import { AUTH_EN } from "./auth-copy-en";
import { AUTH_ES } from "./auth-copy-es";

export type AuthLang = "es" | "en";

/** A sentence with one value in bold: `before` **value** `after`. */
export interface Framed {
  readonly before: string;
  readonly after: string;
}

export interface AuthCopy {
  readonly meta: { readonly code: AuthLang; readonly title: string };
  readonly lang: { readonly label: string; readonly switchTo: string; readonly short: string };
  readonly panel: { readonly tagline: string; readonly title: string; readonly lead: string; readonly points: readonly string[] };
  readonly legal: { readonly privacy: string; readonly terms: string };
  readonly common: { readonly working: string; readonly loading: string; readonly rateLimited: string; readonly challengeFailed: string; readonly network: string };
  readonly login: {
    readonly title: string;
    readonly lead: string;
    readonly username: string;
    readonly password: string;
    readonly submit: string;
    readonly forgot: string;
    readonly noAccount: string;
    readonly tryIt: string;
    readonly confirmed: string;
    readonly passwordChanged: string;
    readonly sessionExpired: string;
    readonly back: string;
  };
  readonly errors: Readonly<Record<AuthFlowErrorCode, string>>;
  readonly password: {
    readonly show: string;
    readonly hide: string;
    readonly rulesTitle: string;
    readonly rules: Readonly<Record<PasswordRule, string>>;
    readonly confirm: string;
    readonly mismatch: string;
  };
  readonly signup: {
    readonly title: string;
    readonly lead: string;
    readonly email: string;
    readonly password: string;
    readonly name: string;
    readonly company: string;
    readonly role: string;
    readonly rolePlaceholder: string;
    readonly roles: readonly string[];
    readonly consentTerms: string;
    readonly consentContact: string;
    readonly termsLink: string;
    readonly privacyLink: string;
    readonly submit: string;
    readonly haveAccount: string;
    readonly signIn: string;
    readonly synthetic: string;
    readonly restart: string;
    readonly errors: {
      readonly email: string;
      readonly notAccepted: string;
      readonly taken: string;
      readonly takenSignIn: string;
      readonly takenOr: string;
      readonly takenRecover: string;
      readonly weakPassword: string;
      readonly consent: string;
      readonly plainText: string;
      readonly failed: string;
    };
    readonly closed: { readonly title: string; readonly talk: string };
  };
  readonly verify: {
    readonly title: string;
    readonly lead: Framed;
    readonly code: string;
    readonly submit: string;
    readonly resend: string;
    readonly resendIn: (seconds: number) => string;
    readonly resent: string;
    readonly mismatch: string;
    readonly expired: string;
    readonly failed: string;
    readonly signingIn: string;
    readonly otherEmail: string;
  };
  readonly provisioning: {
    readonly preparingTitle: string;
    readonly preparingLead: string;
    readonly queued: Framed;
    readonly creating: string;
    readonly slow: string;
    readonly expiredTitle: string;
    readonly expiredLead: string;
    readonly expiredButton: string;
    readonly meanwhile: string;
    readonly usageLimit: string;
    readonly signOut: string;
  };
  readonly recover: {
    readonly title: string;
    readonly lead: string;
    readonly email: string;
    readonly submit: string;
    readonly neutral: string;
    readonly resetTitle: string;
    readonly resetLead: string;
    readonly code: string;
    readonly newPassword: string;
    readonly confirmPassword: string;
    readonly save: string;
    readonly mismatch: string;
    readonly expired: string;
    readonly requestAgain: string;
    readonly sendFailed: string;
    readonly saveFailed: string;
  };
}

export const AUTH_COPY: Readonly<Record<AuthLang, AuthCopy>> = { es: AUTH_ES, en: AUTH_EN };

/** The consent sentence with its two links, split where `{terms}` and `{privacy}` go. */
export function consentParts(template: string): readonly [string, string, string] {
  const [before = "", rest = ""] = template.split("{terms}");
  const [middle = "", after = ""] = rest.split("{privacy}");
  return [before, middle, after];
}
