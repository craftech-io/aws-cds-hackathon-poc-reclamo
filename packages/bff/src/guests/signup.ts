// The self-signup of a GUEST (docs/architecture-guests.md §4, ADR-0020): `signup.availability`,
// `signup.start`, `signup.confirm` and `signup.resend`. Order of `start`: availability (switch, kill,
// SES), consents, password, email (shape, then DNS), caps on the real clock, the account's state in
// the pool, the request and its email's pointer, and only then Cognito. The confirmation is bound to
// the form: only the current request of an email (`PENDING#`) confirms, with the `signupId` the tab
// kept, so a code that reached a victim never confirms a sign-up somebody else prepared.
//
// The scenario runner (the QaDriver's `guest.signup`, in process, never the public router) passes a
// `QaScope`: then the only address accepted is `success+qa-<runId>-<key>@simulator.amazonses.com`, the
// request lives under `QASIGNUP#`/`QAPENDING#`, the world it registers is `qa-<runId>-<key>`, and the
// caps are the QA buckets (`SIGNUPCAP#QA#…`), never a visitor's (per IP, per canonical email,
// `AUTHMAIL#`, per account): the SES mailbox simulator does not touch the account's reputation.
import { isRetryable } from "@reclamo/shared";
import { CURRENT_SIGNUP_CONSENT } from "../copy/signup-consent";
import { CognitoFailure } from "./cognito-port";
import { type EmailVerdict, canonicalEmail, checkEmail, isEmailUsername, normalizeEmail } from "./email-domain";
import type { QaScope } from "../leads/keys";
import { LEADS_TTL_SECONDS, SIGNUP_LIMITS } from "../leads/limits";
import { QaScopeRecord, type SignupRequest } from "../leads/records";
import { registerSignup } from "./register";
import {
  type SignupAvailability,
  type SignupConfirmResult,
  type SignupResendResult,
  type SignupStartInput,
  type SignupStartResult,
  passwordProblem,
} from "./schemas";
import { type SignupServiceDeps, afterRegistration, auditEdge, randomSignupId } from "./service-deps";

type Rejection = Exclude<SignupStartResult["status"], "CODE_SENT">;

function consentsOf(input: SignupStartInput, at: string): SignupRequest["consents"] {
  const version = CURRENT_SIGNUP_CONSENT.version;
  return {
    terms: { acceptedAtReal: at, textVersion: version },
    contact: { accepted: input.acceptContact, ...(input.acceptContact ? { atReal: at } : {}), textVersion: version },
  };
}

/** The one address of a scenario-runner sign-up (docs/tool-catalog.md `guest.signup`). */
export function qaSignupEmail(qa: QaScope): string {
  return `success+qa-${qa.runId}-${qa.key}@simulator.amazonses.com`;
}

/** The address a request may use: a visitor's (shape, then DNS), or exactly the QA run's own. */
async function verdictOf(deps: SignupServiceDeps, raw: string, qa: QaScope | undefined): Promise<EmailVerdict> {
  if (!qa) return checkEmail(raw, deps.resolver);
  if (!QaScopeRecord.safeParse(qa).success) return { ok: false, reason: "INVALID_EMAIL" };
  const email = normalizeEmail(raw);
  return email === qaSignupEmail(qa) ? { ok: true, email, domain: "simulator.amazonses.com" } : { ok: false, reason: "INVALID_EMAIL" };
}

/** A request that may still be confirmed or resent: current for its email, not expired, with a `sub`. */
async function liveRequest(deps: SignupServiceDeps, signupId: string, qa: QaScope | undefined): Promise<SignupRequest | undefined> {
  const request = await deps.leads.getSignup(signupId, qa);
  if (!request?.sub || (request.status !== "CODE_SENT" && request.status !== "CONFIRMED")) return undefined;
  if (Date.parse(request.validUntilReal) <= deps.ctx.now().getTime()) return undefined;
  return (await deps.leads.currentSignupId(request.emailHash, qa)) === signupId ? request : undefined;
}

export function signupService(deps: SignupServiceDeps) {
  const reject = async (status: Rejection, ipHash: string | undefined, qa: QaScope | undefined): Promise<SignupStartResult> => {
    if (status === "RATE_LIMITED" || status === "SIGNUP_UNAVAILABLE") {
      await auditEdge(deps, { action: "SIGNUP_REJECTED", outcome: status, refs: ipHash ? { ipHash: ipHash.slice(0, 16) } : {}, ...(qa ? { qa: true } : {}) });
    }
    return { status };
  };

  const open = async (): Promise<boolean> => deps.mailReady() && (await deps.caps.signupOpen());

  // The caps of a request: a visitor's (confirmed accounts and requests per canonical email, IP,
  // global, then room in `AUTHMAIL#`), or the QA run's own buckets.
  const admitted = async (ipHash: string, canonHash: string, qa: QaScope | undefined): Promise<boolean> => {
    if (qa) return deps.caps.qaSignupRequest();
    if ((await deps.leads.confirmedAccounts(canonHash)) >= SIGNUP_LIMITS.confirmedPerCanonicalEmail) return false;
    return (await deps.caps.signupRequest(ipHash, canonHash)) && deps.caps.authMailOpen();
  };

  const failedSignUp = async (request: SignupRequest, error: unknown, ipHash: string, qa: QaScope | undefined): Promise<SignupStartResult> => {
    await deps.leads.abandon(request);
    if (!(error instanceof CognitoFailure)) throw error;
    switch (error.code) {
      case "WEAK_PASSWORD":
        return { status: "WEAK_PASSWORD" };
      case "USERNAME_EXISTS":
        return { status: "EMAIL_TAKEN" };
      case "LIMIT_EXCEEDED":
        return reject("RATE_LIMITED", ipHash, qa);
      case "TRIGGER_REFUSED":
        return reject("SIGNUP_UNAVAILABLE", ipHash, qa);
      default:
        throw error;
    }
  };

  return {
    async availability(): Promise<SignupAvailability> {
      return { status: (await open()) ? "open" : "closed" };
    },

    async start(input: SignupStartInput, viewerIp: string, qa?: QaScope): Promise<SignupStartResult> {
      const ipHash = deps.hashes.ipHash(viewerIp);
      if (!(await open())) return reject("SIGNUP_UNAVAILABLE", ipHash, qa);
      if (!input.acceptTerms) return { status: "CONSENT_REQUIRED" };
      if (passwordProblem(input.password)) return { status: "WEAK_PASSWORD" };
      const verdict = await verdictOf(deps, input.email, qa);
      if (!verdict.ok) return { status: verdict.reason };

      const email = verdict.email;
      const emailHash = deps.hashes.emailHash(email);
      const canonHash = deps.hashes.canonHash(canonicalEmail(email));
      if (!(await admitted(ipHash, canonHash, qa))) return reject("RATE_LIMITED", ipHash, qa);

      // A confirmed account says so (docs/landing-spec.md §9.2); an unconfirmed one is replaced below.
      const account = await deps.cognito.account(email);
      if (account && account.status !== "UNCONFIRMED") return { status: "EMAIL_TAKEN" };

      const now = deps.ctx.now();
      const at = now.toISOString();
      const previousId = await deps.leads.currentSignupId(emailHash, qa);
      const previous = previousId ? await deps.leads.getSignup(previousId, qa) : undefined;
      const request: SignupRequest = {
        signupId: (deps.newSignupId ?? randomSignupId)(),
        status: "STARTED",
        email,
        ...(input.name ? { name: input.name } : {}),
        ...(input.company ? { company: input.company } : {}),
        ...(input.jobTitle ? { jobTitle: input.jobTitle } : {}),
        locale: input.locale,
        ...(input.utm ? { utm: input.utm } : {}),
        ...(input.referrer ? { referrer: input.referrer } : {}),
        consents: consentsOf(input, at),
        emailHash,
        canonHash,
        clientId: deps.clientId,
        ...(qa ? { qa: { runId: qa.runId, key: qa.key } } : {}),
        startedAtReal: at,
        validUntilReal: new Date(now.getTime() + LEADS_TTL_SECONDS.signupRequest * 1_000).toISOString(),
      };
      await deps.leads.start(request, previous);
      // The unconfirmed account of an earlier form goes with its code; only `@` usernames, never staff.
      if (account?.status === "UNCONFIRMED" && isEmailUsername(email)) await deps.cognito.deleteAccount(email);
      if (!qa && !(await deps.caps.spendAuthMail())) {
        await deps.leads.abandon(request);
        return reject("RATE_LIMITED", ipHash, qa);
      }

      let sub: string;
      try {
        ({ sub } = await deps.cognito.signUp({ username: email, password: input.password, clientMetadata: { signupId: request.signupId, locale: input.locale } }));
      } catch (error) {
        return failedSignUp(request, error, ipHash, qa);
      }
      await deps.leads.codeSent(request, sub, qa ? `qa-${qa.runId}-${qa.key}` : deps.hashes.guestWorldId(sub));
      return { status: "CODE_SENT", signupId: request.signupId };
    },

    async confirm(input: { readonly signupId: string; readonly code: string }, qa?: QaScope): Promise<SignupConfirmResult> {
      const request = await liveRequest(deps, input.signupId, qa);
      if (!request?.sub) return { status: "SIGNUP_RESTART" };
      if (request.status === "CODE_SENT") {
        try {
          await deps.cognito.confirmSignUp({ username: request.email, code: input.code, clientMetadata: { signupId: request.signupId, locale: request.locale } });
        } catch (error) {
          if (!(error instanceof CognitoFailure)) throw error;
          if (error.code === "CODE_MISMATCH") return { status: "CODE_MISMATCH" };
          if (error.code === "CODE_EXPIRED") return { status: "CODE_EXPIRED" };
          if (error.code === "LIMIT_EXCEEDED") return { status: "RATE_LIMITED" };
          if (error.code === "USER_NOT_FOUND") return { status: "SIGNUP_RESTART" };
          if (error.code !== "ALREADY_CONFIRMED") throw error;
        }
      }
      // The trigger registered it already, or this repairs a trigger that failed.
      const outcome = await registerSignup(request, request.sub, deps);
      if (outcome.status === "MISMATCH") return { status: "SIGNUP_RESTART" };
      if (outcome.status === "REGISTERED") await afterRegistration(deps, outcome, request.sub, qa !== undefined);
      const meta = await deps.connector.worlds.getMeta(outcome.worldId, { consistent: true }).catch(() => undefined);
      return { status: "CONFIRMED", worldStatus: meta?.status ?? "REGISTERED", email: request.email };
    },

    async resend(input: { readonly signupId: string }, qa?: QaScope): Promise<SignupResendResult> {
      const request = await liveRequest(deps, input.signupId, qa);
      // An invalid or confirmed request gets the same answer, and Cognito is not called.
      if (!request?.sub || request.status !== "CODE_SENT") return { status: "CODE_SENT" };
      if (!qa && (!(await deps.caps.authMailOpen()) || !(await deps.caps.resend(request.sub)) || !(await deps.caps.spendAuthMail()))) {
        await auditEdge(deps, { action: "SIGNUP_REJECTED", outcome: "RATE_LIMITED", refs: { step: "resend" } });
        return { status: "RATE_LIMITED" };
      }
      try {
        await deps.cognito.resendCode({ username: request.email, clientMetadata: { signupId: request.signupId, locale: request.locale } });
      } catch (error) {
        if (error instanceof CognitoFailure && error.code === "LIMIT_EXCEEDED") return { status: "RATE_LIMITED" };
        if (isRetryable(error) || !(error instanceof CognitoFailure) || error.code === "UNAVAILABLE") throw error;
      }
      return { status: "CODE_SENT" };
    },
  };
}

export type SignupService = ReturnType<typeof signupService>;
