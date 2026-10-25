// Edges of the public procedures (docs/architecture-guests.md §4): every input is zod `.strict()`,
// and every free text a stranger writes (name, company, role, UTM, referrer) is refused when it
// could turn the lead notice into a phishing mail for Craftech: no URL, no `://`, no `<` or `>`, no
// line break and no control character. Answers are data, never errors: the console shows a fixed
// text per status (docs/landing-spec.md §9).
import { z } from "zod";
import { EMAIL_MAX_LENGTH } from "./email-domain";

export const Locale = z.enum(["es", "en"]);
export type Locale = z.infer<typeof Locale>;

// \p{Cc}: control characters, line breaks included; \p{Cf}: invisible format characters.
const UNSAFE = /[<>\p{Cc}\p{Cf}]|:\/\/|\bwww\.|\bhttps?\b|\.(?:com|net|org|io|ar|ly|me|app|dev)\b/iu;

/** A short text a visitor typed, safe to put in a plain-text email. */
export function leadText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !UNSAFE.test(value), "links, markup and control characters are not accepted");
}

export const Utm = z
  .object({
    source: leadText(100).optional(),
    medium: leadText(100).optional(),
    campaign: leadText(100).optional(),
    term: leadText(100).optional(),
    content: leadText(100).optional(),
  })
  .strict();
export type Utm = z.infer<typeof Utm>;

/** Only an origin (`https://host[:port]`), never a path or a query. */
export const Referrer = z
  .string()
  .max(200)
  .regex(/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i, "only the origin of the referrer");

/** The pool's policy (infra/auth.ts): 12 characters, upper and lower case and a digit, no outer spaces. */
export function passwordProblem(password: string): boolean {
  return [...password].length < 12 || !/\p{Ll}/u.test(password) || !/\p{Lu}/u.test(password) || !/\d/.test(password) || password !== password.trim();
}

const Email = z.string().min(3).max(EMAIL_MAX_LENGTH);
const Password = z.string().min(1).max(256);
const Code = z.string().trim().regex(/^\d{6}$/, "a six-digit code");
/** 128 random bits in base32 (26 characters), from `signup.start`. */
export const SignupId = z.string().regex(/^[a-z2-7]{26}$/);

export const SignupStartInput = z
  .object({
    email: Email,
    password: Password,
    name: leadText(80).optional(),
    company: leadText(80).optional(),
    jobTitle: leadText(80).optional(),
    // `true` only: an unticked box is a refusal the procedure answers with CONSENT_REQUIRED.
    acceptTerms: z.boolean(),
    acceptContact: z.boolean(),
    locale: Locale,
    utm: Utm.optional(),
    referrer: Referrer.optional(),
  })
  .strict();
export type SignupStartInput = z.infer<typeof SignupStartInput>;

export const SignupConfirmInput = z.object({ signupId: SignupId, code: Code }).strict();
export const SignupResendInput = z.object({ signupId: SignupId }).strict();
export const PasswordForgotInput = z.object({ email: Email, locale: Locale }).strict();
export const PasswordResetInput = z.object({ email: Email, code: Code, newPassword: Password, locale: Locale.optional() }).strict();

export type SignupStartResult =
  | { readonly status: "CODE_SENT"; readonly signupId: string }
  | { readonly status: "EMAIL_TAKEN" | "INVALID_EMAIL" | "EMAIL_NOT_ACCEPTED" | "WEAK_PASSWORD" | "CONSENT_REQUIRED" | "RATE_LIMITED" | "SIGNUP_UNAVAILABLE" };

export type SignupConfirmResult =
  | { readonly status: "CONFIRMED"; readonly worldStatus: string; readonly email: string }
  | { readonly status: "CODE_MISMATCH" | "CODE_EXPIRED" | "SIGNUP_RESTART" | "RATE_LIMITED" };

export type SignupResendResult = { readonly status: "CODE_SENT" | "RATE_LIMITED" };

export type PasswordForgotResult = { readonly status: "CODE_SENT_IF_EXISTS" | "RATE_LIMITED" };

export type PasswordResetResult = { readonly status: "PASSWORD_CHANGED" | "CODE_MISMATCH" | "CODE_EXPIRED" | "WEAK_PASSWORD" | "RATE_LIMITED" };

export type SignupAvailability = { readonly status: "open" | "closed" };
