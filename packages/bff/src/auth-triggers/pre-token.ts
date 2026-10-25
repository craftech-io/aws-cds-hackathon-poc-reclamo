// Pre-token generation trigger (V2) of the console user pool (docs/architecture.md §11, ADR-0018,
// docs/architecture-guests.md §3). It only reads: the staff row of the user's `sub`
// (`Worlds/index/BySub`, re-read by key), the world's `META` and, for a self-signup, the `worldId` of
// its lead (a `GetItem` IAM limits to that one attribute: it never sees the email). Its only write is
// its own `AuditLog` entry when it refuses. It never creates or changes a world. On every token issue
// (sign-in and refresh):
//
//   1. exactly one active staff row for the `sub`. A username without `@` (staff, `guest-NN`,
//      `qa-*`): the row's world equals the immutable `custom:worldId`, a `qa-*` user only in a `qa-*`
//      world, the row's role among the user's groups, never a self-signup world. A username with `@`
//      (a self-signup): the invariant of auth/guest-identity.ts, with the lead's world as rule (d)
//      → otherwise the sign-in fails and `AuditLog AUTH_WORLD_MISMATCH` says why;
//   2. a sign-in needs the world `READY`, a refresh is also issued while it is `RESETTING`; a
//      self-signup world issues tokens in ANY status, with the claim `worldStatus`, so the console
//      shows the provisioning screen → otherwise the fixed "world not ready" text and
//      `AuditLog WORLD_NOT_READY` with the status;
//   3. `worldId`, `staffId` and `role` are stamped on the id token from the row (never from the
//      attribute, which is suppressed), and the `aws.cognito.signin.user.admin` scope is removed
//      from the access token for every group, so the browser cannot change its account.
//
// Its audit entries never carry a username with `@` (refs: `usernameKind`, `triggerSource`, and the
// staff id, or the `sub` when there is no row). Budget: 1 s of the 5 s Cognito waits.
import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { z } from "zod";
import { WorldId } from "@reclamo/shared";
import { AUDIT_ACTION, type AuditAction, type AuditSink } from "../auth/audit";
import { connectorAuditSink, connectorWorldDirectory } from "../auth/directory";
import { isEmailUsername, isSignupWorld, qaSignupScope, signupIdentityProblem } from "../auth/guest-identity";
import { isQaDashWorld, isQaUsername } from "../auth/principal";
import type { StaffBySubLookup, StaffRow, WorldDirectory, WorldMeta } from "../auth/staff";
import { STAFF_TEXT } from "../copy/es-AR";
import { createDocumentClient } from "../lib/clients";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { createConnector } from "../connector/create";
import { DynamoStore } from "../connector/dynamo/engine";
import { leadsRepo } from "../leads/repo";

/** Scope that lets an access token call Cognito's user APIs from the browser; always suppressed. */
export const ADMIN_SCOPE = "aws.cognito.signin.user.admin";

/** Attribute written only by `AdminCreateUser`; never the source of the world (ADR-0018). */
export const WORLD_ATTRIBUTE = "custom:worldId";

export const TRIGGER_BUDGET_MS = 1_000;

/** Error text of a refusal that is not "world not ready": an identifier, never a detail. */
export const ACCESS_DENIED = "ACCESS_DENIED";

const LOGIN_SOURCES = ["TokenGeneration_Authentication", "TokenGeneration_NewPasswordChallenge", "TokenGeneration_AuthenticateDevice", "TokenGeneration_HostedAuth"] as const;
const REFRESH_SOURCE = "TokenGeneration_RefreshTokens";

const PreTokenEvent = z.looseObject({
  triggerSource: z.enum([...LOGIN_SOURCES, REFRESH_SOURCE]),
  userName: z.string().min(1),
  request: z.looseObject({
    userAttributes: z.record(z.string(), z.string()),
    groupConfiguration: z.looseObject({ groupsToOverride: z.array(z.string()).optional() }).optional(),
  }),
});
type PreTokenEvent = z.infer<typeof PreTokenEvent>;

export interface PreTokenDeps {
  readonly directory: Pick<WorldDirectory, "meta"> & StaffBySubLookup;
  /** `worldId` of the lead of a self-signup `sub` (rule d of the invariant); nothing else of the lead. */
  readonly leadWorldId: (sub: string, qa: { readonly runId: string; readonly key: string } | undefined) => Promise<string | undefined>;
  readonly audit: AuditSink;
  readonly log: Logger;
}

export type PreTokenDecision =
  | { readonly allow: true; readonly staff: StaffRow; readonly status?: WorldMeta["status"] }
  | { readonly allow: false; readonly action: AuditAction; readonly outcome: string; readonly message: string };

/** The refusal of a sign-in; `message` is what Cognito passes to the console. */
export class PreTokenRefusal extends Error {
  override readonly name = "PreTokenRefusal";
}

function deny(action: AuditAction, outcome: string): PreTokenDecision {
  const message = action === AUDIT_ACTION.WORLD_NOT_READY ? STAFF_TEXT.WORLD_NOT_READY : ACCESS_DENIED;
  return { allow: false, action, outcome, message };
}

// Which rule the identity breaks, if any. The attribute is only compared, never used.
async function identityProblem(event: PreTokenEvent, rows: readonly StaffRow[], deps: PreTokenDeps): Promise<string | undefined> {
  if (rows.length === 0) return "NO_STAFF_ROW";
  if (rows.length > 1) return "AMBIGUOUS_STAFF_ROW";
  const [row] = rows as [StaffRow];
  if (row.active === false) return "STAFF_INACTIVE";
  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const attributeWorldId = event.request.userAttributes[WORLD_ATTRIBUTE];
  if (isEmailUsername(event.userName)) {
    const sub = event.request.userAttributes.sub ?? "";
    const leadWorldId = await deps.leadWorldId(sub, qaSignupScope(event.userName));
    return signupIdentityProblem({ username: event.userName, worldId: row.worldId, role: row.role, groups, attributeWorldId, leadWorldId });
  }
  const staffProblem = signupIdentityProblem({ username: event.userName, worldId: row.worldId, role: row.role, groups });
  if (staffProblem) return staffProblem;
  if (attributeWorldId !== row.worldId) return "ATTRIBUTE_MISMATCH";
  if (isQaUsername(event.userName) && !isQaDashWorld(row.worldId)) return "QA_USER_OUTSIDE_QA_WORLD";
  if (!groups.includes(row.role)) return "ROLE_NOT_IN_GROUPS";
  return undefined;
}

function worldProblem(source: PreTokenEvent["triggerSource"], meta: WorldMeta | undefined): string | undefined {
  if (meta?.status === "READY") return undefined;
  // A self-signup world answers in any status; the console reads `worldStatus` and waits.
  if (meta && isSignupWorld(meta.worldId)) return undefined;
  if (source === REFRESH_SOURCE && meta?.status === "RESETTING") return undefined;
  return meta?.status ?? "MISSING";
}

/** Decides a token issue and audits a refusal. Throws only when a read fails (the caller fails closed). */
export async function decidePreToken(event: PreTokenEvent, deps: PreTokenDeps): Promise<PreTokenDecision> {
  const sub = event.request.userAttributes.sub ?? "";
  const rows = sub ? await deps.directory.staffBySub(sub) : [];
  const problem = sub ? await identityProblem(event, rows, deps) : "NO_SUB";
  // The world a refusal is audited in: the row's, else the attribute's when it names a world.
  const attribute = WorldId.safeParse(event.request.userAttributes[WORLD_ATTRIBUTE]);
  const auditWorld = rows.length === 1 ? rows[0]?.worldId : attribute.success ? attribute.data : undefined;
  const meta = auditWorld ? await deps.directory.meta(auditWorld) : undefined;

  let decision: PreTokenDecision;
  if (problem) decision = deny(AUDIT_ACTION.AUTH_WORLD_MISMATCH, problem);
  else {
    const notReady = worldProblem(event.triggerSource, meta);
    decision = notReady ? deny(AUDIT_ACTION.WORLD_NOT_READY, notReady) : { allow: true, staff: rows[0] as StaffRow, ...(meta ? { status: meta.status } : {}) };
  }
  if (!decision.allow) {
    deps.log.warn("console.signin.refused", { action: decision.action, outcome: decision.outcome, triggerSource: event.triggerSource });
    if (auditWorld) await audit(deps, decision, event, auditWorld, meta, rows.length === 1 ? rows[0] : undefined);
  }
  return decision;
}

/** What a refusal records: never a username with `@` (a self-signup's username is its email). */
export function auditRefs(event: PreTokenEvent, row: StaffRow | undefined): Record<string, string> {
  const email = isEmailUsername(event.userName);
  const usernameKind = email ? "SIGNUP" : isQaUsername(event.userName) ? "QA" : "STAFF";
  const refs: Record<string, string> = { usernameKind, triggerSource: event.triggerSource };
  if (row) refs.staffId = row.staffId;
  else refs.sub = event.request.userAttributes.sub ?? "";
  if (!email) refs.username = event.userName;
  return refs;
}

async function audit(deps: PreTokenDeps, decision: Extract<PreTokenDecision, { allow: false }>, event: PreTokenEvent, worldId: string, meta: WorldMeta | undefined, row: StaffRow | undefined): Promise<void> {
  try {
    await deps.audit.record({
      worldId,
      epoch: meta?.epoch ?? 0,
      action: decision.action,
      outcome: decision.outcome,
      actor: "SYSTEM",
      refs: auditRefs(event, row),
    });
  } catch (error) {
    // The refusal stands whether or not the audit write succeeded.
    deps.log.error("console.signin.audit_failed", { action: decision.action, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}

/** Claims and scopes of an accepted token issue; a self-signup world also says its status. */
export function tokenOverrides(staff: StaffRow, status?: WorldMeta["status"]): PreTokenGenerationV2TriggerEvent["response"]["claimsAndScopeOverrideDetails"] {
  const claims: Record<string, string> = { worldId: staff.worldId, staffId: staff.staffId, role: staff.role };
  if (status && isSignupWorld(staff.worldId)) claims.worldStatus = status;
  return {
    idTokenGeneration: {
      claimsToAddOrOverride: claims,
      claimsToSuppress: [WORLD_ATTRIBUTE],
    },
    accessTokenGeneration: { scopesToSuppress: [ADMIN_SCOPE] },
  };
}

export function createPreTokenHandler(resolveDeps: () => PreTokenDeps, budgetMs: number = TRIGGER_BUDGET_MS) {
  return async (raw: PreTokenGenerationV2TriggerEvent): Promise<PreTokenGenerationV2TriggerEvent> => {
    const deps = resolveDeps();
    const parsed = PreTokenEvent.safeParse(raw);
    if (!parsed.success) {
      deps.log.warn("console.signin.refused", { outcome: "UNEXPECTED_EVENT" });
      throw new PreTokenRefusal(ACCESS_DENIED);
    }
    let decision: PreTokenDecision;
    try {
      decision = await withDeadline("pre-token", budgetMs, () => decidePreToken(parsed.data, deps));
    } catch (error) {
      deps.log.error("console.signin.unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" });
      throw new PreTokenRefusal(ACCESS_DENIED);
    }
    if (!decision.allow) throw new PreTokenRefusal(decision.message);
    return { ...raw, response: { ...raw.response, claimsAndScopeOverrideDetails: tokenOverrides(decision.staff, decision.status) } };
  };
}

// Short deadlines: the trigger has 1 s in total, and Cognito fails the sign-in at 5 s anyway.
const TRIGGER_DYNAMO_TIMEOUTS = { requestTimeoutMs: 400, connectionTimeoutMs: 300, maxAttempts: 2 } as const;

let adapters: Omit<PreTokenDeps, "log"> | undefined;

// Adapters live as long as the container; the logger (and its correlation id) is one per invocation.
function defaultPreTokenDeps(): PreTokenDeps {
  if (!adapters) {
    const store = new DynamoStore({ client: createDocumentClient(TRIGGER_DYNAMO_TIMEOUTS) });
    const connector = createConnector(store);
    const leads = leadsRepo({ store, now: () => new Date() });
    adapters = {
      directory: connectorWorldDirectory(connector.worlds),
      audit: connectorAuditSink(connector.audit),
      leadWorldId: (sub, qa) => leads.leadWorldId(sub, qa),
    };
  }
  return { ...adapters, log: createLogger({ bindings: { service: "pre-token-trigger" } }) };
}

/** Lambda entry (infra/auth.ts `TRIGGER_HANDLERS.preToken`). */
export const handler = createPreTokenHandler(defaultPreTokenDeps);
