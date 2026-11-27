// Numbers of the guest self-signup that the INFRASTRUCTURE enforces (docs/architecture-guests.md §7,
// §8 and §9), as plain data. No SST or Pulumi dependency: infra/waf.ts, infra/leads.ts and
// infra/auth.ts build their resources from here, and infra/waf.test.ts and infra/leads.test.ts check
// every value against the document. Changing a number is a pull request. The edge's rules are the
// shared `demos-borde`'s (craftech/demos), not this app's.
//
// The caps the CODE enforces with the real clock (sign-ups per hour, per IP and per canonical email,
// auth emails, resends, recoveries, guest worlds, lead notices) live next to the code that counts
// them, in the BFF (packages/bff/src/leads/limits.ts), and the per-world ones in the world's
// `SETTINGS`; they are not repeated here.

/** Every rate rule of both web ACLs evaluates five minutes. */
export const WAF_WINDOW_SECONDS = 300;

/**
 * The edge is the account's shared web ACL (`demos-borde`, infra/web-spec.ts), which blocks the sign-up
 * from hosting-provider addresses. A GitHub-hosted runner is one: the post-deploy checks of the sign-up
 * surface read an edge refusal of the runner as a warning, never as a closed sign-up (scripts/scenarios).
 */
export const SHARED_EDGE_BLOCKS_HOSTING_SIGNUP = true;

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

/** Lambda budgets of the self-signup's functions (Cognito waits at most 5 s for a trigger). */
export const SIGNUP_FUNCTION_BUDGETS = {
  PreSignUpTrigger: { timeoutSeconds: 3, memoryMb: 256 },
  PostConfirmationTrigger: { timeoutSeconds: 5, memoryMb: 512 },
  CustomMessageTrigger: { timeoutSeconds: 3, memoryMb: 256 },
  // Asynchronous, no retry: a failed notice is audited (`LeadNoticeFailed`) and never sent twice.
  LeadNotifier: { timeoutSeconds: 15, memoryMb: 256, retries: 0 },
} as const;
