// What the `Leads` table stores (docs/architecture-guests.md §10), as zod schemas. The table is
// outside the demo data: no world factory, reset, register export, tape or metric reads it. The
// email of a lead is personal data: it lives only in the request and in the lead itself, never in a
// key, an index, a log line or an audit entry.
import { z } from "zod";
import { IsoInstant } from "@reclamo/shared";
import { Locale, Utm } from "../guests/schemas";

export const ConsentRecord = z.object({
  terms: z.object({ acceptedAtReal: IsoInstant, textVersion: z.string().min(1).max(40) }),
  contact: z.object({ accepted: z.boolean(), atReal: IsoInstant.optional(), textVersion: z.string().min(1).max(40) }),
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;

export const QaScopeRecord = z.object({ runId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(24), key: z.string().regex(/^su\d{1,3}$/) });

export const SignupStatus = z.enum(["STARTED", "CODE_SENT", "CONFIRMED", "SUPERSEDED", "ABANDONED"]);
export type SignupStatus = z.infer<typeof SignupStatus>;

const Contact = {
  email: z.string().min(3).max(254),
  name: z.string().max(80).optional(),
  company: z.string().max(80).optional(),
  jobTitle: z.string().max(80).optional(),
};

const Attribution = {
  locale: Locale,
  utm: Utm.optional(),
  referrer: z.string().max(200).optional(),
};

/** `SIGNUP#<signupId>`: one form sent to `signup.start`. */
export const SignupRequest = z.object({
  signupId: z.string().regex(/^[a-z2-7]{26}$/),
  status: SignupStatus,
  ...Contact,
  ...Attribution,
  consents: ConsentRecord,
  emailHash: z.string().regex(/^[0-9a-f]{64}$/),
  canonHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The app client the Bff signs up with (`GuestSignupClient`); the pre-sign-up trigger compares it. */
  clientId: z.string().min(1).max(128),
  /** Cognito `sub`, once `SignUp` answered (`CODE_SENT`). */
  sub: z.string().min(1).max(128).optional(),
  /** World the confirmation registers, computed by the Bff from the `sub` (the trigger holds no key). */
  worldId: z.string().min(1).max(48).optional(),
  qa: QaScopeRecord.optional(),
  startedAtReal: IsoInstant,
  /** A request is good for 48 real hours. */
  validUntilReal: IsoInstant,
});
export type SignupRequest = z.infer<typeof SignupRequest>;

/** `PENDING#<emailHash>`: the only request of an email that a confirmation may use. */
export const PendingPointer = z.object({ signupId: z.string().regex(/^[a-z2-7]{26}$/) });

/** `LEAD#<sub>`: a confirmed self-signup, a commercial lead of Craftech. */
export const Lead = z.object({
  sub: z.string().min(1).max(128),
  ...Contact,
  ...Attribution,
  consents: ConsentRecord,
  sourcePoc: z.string().min(1).max(40),
  emailHash: z.string().regex(/^[0-9a-f]{64}$/),
  worldId: z.string().min(1).max(48),
  signupAtReal: IsoInstant,
  confirmedAtReal: IsoInstant,
  lastLoginAtReal: IsoInstant.optional(),
  notifiedAtReal: IsoInstant.optional(),
  qa: QaScopeRecord.optional(),
});
export type Lead = z.infer<typeof Lead>;

/**
 * A test lead (`test=true` in every report): the scenario runner's, which carries its `qa` scope and so is
 * keyed `QALEAD#`. The only source of that flag: it is never notified (`QA_LEAD`) nor exported.
 */
export const isTestLead = (lead: Pick<Lead, "qa">): boolean => lead.qa !== undefined;

/** `CANON#<canonHash>`: confirmed accounts of one canonical address. */
export const CanonCounter = z.object({ confirmed: z.number().int().nonnegative() });
