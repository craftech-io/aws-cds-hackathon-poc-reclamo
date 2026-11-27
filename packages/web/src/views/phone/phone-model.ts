// Rules of the SMS-code screen without React (docs/architecture-guests.md §17, FL-129, FL-130): the
// answers of `phone.status`, `phone.sendCode` and `phone.verify` parsed at the edge, which step each
// status opens (enrol a number, or the code of this sign-in), the resend countdown, and the fixed text
// of every refusal. The BFF decides everything; this only shows it.
import { z } from "zod";
import type { AuthCopy } from "../login/auth-copy";

export const PhoneStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("PASSED") }),
  z.object({ state: z.literal("EXEMPT") }),
  z.object({ state: z.literal("ENROL"), phone: z.string().optional(), codeSent: z.boolean(), resendAvailableAtReal: z.string().optional() }),
  z.object({ state: z.literal("SIGN_IN"), lastDigits: z.string().regex(/^\d{4}$/), codeSent: z.boolean(), resendAvailableAtReal: z.string().optional() }),
]);
export type PhoneStatus = z.infer<typeof PhoneStatus>;

export const SendCodeAnswer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("CODE_SENT"), purpose: z.enum(["ENROL", "SIGN_IN"]), lastDigits: z.string(), resendAvailableAtReal: z.string() }),
  z.object({ status: z.literal("RESEND_TOO_SOON"), resendAvailableAtReal: z.string() }),
  z.object({ status: z.literal("RATE_LIMITED"), limit: z.enum(["ACCOUNT", "NUMBER", "IP", "GLOBAL"]) }),
  z.object({ status: z.enum(["INVALID_PHONE", "PHONE_IN_USE", "PHONE_LOCKED", "SMS_FAILED", "NOT_REQUIRED"]) }),
]);
export type SendCodeAnswer = z.infer<typeof SendCodeAnswer>;

export const VerifyAnswer = z.union([
  z.object({ status: z.literal("CODE_MISMATCH"), attemptsLeft: z.number().int().nonnegative() }),
  z.object({ status: z.enum(["VERIFIED", "NOT_REQUIRED", "NO_CODE", "CODE_EXPIRED", "PHONE_IN_USE"]) }),
]);
export type VerifyAnswer = z.infer<typeof VerifyAnswer>;

/** The console opens: the session passed the code, or the account is automation. */
export function passed(status: PhoneStatus): boolean {
  return status.state === "PASSED" || status.state === "EXEMPT";
}

/** Whole seconds until another code may be asked for (0 = now). */
export function secondsUntil(atReal: string | undefined, now: number): number {
  if (atReal === undefined) return 0;
  return Math.max(0, Math.ceil((Date.parse(atReal) - now) / 1_000));
}

/** A refusal shown under the form, or nothing. `contact` adds the "contact us" link. */
export interface PhoneProblem {
  readonly text: string;
  readonly contact: boolean;
}

type Errors = AuthCopy["phone"]["errors"];

export function sendProblem(answer: SendCodeAnswer, errors: Errors): PhoneProblem | undefined {
  switch (answer.status) {
    case "CODE_SENT":
    case "NOT_REQUIRED":
      return undefined;
    case "RESEND_TOO_SOON":
      return { text: errors.tooSoon, contact: false };
    case "RATE_LIMITED":
      return answer.limit === "ACCOUNT" ? { text: errors.accountLimit, contact: true } : { text: errors.rateLimited, contact: true };
    case "INVALID_PHONE":
      return { text: errors.invalidPhone, contact: false };
    case "PHONE_IN_USE":
      return { text: errors.phoneInUse, contact: true };
    case "PHONE_LOCKED":
      return { text: errors.locked, contact: true };
    case "SMS_FAILED":
      return { text: errors.smsFailed, contact: true };
  }
}

export function verifyProblem(answer: VerifyAnswer, errors: Errors): PhoneProblem | undefined {
  switch (answer.status) {
    case "VERIFIED":
    case "NOT_REQUIRED":
      return undefined;
    case "CODE_MISMATCH":
      return { text: answer.attemptsLeft === 0 ? errors.burnt : errors.mismatch(answer.attemptsLeft), contact: false };
    case "CODE_EXPIRED":
      return { text: errors.expired, contact: false };
    case "NO_CODE":
      return { text: errors.noCode, contact: false };
    case "PHONE_IN_USE":
      return { text: errors.phoneInUse, contact: true };
  }
}

/** Six digits, whatever the person pasted around them. */
export function codeOf(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 6 ? digits : undefined;
}
