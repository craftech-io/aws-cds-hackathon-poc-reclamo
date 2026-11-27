// What the SMS code stores (docs/architecture-guests.md §17). In `Leads`, apart from the demo data
// because they hold a mobile number: the account's phone (`PHONEVER#<sub>`, enrolment pending or
// verified), the owner of a verified number (`PHONEOWNER#<phoneHash>`) and the last code sent
// (`PHONECODE#<sub>`, only its HMAC). In `Runtime`, without any number: the sessions that passed the
// code (`SECONDFACTOR#<sub>#<sessionHash>`). Every account has them: staff, invited guests and
// self-signups alike; only an automation account of a QA world is exempt (second-factor/gate.ts).
import { z } from "zod";
import { IsoInstant } from "@reclamo/shared";
import { Locale } from "../guests/schemas";
import { PhoneNumber } from "./phone-number";

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Sub = z.string().min(1).max(128);

export const AccountPhoneStatus = z.enum(["PENDING", "VERIFIED"]);

/** `PHONEVER#<sub>`: a self-signup writes it `PENDING` with the number of its form; enrolment makes it `VERIFIED`. */
export const AccountPhone = z.object({
  sub: Sub,
  status: AccountPhoneStatus,
  /** The number to verify (pending) or the verified one; a pending account may have none yet. */
  phone: PhoneNumber.optional(),
  phoneHash: Hash.optional(),
  /** The language of the account's SMS. */
  locale: Locale.optional(),
  verifiedAtReal: IsoInstant.optional(),
});
export type AccountPhone = z.infer<typeof AccountPhone>;

/** `PHONEOWNER#<phoneHash>`: one number, one account. */
export const PhoneOwner = z.object({ sub: Sub, atReal: IsoInstant });

export const CodePurpose = z.enum(["ENROL", "SIGN_IN"]);
export type CodePurpose = z.infer<typeof CodePurpose>;

/** `PHONECODE#<sub>`: the last code sent, bound to the session that asked for it. */
export const PhoneCode = z.object({
  sub: Sub,
  purpose: CodePurpose,
  sessionHash: Hash,
  phone: PhoneNumber,
  phoneHash: Hash,
  codeHash: Hash,
  attempts: z.number().int().nonnegative(),
  /** `OPEN` until it is used, or burnt by its last failed attempt. */
  state: z.enum(["OPEN", "USED", "BURNT"]),
  sentAtReal: IsoInstant,
  validUntilReal: IsoInstant,
});
export type PhoneCode = z.infer<typeof PhoneCode>;

/** `SECONDFACTOR#<sub>#<sessionHash>`: this sign-in session passed the code, until its session can live no longer. */
export const PassedSession = z.object({
  sub: Sub,
  passedAtReal: IsoInstant,
  validUntilReal: IsoInstant,
  /** Signed out: the pass no longer counts. */
  endedAtReal: IsoInstant.optional(),
});
export type PassedSession = z.infer<typeof PassedSession>;
