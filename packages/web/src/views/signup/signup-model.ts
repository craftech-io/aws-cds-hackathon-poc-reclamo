// Rules of `/signup` without React (docs/landing-spec.md §9.2, docs/architecture-guests.md §4): the
// empty form (both consent boxes unticked), the field errors the form shows before sending, the input
// `signup.start` gets (campaign and referrer only from the visit, never a datum of the person), what
// each answer does, and what survives the full reload a fresh firewall challenge needs (never the
// password). The BFF re-checks everything; these checks only spare the person a round trip.
import type { SignupStartInput, SignupStartResult } from "../../lib/auth/public-api";
import { looksLikeEmail, missingPasswordRules, hasOuterSpaces } from "../../lib/auth/credentials";
import type { Attribution } from "../landing/attribution";
import type { AuthLang } from "../login/auth-copy";

export interface SignupForm {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly acceptTerms: boolean;
  readonly acceptContact: boolean;
}

export const EMPTY_SIGNUP: SignupForm = { email: "", password: "", name: "", company: "", jobTitle: "", acceptTerms: false, acceptContact: false };

/** Longest optional text the BFF accepts (guests/schemas.ts `leadText(80)`). */
export const LEAD_TEXT_MAX = 80;

export type SignupField = "email" | "password" | "name" | "company" | "jobTitle" | "acceptTerms";
export type FieldErrorKey = "email" | "notAccepted" | "weakPassword" | "consent" | "plainText";
export type FieldErrors = Partial<Record<SignupField, FieldErrorKey>>;

/** The order the fields appear in: the first one with an error gets `role="alert"`. */
export const FIELD_ORDER: readonly SignupField[] = ["email", "password", "name", "company", "jobTitle", "acceptTerms"];

// The same refusal the BFF applies to a stranger's text (links, markup, control characters), so a
// lead notice can never carry a link: guests/schemas.ts.
const UNSAFE = /[<>\p{Cc}\p{Cf}]|:\/\/|\bwww\.|\bhttps?\b|\.(?:com|net|org|io|ar|ly|me|app|dev)\b/iu;

function unsafeText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > LEAD_TEXT_MAX || UNSAFE.test(trimmed);
}

export function validateSignup(form: SignupForm): FieldErrors {
  const errors: FieldErrors = {};
  if (!looksLikeEmail(form.email)) errors.email = "email";
  if (missingPasswordRules(form.password).length > 0 || hasOuterSpaces(form.password)) errors.password = "weakPassword";
  for (const field of ["name", "company"] as const) if (unsafeText(form[field])) errors[field] = "plainText";
  if (!form.acceptTerms) errors.acceptTerms = "consent";
  return errors;
}

export function firstErrorField(errors: FieldErrors): SignupField | undefined {
  return FIELD_ORDER.find((field) => errors[field] !== undefined);
}

/** What `signup.start` receives: the form, the language of the screen and the origin of the visit. */
export function startInputOf(form: SignupForm, locale: AuthLang, attribution: Attribution): SignupStartInput {
  const optional = (value: string) => (value.trim() === "" ? undefined : value.trim());
  const name = optional(form.name);
  const company = optional(form.company);
  const jobTitle = optional(form.jobTitle);
  return {
    email: form.email.trim(),
    password: form.password,
    ...(name !== undefined ? { name } : {}),
    ...(company !== undefined ? { company } : {}),
    ...(jobTitle !== undefined ? { jobTitle } : {}),
    acceptTerms: form.acceptTerms,
    acceptContact: form.acceptContact,
    locale,
    ...(attribution.utm !== undefined ? { utm: { ...attribution.utm } } : {}),
    ...(attribution.referrer !== undefined ? { referrer: attribution.referrer } : {}),
  };
}

export type StartOutcome =
  | { readonly kind: "codeSent"; readonly signupId: string }
  | { readonly kind: "fieldErrors"; readonly errors: FieldErrors }
  | { readonly kind: "taken" }
  | { readonly kind: "rateLimited" }
  | { readonly kind: "closed" };

/** What the screen does with each answer of `signup.start` (an unconfirmed earlier form is `CODE_SENT` too). */
export function startOutcome(answer: SignupStartResult): StartOutcome {
  switch (answer.status) {
    case "CODE_SENT":
      return { kind: "codeSent", signupId: answer.signupId };
    case "INVALID_EMAIL":
      return { kind: "fieldErrors", errors: { email: "email" } };
    case "EMAIL_NOT_ACCEPTED":
      return { kind: "fieldErrors", errors: { email: "notAccepted" } };
    case "WEAK_PASSWORD":
      return { kind: "fieldErrors", errors: { password: "weakPassword" } };
    case "CONSENT_REQUIRED":
      return { kind: "fieldErrors", errors: { acceptTerms: "consent" } };
    case "EMAIL_TAKEN":
      return { kind: "taken" };
    case "RATE_LIMITED":
      return { kind: "rateLimited" };
    case "SIGNUP_UNAVAILABLE":
      return { kind: "closed" };
  }
}

/** The fields a firewall reload keeps: everything but the password. */
export type SignupDraft = Omit<SignupForm, "password">;

export function draftOf(form: SignupForm): SignupDraft {
  const { password: _password, ...draft } = form;
  return draft;
}

/** A stored draft, re-checked: what comes back from storage is never trusted as written. */
export function formFromDraft(raw: unknown): SignupForm {
  if (typeof raw !== "object" || raw === null) return EMPTY_SIGNUP;
  const record = raw as Readonly<Record<string, unknown>>;
  const text = (key: keyof SignupDraft) => {
    const value = record[key];
    return typeof value === "string" ? value.slice(0, 254) : "";
  };
  return {
    ...EMPTY_SIGNUP,
    email: text("email"),
    name: text("name"),
    company: text("company"),
    jobTitle: text("jobTitle"),
    acceptTerms: record.acceptTerms === true,
    acceptContact: record.acceptContact === true,
  };
}
