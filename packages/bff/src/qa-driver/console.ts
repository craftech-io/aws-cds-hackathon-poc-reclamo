// `console.*` of the QaDriver (docs/tool-catalog.md): any procedure of the real `appRouter`, run in
// process by `createCaller` with a principal built on the server — `{sub: "qa", worldId, staffId:
// "stf-qa-<role>", role, authTime: input.authTime ?? now}`, `GUEST` only in `qa-*` — so `worldProcedure`,
// the role guards and the recent-login gate run for real (auth/principal.ts `inProcessPrincipal`).
// A refusal comes back as the domain's code and reason (`FORBIDDEN CROSS_WORLD`, `ROLE`, `RECENT_LOGIN`).
import { TRPCError } from "@trpc/server";
import { ConnectorError, type ErrorCode, ToolError } from "@reclamo/shared";
import { inProcessPrincipal } from "../auth/principal";
import { AuthError } from "../auth/errors";
import type { ContextDeps } from "../routers/deps";
import { appRouter, createCaller } from "../routers/index";
import { createInProcessContext } from "../routers/trpc";
import type { QaInput } from "./inputs";

const BY_TRPC_CODE: Partial<Record<TRPCError["code"], ErrorCode>> = {
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  UNAUTHORIZED: "FORBIDDEN",
  BAD_REQUEST: "INVALID",
  CONFLICT: "CONFLICT",
  PRECONDITION_FAILED: "NOT_ELIGIBLE",
  TOO_MANY_REQUESTS: "TURN_CAP",
  SERVICE_UNAVAILABLE: "UNAVAILABLE",
};

type ProcedureKind = "query" | "mutation" | "subscription";

/** Query or mutation of an appRouter path; `undefined` when the router has no such procedure. */
export function procedureKind(path: string): ProcedureKind | undefined {
  const procedure = (appRouter._def.procedures as Readonly<Record<string, { readonly _def?: { readonly type?: ProcedureKind } }>>)[path];
  return procedure?._def?.type;
}

/** The domain error a tRPC refusal stands for, with the reason the console would have read. */
export function consoleFailure(error: TRPCError): ToolError {
  const cause = error.cause;
  if (cause instanceof ToolError) return cause;
  const reason = cause instanceof AuthError ? cause.reason : cause instanceof ConnectorError ? cause.code : undefined;
  return new ToolError(BY_TRPC_CODE[error.code] ?? "UNAVAILABLE", error.message, reason ?? error.code);
}

/** Runs one console procedure as the server-built principal (see the header). */
export async function runConsole(deps: ContextDeps, input: QaInput<"console">, correlationId: string): Promise<unknown> {
  const kind = procedureKind(input.procedure);
  if (kind === undefined || kind === "subscription") throw new ToolError("INVALID", `the console has no procedure ${input.procedure}`, "NO_PROCEDURE");
  const authTime = input.authTime ?? Math.floor(deps.wallClock().getTime() / 1_000);
  const principal = inProcessPrincipal({ worldId: input.worldId, role: input.role, authTime });
  const caller = createCaller(createInProcessContext({ principal, deps, correlationId }));
  const [router, name] = input.procedure.split(".") as [string, string];
  const procedure = (caller as unknown as Readonly<Record<string, Readonly<Record<string, ((value?: unknown) => Promise<unknown>) | undefined>> | undefined>>)[router]?.[name];
  if (procedure === undefined) throw new ToolError("INVALID", `the console has no procedure ${input.procedure}`, "NO_PROCEDURE");
  try {
    return await procedure(input.input);
  } catch (error) {
    if (error instanceof TRPCError) throw consoleFailure(error);
    throw error;
  }
}
