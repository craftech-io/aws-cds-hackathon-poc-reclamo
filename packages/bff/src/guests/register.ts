// Registration of a confirmed self-signup (docs/architecture-guests.md §3, §5): the post-confirmation
// trigger runs it, and `signup.confirm` runs it again in case the trigger failed. It registers only
// from the request the confirmation named (`clientMetadata.signupId`) and only when that request
// carries the confirmed `sub`: another request, another `sub` or none registers nothing. One
// transaction writes the lead (with the consents of THAT request), the request as `CONFIRMED`, the
// canonical-email counter, the world `REGISTERED`, its `GUEST` staff row and the provisioning ticket,
// plus the audit entry (no email). A second run finds the request confirmed and changes nothing.
import { ConnectorError, worldKindOf } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import type { RepoContext } from "../connector/codec";
import { ulid } from "../lib/crypto";
import { GUEST_WORLD_PATTERN } from "../leads/keys";
import { SOURCE_POC } from "../leads/limits";
import { provisionOps } from "./provision";
import type { Lead, SignupRequest } from "../leads/records";
import type { LeadsRepo } from "../leads/repo";

export type RegisterOutcome =
  | { readonly status: "REGISTERED"; readonly worldId: string; readonly requestId: string }
  | { readonly status: "ALREADY_REGISTERED"; readonly worldId: string }
  /** The request is not this `sub`'s, is not `CODE_SENT`, or names no valid world. */
  | { readonly status: "MISMATCH" };

export interface RegisterDeps {
  readonly ctx: RepoContext;
  readonly connector: Pick<Connector, "audit" | "transact">;
  readonly leads: LeadsRepo;
}

/** The world a request may register: `gs-*` for a visitor, `qa-<runId>-<key>` for the scenario runner. */
export function registrableWorld(request: SignupRequest): string | undefined {
  const worldId = request.worldId;
  if (!worldId) return undefined;
  if (request.qa) return worldId === `qa-${request.qa.runId}-${request.qa.key}` && worldKindOf(worldId) === "QA" ? worldId : undefined;
  return GUEST_WORLD_PATTERN.test(worldId) ? worldId : undefined;
}

function leadOf(request: SignupRequest, sub: string, worldId: string, now: Date): Lead {
  return {
    sub,
    email: request.email,
    ...(request.name ? { name: request.name } : {}),
    ...(request.company ? { company: request.company } : {}),
    ...(request.jobTitle ? { jobTitle: request.jobTitle } : {}),
    consents: request.consents,
    sourcePoc: SOURCE_POC,
    locale: request.locale,
    ...(request.utm ? { utm: request.utm } : {}),
    ...(request.referrer ? { referrer: request.referrer } : {}),
    emailHash: request.emailHash,
    worldId,
    signupAtReal: request.startedAtReal,
    confirmedAtReal: now.toISOString(),
    ...(request.qa ? { qa: request.qa } : {}),
  };
}

function alreadyDone(request: SignupRequest | undefined, sub: string): RegisterOutcome | undefined {
  if (request?.status === "CONFIRMED" && request.sub === sub && request.worldId) return { status: "ALREADY_REGISTERED", worldId: request.worldId };
  return undefined;
}

export async function registerSignup(request: SignupRequest, sub: string, deps: RegisterDeps): Promise<RegisterOutcome> {
  const done = alreadyDone(request, sub);
  if (done) return done;
  const worldId = registrableWorld(request);
  if (request.status !== "CODE_SENT" || request.sub !== sub || !worldId) return { status: "MISMATCH" };

  const now = deps.ctx.now();
  const requestId = ulid(now.getTime());
  const provision = provisionOps(deps.ctx);
  const ops = [
    deps.leads.confirmOp(request, sub),
    deps.leads.putLeadOp(leadOf(request, sub, worldId, now)),
    ...(request.qa ? [] : [deps.leads.canonOp(request.canonHash)]),
    provision.worldOp(worldId, request.qa ? "QA" : "GUEST"),
    provision.staffOp(worldId, sub),
    provision.ticketOp(worldId, requestId),
    deps.connector.audit.appendOp({
      worldId,
      epoch: 1,
      auditId: ulid(now.getTime()),
      ts: now.toISOString(),
      action: "GUEST_REGISTERED",
      actor: "SYSTEM",
      refs: { origin: "SIGNUP", requestId, locale: request.locale },
      primaryRef: `STAFF#stf-${worldId}`,
    }),
  ];
  try {
    await deps.connector.transact(ops);
    return { status: "REGISTERED", worldId, requestId };
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "CONFLICT") throw error;
    // The other runner (trigger or repair) won: the request says so.
    const after = await deps.leads.getSignup(request.signupId, request.qa);
    const finished = alreadyDone(after, sub);
    if (finished) return finished;
    throw error;
  }
}
