// The numbers of the guest self-signup (ADR-0020, docs/architecture-guests.md §6-§7), in one place.
// Every window is on the REAL clock (ADR-0017): the guest drives the world clock, never these.
// Changing a number is a pull request; the world-level caps (turns, images, emails, resets) belong to
// the world's `SETTINGS`, written by the world factory, and are listed here only as their defaults.

export const SIGNUP_LIMITS = {
  /** Sign-up requests of all visitors. */
  globalPerHour: 20,
  globalPerDay: 100,
  /** Sign-up requests per viewer IP (IPv6: per /64) per real day. */
  perIpPerDay: 3,
  /** Sign-up requests per canonical email per real day, and confirmed accounts per canonical email. */
  perCanonicalEmailPerDay: 3,
  confirmedPerCanonicalEmail: 2,
  /** Cognito auth emails of every flow together (sign-up, resend, recovery). */
  authMailPerHour: 60,
  authMailPerDay: 300,
  /** Code resends per account. */
  resendPerHour: 3,
  resendPerDay: 5,
  /** Password recoveries per account and per viewer IP. */
  recoveryPerHour: 3,
  recoveryPerDay: 5,
  recoveryPerIpPerHour: 10,
  /** Lead notices to Craftech per real day. */
  leadNoticesPerDay: 100,
  /** One world request per account every ten minutes (`guest.requestWorld`). */
  worldRequestEverySeconds: 10 * 60,
} as const;

export const GUEST_WORLD_LIMITS = {
  /** Self-signup worlds CREATING + READY + EXPIRING, and simultaneous creations. */
  activeWorlds: 40,
  simultaneousCreations: 3,
  /** Expiry of a self-signup world, in real hours from `READY` or from the last activity. */
  expireWithoutSignInHours: 6,
  expireWithoutActivityHours: 72,
  expireAfterReadyDays: 7,
  /** Per world and real day (defaults of `SETTINGS`, enforced by the pipeline). */
  turnsPerDay: 60,
  turnsPerEpoch: 150,
  imageReadsPerDay: 20,
  productEmailsPerDay: 40,
  resetsPerDay: 3,
} as const;

/**
 * The scenario runner's own sign-up worlds (`qa-<runId>-su<n>`): a capacity apart from the visitors'
 * (`GUESTCAP#QA`), so a run never takes a visitor's place. `caps.prime(GUESTCAP_QA)` lowers the limit
 * for the worlds of its own run, for `primeMinutes`.
 */
export const QA_GUEST_WORLD_LIMITS = {
  activeWorlds: 8,
  simultaneousCreations: 3,
  /** A run's `READY` sign-up world expires this long after `READY`, so a place a run left comes back. */
  expireAfterReadyHours: 6,
  /** A primed limit binds only the worlds of the run that primed it, and lapses after this. */
  primeMinutes: 60,
} as const;

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 24 * HOUR_SECONDS;

export const LEADS_TTL_SECONDS = {
  /** A sign-up request and the pointer to the current one, per email. */
  signupRequest: 48 * HOUR_SECONDS,
  /** Counters of a real hour or day, 48 h after their window. */
  counter: 48 * HOUR_SECONDS,
  /** A provisioning ticket nobody claimed. */
  provisionTicket: 7 * DAY_SECONDS,
  /** A lead and its account: 24 months after the last sign-in (assumption the privacy policy publishes). */
  lead: 730 * DAY_SECONDS,
  /** Proof that a lead was deleted (only the hash and the instant). */
  deletionProof: 730 * DAY_SECONDS,
} as const;

/** Where the self-signup is recorded as coming from, in every lead. */
export const SOURCE_POC = "reclamo-en-regla";

/** `expiresAt` (epoch seconds) of an item written at `now` that lives `seconds`. */
export function expiresAt(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000) + seconds;
}
