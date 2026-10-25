// tRPC v11 foundation of the console BFF: request context, principal and the procedure builders
// every feature router starts from (docs/architecture.md §11, docs/tool-catalog.md "Procedimientos
// de la consola").
//
//   publicProcedure       no principal (only the health probe, which calls nothing)
//   worldProcedure        verified id token with world, staff id and role; the staff row and the
//                         world's META are re-read (inactive or demoted staff → 403; a ServerClient
//                         token only for qa-* users in qa-* worlds → else 401); a RESETTING world
//                         answers WORLD_RESETTING except `clock.resetStatus`; a self-signup world
//                         not yet READY answers WORLD_NOT_READY except `guest.status`,
//                         `guest.requestWorld` and `account.session`; every mutation refuses
//                         COMPLIANCE (FL-095)
//   roleProcedure(roles)  world + one of the roles
//   recentLoginProcedure  world + interactive sign-in at most 15 minutes old (real clock): approving
//                         money, answering in writing and resetting a world
//   guardedProcedure(rule) the three together, as routers/roles.ts declares them per procedure
//
// `worldId`, `staffId` and `role` come from the token (or, for the QaDriver's in-process caller,
// from a principal built on the server), never from the input. An id of an input that names another
// world is refused with `assertWorld`: 403 plus `AuditLog DENY CROSS_WORLD`.
import { TRPCError, initTRPC } from "@trpc/server";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { StaffRole, type WorldKind, worldKindOf } from "@reclamo/shared";
import { AUDIT_ACTION, actorOf } from "../auth/audit";
import { type AuthOutcome, authenticateInProcess, authenticateToken } from "../auth/authenticate";
import { AUTH_REASON, AUTH_REFUSAL, AuthError, type AuthReason, type AuthRefusal, describeError } from "../auth/errors";
import { WORLD_PENDING_PATHS } from "../auth/guest-identity";
import { type Principal, isSignInFresh } from "../auth/principal";
import type { WorldMeta } from "../auth/staff";
import { type Logger, correlationIdFrom } from "../lib/log";
import { type ContextDeps, defaultDeps } from "./deps";
import { reasonOf, toTrpcError } from "./errors";

/** Mutable hints a procedure leaves for the HTTP answer (routers/handler.ts). */
export interface ResponseHints {
  /** The procedure only started asynchronous work: answer HTTP 202 (e.g. `clock.reset`). */
  accepted: boolean;
}

export interface Context {
  readonly correlationId: string;
  readonly deps: ContextDeps;
  readonly log: Logger;
  /** Raw `Authorization` header, verified only when a procedure needs a principal. */
  readonly authorization: string | undefined;
  /** Principal built on the server by the QaDriver (`createInProcessContext`); `null` over HTTP. */
  readonly inProcess: Principal | null;
  readonly response: ResponseHints;
  /** Authentication of this request, shared by the calls of a batch. */
  readonly memo: { auth?: Promise<AuthOutcome> };
}

export interface WorldContext extends Context {
  readonly principal: Principal;
  /** `META` of the principal's world as read for this request (status and epoch). */
  readonly world: WorldMeta;
}

export interface CreateContextOptions {
  readonly event: Pick<APIGatewayProxyEventV2, "headers"> & { readonly requestContext?: { readonly requestId?: string } };
}

const CORRELATION_HEADER = "x-correlation-id";

function header(headers: APIGatewayProxyEventV2["headers"], name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

// The id the console sent, else the Function URL request id, else a fresh one.
function correlationIdOf(event: CreateContextOptions["event"]): string {
  return correlationIdFrom(header(event.headers, CORRELATION_HEADER) ?? event.requestContext?.requestId);
}

/**
 * Builds `createContext` over explicit dependencies (tests, the local UI server). It verifies
 * nothing: `worldProcedure` authenticates on first use, so public procedures never touch Cognito.
 */
export function createContextFactory(resolveDeps: () => ContextDeps) {
  return async ({ event }: CreateContextOptions): Promise<Context> => {
    const deps = resolveDeps();
    const correlationId = correlationIdOf(event);
    return { correlationId, deps, log: deps.loggerFor(correlationId), authorization: header(event.headers, "authorization"), inProcess: null, response: { accepted: false }, memo: {} };
  };
}

/** `createContext(event)` over the linked resources of the BFF Lambda. */
export const createContext = createContextFactory(defaultDeps);

export interface InProcessContextOptions {
  /** From `inProcessPrincipal` (auth/principal.ts): QA worlds only. */
  readonly principal: Principal;
  readonly deps: ContextDeps;
  readonly correlationId?: string;
}

/** Context of `appRouter.createCaller` for the QaDriver: the real procedures with a server-built principal. */
export function createInProcessContext(options: InProcessContextOptions): Context {
  const correlationId = correlationIdFrom(options.correlationId);
  return { correlationId, deps: options.deps, log: options.deps.loggerFor(correlationId), authorization: undefined, inProcess: options.principal, response: { accepted: false }, memo: {} };
}

const t = initTRPC.context<Context>().create({
  // Stack traces never travel to the browser, whatever NODE_ENV says inside the Lambda.
  isDev: false,
  errorFormatter({ shape, error, ctx }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        reason: error.cause instanceof AuthError ? error.cause.reason : reasonOf(error.cause),
        correlationId: ctx?.correlationId ?? null,
        zodError: error.cause instanceof z.ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

// Procedures throw the domain's typed errors (ToolError, ConnectorError); here they become the HTTP
// answer their code stands for instead of a 500 (errors.ts).
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const mapped = toTrpcError(result.error.cause);
    if (mapped) throw mapped;
  }
  return result;
});

const baseProcedure = t.procedure.use(domainErrors);

export const publicProcedure = baseProcedure;

const TRPC_CODE: Readonly<Record<AuthRefusal, TRPCError["code"]>> = {
  UNAUTHENTICATED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  BUSY: "CONFLICT",
  UNAVAILABLE: "SERVICE_UNAVAILABLE",
};

// Denials worth an `AuditLog DENY` entry in the principal's world; `outcome` names the rule.
const AUDITED: Partial<Record<AuthReason, string>> = {
  SERVER_CLIENT_AUDIENCE: "SERVER_CLIENT_AUDIENCE",
  STAFF_INACTIVE: "STAFF_INACTIVE",
  CROSS_WORLD: "CROSS_WORLD",
  READ_ONLY_ROLE: "ROLE",
  ROLE_NOT_ALLOWED: "ROLE",
  WORLD_NOT_ALLOWED: "WORLD_NOT_ALLOWED",
};

async function audit(ctx: Context, path: string, error: AuthError, principal: Principal, world: WorldMeta | undefined): Promise<void> {
  const outcome = AUDITED[error.reason];
  if (!outcome) return;
  try {
    await ctx.deps.audit.record({
      worldId: principal.worldId,
      epoch: world?.epoch ?? 0,
      action: AUDIT_ACTION.DENY,
      outcome,
      actor: actorOf(principal),
      refs: { path, staffId: principal.staffId, reason: error.reason },
    });
  } catch (cause) {
    // The refusal stands whether or not the audit write succeeded.
    ctx.log.error("console.audit.failed", { path, reason: error.reason, ...describeError(cause) });
  }
}

/** Logs, audits (when the principal is known) and throws the HTTP answer of a refusal. */
async function deny(ctx: Context, path: string, error: AuthError, principal?: Principal, world?: WorldMeta): Promise<never> {
  const fields = { path, reason: error.reason, ...(error.unavailable ? describeError(error.cause) : {}) };
  if (error.unavailable) ctx.log.error("console.auth.unavailable", fields);
  else ctx.log.warn("console.auth.refused", fields);
  if (principal) await audit(ctx, path, error, principal, world);
  throw new TRPCError({ code: TRPC_CODE[AUTH_REFUSAL[error.reason]], message: error.message, cause: error });
}

/** The only procedure that answers while the world is being reset (the console polls it). */
export const RESET_STATUS_PATH = "clock.resetStatus";

export const worldProcedure = baseProcedure.use(async ({ ctx, next, path, type }) => {
  ctx.memo.auth ??= ctx.inProcess ? authenticateInProcess(ctx.inProcess, ctx.deps) : authenticateToken(ctx.authorization, ctx.deps);
  const outcome = await ctx.memo.auth;
  if (!outcome.ok) return deny(ctx, path, outcome.error, outcome.principal, outcome.world);

  const { principal, world } = outcome;
  const log = ctx.log.child({ worldId: principal.worldId, staffId: principal.staffId, role: principal.role });
  const worldContext: WorldContext = { ...ctx, principal, world, log };
  // `guest.status` and `guest.requestWorld` answer in any status of the world; `account.session` too
  // while a self-signup world is being prepared (never during a reset, as before).
  const pending = WORLD_PENDING_PATHS.has(path);
  if (world.status === "RESETTING" && path !== RESET_STATUS_PATH && !path.startsWith("guest.")) {
    return deny(worldContext, path, new AuthError(AUTH_REASON.WORLD_RESETTING, "the world is being reset"));
  }
  if (world.status !== "READY" && world.status !== "RESETTING" && !pending) {
    return deny(worldContext, path, new AuthError(AUTH_REASON.WORLD_NOT_READY, "the world is not ready yet"));
  }
  // Every mutation refuses COMPLIANCE, whichever builder the router used (FL-095).
  if (type === "mutation" && principal.role === "COMPLIANCE") {
    return deny(worldContext, path, new AuthError(AUTH_REASON.READ_ONLY_ROLE, "the compliance role is read-only"), principal, world);
  }
  return next({ ctx: worldContext });
});

/** 403 CROSS_WORLD (and `AuditLog DENY CROSS_WORLD`) unless the id belongs to the world of the principal. */
export async function assertWorld(ctx: WorldContext, path: string, worldIdOfInput: string): Promise<void> {
  if (worldIdOfInput === ctx.principal.worldId) return;
  await deny(ctx, path, new AuthError(AUTH_REASON.CROSS_WORLD, "that item does not belong to your world"), ctx.principal, ctx.world);
}

export const ALL_ROLES: readonly StaffRole[] = StaffRole.options;

/** Who may call a procedure (docs/design-brief.md §9, docs/tool-catalog.md), checked in this order. */
export interface AccessGuard {
  readonly roles: readonly StaffRole[];
  /** Classes of world where the procedure exists at all (e.g. the agent kill switch, only `DEMO`). */
  readonly worldKinds?: readonly WorldKind[];
  /** Interactive sign-in at most 15 minutes old (real clock). */
  readonly recentLogin?: boolean;
}

async function enforceAccess(ctx: WorldContext, path: string, guard: AccessGuard): Promise<void> {
  const { principal } = ctx;
  if (!guard.roles.includes(principal.role)) {
    await deny(ctx, path, new AuthError(AUTH_REASON.ROLE_NOT_ALLOWED, `this procedure needs one of: ${guard.roles.join(", ")}`), principal, ctx.world);
  }
  const kind = worldKindOf(principal.worldId);
  if (guard.worldKinds && (!kind || !guard.worldKinds.includes(kind))) {
    await deny(ctx, path, new AuthError(AUTH_REASON.WORLD_NOT_ALLOWED, "this procedure does not exist in this world"), principal, ctx.world);
  }
  if (guard.recentLogin && !isSignInFresh(principal, ctx.deps.wallClock())) {
    await deny(ctx, path, new AuthError(AUTH_REASON.LOGIN_NOT_RECENT, "enter your password again to continue"));
  }
}

/** World + the guard of one procedure (COMPLIANCE is already refused every mutation by `worldProcedure`). */
export function guardedProcedure(guard: AccessGuard) {
  return worldProcedure.use(async ({ ctx, next, path }) => {
    await enforceAccess(ctx, path, guard);
    return next();
  });
}

/** World + one of `roles` (docs/design-brief.md §9); every mutation also refuses COMPLIANCE. */
export function roleProcedure(roles: readonly StaffRole[], options: Omit<AccessGuard, "roles"> = {}) {
  return guardedProcedure({ ...options, roles });
}

/** A recent interactive sign-in (real clock, ADR-0005): approve money, answer in writing, reset. */
export const recentLoginProcedure = guardedProcedure({ roles: ALL_ROLES, recentLogin: true });

/** A procedure that only started asynchronous work answers HTTP 202 (routers/handler.ts). */
export function acceptedAsync(ctx: Context): void {
  ctx.response.accepted = true;
}
