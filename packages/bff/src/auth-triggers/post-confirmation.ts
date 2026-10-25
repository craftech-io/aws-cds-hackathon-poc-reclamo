/// <reference path="../../sst-env.d.ts" />
// Post-confirmation trigger of the console user pool (docs/architecture-guests.md §3, §5). After
// `ConfirmSignUp` (or the scenario runner's `AdminConfirmSignUp`, which Cognito reports the same way)
// it only ASKS for the world: guests/register.ts writes, in one transaction and only from the request
// of `clientMetadata.signupId` whose `sub` is this user's, the lead, the request as `CONFIRMED`, the
// world `REGISTERED` with its `GUEST` staff row and the provisioning ticket; then it invokes
// `WorldJanitor` and `LeadNotifier` asynchronously. A request of another `sub`, or none, registers
// nothing and is audited as `SIGNUP_REJECTED SIGNUP_MISMATCH`. It holds no secret and never builds a
// world. Cognito keeps the user confirmed whatever this returns, so it never throws for a refusal.
import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { z } from "zod";
import { qaSignupScope } from "../auth/guest-identity";
import type { RepoContext } from "../connector/codec";
import { createConnector } from "../connector/create";
import { DynamoStore } from "../connector/dynamo/engine";
import { createDocumentClient } from "../lib/clients";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import type { ProvisionInvoker } from "../guests/provision";
import { registerSignup, type RegisterDeps, type RegisterOutcome } from "../guests/register";
import { leadsRepo } from "../leads/repo";
import { lambdaProvisionInvoker } from "../guests/runtime";
import { afterRegistration, auditEdge } from "../guests/service-deps";

export const CONFIRM_SIGN_UP = "PostConfirmation_ConfirmSignUp";
export const TRIGGER_BUDGET_MS = 2_000;

export interface PostConfirmationDeps extends RegisterDeps {
  readonly connector: RegisterDeps["connector"] & Parameters<typeof auditEdge>[0]["connector"];
  readonly invoker: ProvisionInvoker;
  readonly log: Logger;
}

const ConfirmationEvent = z.looseObject({
  triggerSource: z.literal(CONFIRM_SIGN_UP),
  userName: z.string().min(3).max(254),
  request: z.looseObject({
    userAttributes: z.looseObject({ sub: z.string().min(1).max(128) }),
    clientMetadata: z.record(z.string(), z.string()).optional(),
  }),
});

export type PostConfirmationOutcome = RegisterOutcome["status"] | "NOT_A_SIGNUP";

/** Registers a confirmed self-signup; never throws for a refusal, only when storage fails. */
export async function onConfirmation(raw: unknown, deps: PostConfirmationDeps): Promise<PostConfirmationOutcome> {
  const parsed = ConfirmationEvent.safeParse(raw);
  // Staff and `qa-*` users are created by an administrator and never pass through here.
  if (!parsed.success || !parsed.data.userName.includes("@")) return "NOT_A_SIGNUP";
  const event = parsed.data;
  const sub = event.request.userAttributes.sub;
  const signupId = event.request.clientMetadata?.signupId ?? "";
  const qa = qaSignupScope(event.userName);
  const request = /^[a-z2-7]{26}$/.test(signupId) ? await deps.leads.getSignup(signupId, qa) : undefined;
  const outcome: RegisterOutcome = request && request.email === event.userName ? await registerSignup(request, sub, deps) : { status: "MISMATCH" };
  if (outcome.status === "MISMATCH") {
    await auditEdge(deps, { action: "SIGNUP_REJECTED", outcome: "SIGNUP_MISMATCH", refs: { step: "post-confirmation" } });
    deps.log.warn("signup.post_confirmation.mismatch", {});
  } else if (outcome.status === "REGISTERED") {
    await afterRegistration(deps, outcome, sub, qa !== undefined);
  }
  return outcome.status;
}

export function createPostConfirmationHandler(resolveDeps: () => PostConfirmationDeps, budgetMs: number = TRIGGER_BUDGET_MS) {
  return async (event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> => {
    const deps = resolveDeps();
    if (event.triggerSource !== CONFIRM_SIGN_UP) return event;
    try {
      const outcome = await withDeadline("post-confirmation", budgetMs, () => onConfirmation(event, deps));
      deps.log.info("signup.post_confirmation", { outcome });
    } catch (error) {
      // `signup.confirm` repeats the registration: a failure here is repaired there.
      deps.log.error("signup.post_confirmation.failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    }
    return event;
  };
}

const TRIGGER_DYNAMO_TIMEOUTS = { requestTimeoutMs: 600, connectionTimeoutMs: 300, maxAttempts: 2 } as const;

let adapters: Omit<PostConfirmationDeps, "log" | "invoker"> | undefined;

function defaultDeps(): PostConfirmationDeps {
  if (!adapters) {
    const store = new DynamoStore({ client: createDocumentClient(TRIGGER_DYNAMO_TIMEOUTS) });
    const ctx: RepoContext = { store, now: () => new Date() };
    adapters = { ctx, connector: createConnector(store, { now: ctx.now }), leads: leadsRepo(ctx) };
  }
  const log = createLogger({ bindings: { service: "post-confirmation-trigger" } });
  return { ...adapters, invoker: lambdaProvisionInvoker(log), log };
}

/** Lambda entry (infra/auth.ts `TRIGGER_HANDLERS.postConfirmation`). */
export const handler = createPostConfirmationHandler(defaultDeps);
