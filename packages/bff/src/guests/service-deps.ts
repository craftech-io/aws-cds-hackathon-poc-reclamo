// What the public procedures of the self-signup need (docs/architecture-guests.md §4), as one
// explicit bundle so the Lambda, the local flows and the unit tests build the same service over
// different adapters (DynamoDB or memory, Cognito or its fake, DNS or a stub).
import { randomBytes } from "node:crypto";
import type { RepoContext } from "../connector/codec";
import type { Connector } from "../connector/port";
import type { Logger } from "../lib/log";
import { ulid } from "../lib/crypto";
import { maskAuditRefs } from "../auth/audit";
import type { SignupCaps } from "./caps";
import type { GuestCognito } from "./cognito-port";
import type { MailDomainResolver } from "./email-domain";
import { base32, type LeadHashes } from "../leads/keys";
import type { ProvisionInvoker } from "./provision";
import { type EdgeAuditEntry, type LeadsRepo, edgeAuditOp } from "../leads/repo";

export interface SignupServiceDeps {
  readonly ctx: RepoContext;
  readonly connector: Pick<Connector, "audit" | "transact" | "write" | "worlds">;
  readonly leads: LeadsRepo;
  readonly caps: SignupCaps;
  readonly cognito: GuestCognito;
  /** Id of the `GuestSignupClient`, written in every request for the pre-sign-up trigger. */
  readonly clientId: string;
  readonly hashes: LeadHashes;
  readonly resolver: MailDomainResolver;
  readonly invoker: ProvisionInvoker;
  /** The pool sends its emails through the app's SES identity (DKIM verified, `DEVELOPER`). */
  readonly mailReady: () => boolean;
  readonly newSignupId?: () => string;
  readonly log: Logger;
}

/** 128 random bits in base32: the id of one form (`signupId`), kept only in the tab's sessionStorage. */
export function randomSignupId(): string {
  return base32(randomBytes(16)).slice(0, 26);
}

/** Audits a refusal or an event of the public edge; a failed audit never changes the answer. */
export async function auditEdge(deps: { readonly connector: Pick<Connector, "write">; readonly ctx: RepoContext; readonly log: Logger }, entry: EdgeAuditEntry): Promise<void> {
  const now = deps.ctx.now();
  try {
    await deps.connector.write(edgeAuditOp({ ...entry, refs: maskAuditRefs(entry.refs, deps.log) }, ulid(now.getTime()), now));
  } catch (error) {
    deps.log.error("signup.audit_failed", { action: entry.action, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}

/** The asynchronous invocations after a registration; a failure leaves the ticket for the janitor's pass. */
export async function afterRegistration(deps: Pick<SignupServiceDeps, "invoker" | "log">, registered: { readonly worldId: string; readonly requestId: string }, sub: string, qa: boolean): Promise<void> {
  const results = await Promise.allSettled([
    deps.invoker.createWorld({ kind: "WORLD_CREATE", worldId: registered.worldId, requestId: registered.requestId }),
    ...(qa ? [] : [deps.invoker.notifyLead({ leadId: sub })]),
  ]);
  for (const result of results) {
    if (result.status === "rejected") deps.log.warn("signup.invoke_failed", { errorName: result.reason instanceof Error ? result.reason.name : "UnknownError" });
  }
}
