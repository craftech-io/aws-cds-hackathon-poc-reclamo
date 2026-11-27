// Rules of `/signup` without React (docs/landing-spec.md §9.2, docs/architecture-guests.md §4, §17): the
// empty form (both consent boxes unticked, the mobile required with its international prefix), the field errors the form shows before sending, the input
// `signup.start` gets (campaign and referrer only from the visit, never a datum of the person), what
// each answer does, and what survives the full reload a fresh firewall challenge needs (never the
// password). The BFF re-checks everything; these checks only spare the person a round trip.
import type { SignupStartInput, SignupStartResult } from "../../lib/auth/public-api";
import { looksLikeEmail, missingPasswordRules, hasOuterSpaces } from "../../lib/auth/credentials";
import type { Attribution } from "../landing/attribution";
import type { AuthLang } from "../login/auth-copy";
import { checkPhone, normalizePhone } from "@reclamo/bff/second-factor/phone-number";

export interface SignupForm {
  readonly email: string;
  readonly password: string;
  /** The mobile, with its international prefix (E.164 once spaces and dashes are dropped). */
  readonly phone: string;
  readonly name: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly acceptTerms: boolean;
  readonly acceptContact: boolean;
}

export const EMPTY_SIGNUP: SignupForm = { email: "", password: "", phone: "", name: "", company: "", jobTitle: "", acceptTerms: false, acceptContact: false };

/** Longest optional text the BFF accepts (guests/schemas.ts `leadText(80)`). */
export const LEAD_TEXT_MAX = 80;

export type SignupField = "email" | "password" | "phone" | "name" | "company" | "jobTitle" | "acceptTerms";
export type FieldErrorKey = "email" | "notAccepted" | "weakPassword" | "phone" | "notPersonal" | "countryNotAllowed" | "consent" | "plainText";
export type FieldErrors = Partial<Record<SignupField, FieldErrorKey>>;

/** The order the fields appear in: the first one with an error gets `role="alert"`. */
export const FIELD_ORDER: readonly SignupField[] = ["email", "password", "phone", "name", "company", "jobTitle", "acceptTerms"];

// The same refusal the BFF applies to a stranger's text (links, markup, control characters), so a
// lead notice can never carry a link: guests/schemas.ts.
const UNSAFE = /[<>\p{Cc}\p{Cf}]|:\/\/|\bwww\.|\bhttps?\b|\.(?:com|net|org|io|ar|ly|me|app|dev)\b/iu;

function unsafeText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > LEAD_TEXT_MAX || UNSAFE.test(trimmed);
}

const PHONE_ERROR = { INVALID_PHONE: "phone", PHONE_NOT_ACCEPTED: "notPersonal", PHONE_COUNTRY_NOT_ALLOWED: "countryNotAllowed" } as const satisfies Record<string, FieldErrorKey>;

export function validateSignup(form: SignupForm): FieldErrors {
  const errors: FieldErrors = {};
  if (!looksLikeEmail(form.email)) errors.email = "email";
  if (missingPasswordRules(form.password).length > 0 || hasOuterSpaces(form.password)) errors.password = "weakPassword";
  const phone = checkPhone(form.phone);
  if (!phone.ok) errors.phone = PHONE_ERROR[phone.reason];
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
    phone: normalizePhone(form.phone) ?? form.phone.trim(),
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
  | { readonly kind: "rateLimited" }
  | { readonly kind: "closed" };

/** What the screen does with each answer of `signup.start` (an address that already has an account is `CODE_SENT` too). */
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
    case "INVALID_PHONE":
      return { kind: "fieldErrors", errors: { phone: "phone" } };
    case "PHONE_NOT_ACCEPTED":
      return { kind: "fieldErrors", errors: { phone: "notPersonal" } };
    case "PHONE_COUNTRY_NOT_ALLOWED":
      return { kind: "fieldErrors", errors: { phone: "countryNotAllowed" } };
    case "CONSENT_REQUIRED":
      return { kind: "fieldErrors", errors: { acceptTerms: "consent" } };
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
    phone: text("phone").slice(0, 32),
    name: text("name"),
    company: text("company"),
    jobTitle: text("jobTitle"),
    acceptTerms: record.acceptTerms === true,
    acceptContact: record.acceptContact === true,
  };
}
