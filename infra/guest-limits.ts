// Numbers of the guest self-signup that the INFRASTRUCTURE enforces (docs/architecture-guests.md §7,
// §8 and §9), as plain data. No SST or Pulumi dependency: infra/waf.ts, infra/leads.ts and
// infra/auth.ts build their resources from here, and infra/waf.test.ts and infra/leads.test.ts check
// every value against the document. Changing a number is a pull request.
//
// The caps the CODE enforces with the real clock (sign-ups per hour, per IP and per canonical email,
// auth emails, resends, recoveries, guest worlds, lead notices) live next to the code that counts
// them, in the BFF (packages/bff/src/leads/limits.ts), and the per-world ones in the world's
// `SETTINGS`; they are not repeated here.

/** Every rate rule of both web ACLs evaluates five minutes. */
export const WAF_WINDOW_SECONDS = 300;

/** Edge web ACL (`CLOUDFRONT`, on the Router): §8. */
export const EDGE_WAF_LIMITS = {
  /** POSTs per IP to the public API (`/api/public/*` or a path containing `signup.`/`password.`). */
  publicPostsPerIp: 10,
  /** Requests per IP to `/api/*`. */
  apiRequestsPerIp: 1_000,
  /** HTTP status of a request over the public-API rate, with a fixed JSON body. */
  rateLimitedStatus: 429,
  /**
   * Life of a solved challenge. The form of `/signup` (and of `/login/recover`) is filled after the
   * interstitial, and its POST must still carry a valid token: an hour covers a slow visitor, a
   * reload gets a new one. WAF's default (300 s) would expire mid-form.
   */
  challengeImmunitySeconds: 3_600,
} as const;

/**
 * Whether rules 5 and 6 of the edge ACL act (Challenge) or only count (§8). They COUNT on `poc`: WAF's
 * interstitial runs inline script and `challenge.js` from `*.token.awswaf.com`, which the console's CSP
 * (`script-src 'self'`) refuses, so a challenged visitor never reached the form; and the JavaScript
 * integration has no URL to allow (the edge ACL's `ApplicationIntegrationURL` is empty: WAF exposes it
 * only with the ATP, ACFP or targeted Bot Control groups, which cost per request). The sign-up stays
 * protected by the reputation and anonymous-IP lists, the two rate rules, the code caps and the email
 * code; both rules keep their metrics. `true` again only with a CSP-compatible integration.
 */
export const EDGE_CHALLENGE_ENFORCED = false;

/** Cognito web ACL (`REGIONAL`, on the user pool): §8. */
export const COGNITO_WAF_LIMITS = {
  /** `InitiateAuth` + `RespondToAuthChallenge` of the ConsoleClient per IP. */
  signInsPerIp: 100,
} as const;

/**
 * Account-level SES reputation alarms (§9): Cognito's emails go out without a configuration set, so
 * their bounces and complaints are only visible here. Both publish to `<app>-auth-mail-alerts`,
 * which makes `BudgetBreaker` set `KILL#SIGNUP` (never `KILL#AGENT`).
 */
export const SES_REPUTATION_ALARMS = {
  complaint: { metricName: "Reputation.ComplaintRate", threshold: 0.001 },
  bounce: { metricName: "Reputation.BounceRate", threshold: 0.02 },
  /** SES refreshes the reputation metrics a few times an hour; one period of an hour, at most one breach. */
  periodSeconds: 3_600,
  evaluationPeriods: 1,
} as const;

/** `WafSignupBlocks` (WP-37 wires the alarm on these numbers): rules 3 or 6 of the edge ACL. */
export const WAF_SIGNUP_BLOCKS_ALARM = { blocks: 50, periodSeconds: WAF_WINDOW_SECONDS } as const;

/** Lambda budgets of the self-signup's functions (Cognito waits at most 5 s for a trigger). */
export const SIGNUP_FUNCTION_BUDGETS = {
  PreSignUpTrigger: { timeoutSeconds: 3, memoryMb: 256 },
  PostConfirmationTrigger: { timeoutSeconds: 5, memoryMb: 512 },
  CustomMessageTrigger: { timeoutSeconds: 3, memoryMb: 256 },
  // Asynchronous, no retry: a failed notice is audited (`LeadNoticeFailed`) and never sent twice.
  LeadNotifier: { timeoutSeconds: 15, memoryMb: 256, retries: 0 },
} as const;
