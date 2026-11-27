// The named security decisions of the Bff (docs/architecture.md §12): every time a security rule stops
// something, one line with the fixed metric field and the rule's name, never who or what. The metric
// filter `SecurityDecisions` (infra/observability-spec.ts) counts them per `decision`; the alarm
// `SignupRateLimited` watches the sign-up caps.
import type { Logger } from "./log";

export const SECURITY_DECISION_METRIC = "SecurityDecisions";

/** Every decision, by name. A new one is added here and nowhere else. */
export const SECURITY_DECISION = {
  /** A session that has not passed the SMS code asked for anything but the code. */
  SECOND_FACTOR_PENDING: "SECOND_FACTOR_PENDING",
  /** An account an operator blocked (scripts/console/block.ts). */
  ACCOUNT_BLOCKED: "ACCOUNT_BLOCKED",
  /** An id of another world (cross-tenant), or a staff row that does not match its token. */
  CROSS_WORLD: "CROSS_WORLD",
  STAFF_INACTIVE: "STAFF_INACTIVE",
  /** A token of an audience accepted only for QA users of QA worlds. */
  SERVER_CLIENT_AUDIENCE: "SERVER_CLIENT_AUDIENCE",
  /** A request that did not come through the Router (no edge header). */
  EDGE_REQUIRED: "EDGE_REQUIRED",
  /** An SMS cap of the real day (§17.3 of docs/architecture-guests.md), one per scope. */
  SMS_CAP_ACCOUNT: "SMS_CAP_ACCOUNT",
  SMS_CAP_NUMBER: "SMS_CAP_NUMBER",
  SMS_CAP_IP: "SMS_CAP_IP",
  SMS_CAP_ABROAD: "SMS_CAP_ABROAD",
  SMS_CAP_GLOBAL: "SMS_CAP_GLOBAL",
  /** The fifth wrong attempt burnt an SMS code. */
  SMS_CODE_BURNT: "SMS_CODE_BURNT",
  /** A number refused before any SMS: not a person's mobile, or outside America. */
  PHONE_NOT_ACCEPTED: "PHONE_NOT_ACCEPTED",
  PHONE_COUNTRY_NOT_ALLOWED: "PHONE_COUNTRY_NOT_ALLOWED",
  /** `signup.start` refused: a disposable, reserved or mailless domain; a number; a cap; the sign-up closed. */
  SIGNUP_EMAIL_NOT_ACCEPTED: "SIGNUP_EMAIL_NOT_ACCEPTED",
  SIGNUP_PHONE_NOT_ACCEPTED: "SIGNUP_PHONE_NOT_ACCEPTED",
  SIGNUP_PHONE_COUNTRY_NOT_ALLOWED: "SIGNUP_PHONE_COUNTRY_NOT_ALLOWED",
  SIGNUP_RATE_LIMITED: "SIGNUP_RATE_LIMITED",
  SIGNUP_UNAVAILABLE: "SIGNUP_UNAVAILABLE",
  /** A password recovery over its cap. */
  RECOVERY_RATE_LIMITED: "RECOVERY_RATE_LIMITED",
} as const;
export type SecurityDecision = (typeof SECURITY_DECISION)[keyof typeof SECURITY_DECISION];

/** One line per decision: `{ metric: "SecurityDecisions", decision, path? }`; never a person's data. */
export function recordSecurityDecision(log: Pick<Logger, "warn">, decision: SecurityDecision, path?: string): void {
  log.warn("security.decision", { metric: SECURITY_DECISION_METRIC, decision, ...(path === undefined ? {} : { path }) });
}
