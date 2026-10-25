/// <reference path="../../sst-env.d.ts" />
// Pre-sign-up trigger of the console user pool (docs/architecture-guests.md §3). Two ways in, and
// nothing else:
//
//   PreSignUp_AdminCreateUser   the operator's invitations (`console:invite`) and the scenario
//                               runner's `qa-*` users, as before.
//   PreSignUp_SignUp            a self-signup, accepted only when ALL hold: its
//                               `clientMetadata.signupId` names a request `STARTED` and not expired
//                               that is the CURRENT request of that email (`PENDING#`); it comes from
//                               the app client the Bff wrote in that request (the `GuestSignupClient`,
//                               whose secret only the Bff has: the pool cannot hand its own client id
//                               to its trigger without a dependency cycle); the request's email equals
//                               the username; and the attributes are exactly `email` (equal to the
//                               username), no `custom:*`.
//
// It never confirms or verifies anything on the user's behalf, and it only reads `Leads`.
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { z } from "zod";
import { qaSignupScope } from "../auth/guest-identity";
import type { RepoContext } from "../connector/codec";
import { DynamoStore } from "../connector/dynamo/engine";
import { createDocumentClient } from "../lib/clients";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { leadsRepo } from "../leads/repo";
import type { SignupRequest } from "../leads/records";

export const ADMIN_CREATE_USER = "PreSignUp_AdminCreateUser";
export const SELF_SIGN_UP = "PreSignUp_SignUp";

/** Error text of a refused sign-up: an identifier, never a detail. */
export const SIGN_UP_DISABLED = "SIGN_UP_DISABLED";

export const TRIGGER_BUDGET_MS = 1_000;

export class SignUpRefusal extends Error {
  override readonly name = "SignUpRefusal";
}

export interface PreSignUpDeps {
  readonly signupRequest: (signupId: string, qa: { runId: string; key: string } | undefined) => Promise<SignupRequest | undefined>;
  readonly currentSignupId: (emailHash: string, qa: { runId: string; key: string } | undefined) => Promise<string | undefined>;
  readonly now: () => Date;
  readonly log: Logger;
}

const SelfSignUpEvent = z.looseObject({
  userName: z.string().min(3).max(254),
  callerContext: z.looseObject({ clientId: z.string().min(1) }),
  request: z.looseObject({
    userAttributes: z.record(z.string(), z.string()),
    clientMetadata: z.record(z.string(), z.string()).optional(),
  }),
});

/** Why a self-signup is refused, or `undefined` when it may go on. */
export async function selfSignUpProblem(raw: unknown, deps: PreSignUpDeps): Promise<string | undefined> {
  const parsed = SelfSignUpEvent.safeParse(raw);
  if (!parsed.success) return "UNEXPECTED_EVENT";
  const event = parsed.data;
  const attributes = Object.keys(event.request.userAttributes);
  if (attributes.length !== 1 || attributes[0] !== "email" || event.request.userAttributes.email !== event.userName) return "UNEXPECTED_ATTRIBUTES";
  const signupId = event.request.clientMetadata?.signupId;
  if (!signupId || !/^[a-z2-7]{26}$/.test(signupId)) return "NO_SIGNUP_REQUEST";
  const qa = qaSignupScope(event.userName);
  const request = await deps.signupRequest(signupId, qa);
  if (!request || request.status !== "STARTED") return "NO_SIGNUP_REQUEST";
  if (event.callerContext.clientId !== request.clientId) return "FOREIGN_CLIENT";
  if (Date.parse(request.validUntilReal) <= deps.now().getTime()) return "SIGNUP_REQUEST_EXPIRED";
  if (request.email !== event.userName) return "EMAIL_MISMATCH";
  if ((await deps.currentSignupId(request.emailHash, qa)) !== signupId) return "SIGNUP_REQUEST_SUPERSEDED";
  return undefined;
}

export function createPreSignUpHandler(resolveDeps: () => PreSignUpDeps, budgetMs: number = TRIGGER_BUDGET_MS) {
  return async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
    const deps = resolveDeps();
    if (event.triggerSource === SELF_SIGN_UP) {
      let problem: string | undefined;
      try {
        problem = await withDeadline("pre-sign-up", budgetMs, () => selfSignUpProblem(event, deps));
      } catch (error) {
        deps.log.error("signup.pre_sign_up.unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" });
        problem = "UNAVAILABLE";
      }
      if (problem) {
        deps.log.warn("signup.pre_sign_up.refused", { outcome: problem });
        throw new SignUpRefusal(SIGN_UP_DISABLED);
      }
    } else if (event.triggerSource !== ADMIN_CREATE_USER) {
      throw new SignUpRefusal(SIGN_UP_DISABLED);
    }
    // Nothing is confirmed or verified on the user's behalf: the code (or the administrator) decides.
    return { ...event, response: { ...event.response, autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false } };
  };
}

const TRIGGER_DYNAMO_TIMEOUTS = { requestTimeoutMs: 400, connectionTimeoutMs: 300, maxAttempts: 2 } as const;

let adapters: Omit<PreSignUpDeps, "log"> | undefined;

function defaultDeps(): PreSignUpDeps {
  if (!adapters) {
    const store = new DynamoStore({ client: createDocumentClient(TRIGGER_DYNAMO_TIMEOUTS) });
    const ctx: RepoContext = { store, now: () => new Date() };
    const leads = leadsRepo(ctx);
    adapters = {
      signupRequest: (signupId, qa) => leads.getSignup(signupId, qa),
      currentSignupId: (emailHash, qa) => leads.currentSignupId(emailHash, qa),
      now: ctx.now,
    };
  }
  return { ...adapters, log: createLogger({ bindings: { service: "pre-sign-up-trigger" } }) };
}

/** Lambda entry (infra/auth.ts `TRIGGER_HANDLERS.preSignUp`). */
export const handler = createPreSignUpHandler(defaultDeps);
