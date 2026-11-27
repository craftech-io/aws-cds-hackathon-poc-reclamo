// The mobile number of an account (docs/architecture-guests.md §17): E.164, any country, `+` and 8 to
// 15 digits with no leading zero. What a person types (spaces, dashes, dots, brackets) is normalized
// before anything checks or stores it. The number is personal data: it lives only in `Leads` (the
// account's phone and the code it was sent), never in a key, a log line or an audit entry; keys carry
// its HMAC.
import { z } from "zod";
import { isFillerNumber, isNotPersonalNumber } from "./phone-ranges";

export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** The E.164 form of what was typed, or `undefined` when it is not one. */
export function normalizePhone(raw: string): string | undefined {
  const compact = raw.trim().replace(/[\s\-.()]/g, "");
  return E164_PATTERN.test(compact) ? compact : undefined;
}

export type PhoneVerdict = { readonly ok: true; readonly phone: string } | { readonly ok: false; readonly reason: "INVALID_PHONE" | "PHONE_NOT_ACCEPTED" };

/**
 * A number a person enters or corrects (the sign-up form, the enrolment): E.164 and not a filler
 * (`INVALID_PHONE`), and not a range that is no person's mobile (`PHONE_NOT_ACCEPTED`).
 */
export function checkPhone(raw: string): PhoneVerdict {
  const phone = normalizePhone(raw);
  if (phone === undefined || isFillerNumber(phone)) return { ok: false, reason: "INVALID_PHONE" };
  if (isNotPersonalNumber(phone)) return { ok: false, reason: "PHONE_NOT_ACCEPTED" };
  return { ok: true, phone };
}

/** An E.164 number as stored (already normalized). */
export const PhoneNumber = z.string().regex(E164_PATTERN, "an E.164 mobile number");

/** What a person may type in a phone field, before `normalizePhone` decides. */
export const PhoneField = z.string().min(1).max(32);

/** The last digits shown on the sign-in screen; the rest of a verified number never leaves the server. */
export function lastDigits(phone: string): string {
  return phone.slice(-4);
}
