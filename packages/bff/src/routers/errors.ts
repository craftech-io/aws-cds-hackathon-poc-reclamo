// Domain errors → HTTP answers of the console. Procedures throw the same typed errors the tools
// throw (`ToolError` with a discriminated `code` and a `reason`, `ConnectorError` from the
// connector) and a tool called in process answers `{ ok: false, error }`; the trpc.ts middleware
// turns all of them into one TRPCError shape, and the `reason` travels to the console so it can
// react (re-enter the password, "above your cap", "an operator has the conversation").
import { TRPCError } from "@trpc/server";
import { ConnectorError, ErrorCode, ToolError } from "@reclamo/shared";
import type { ConnectorErrorCode } from "@reclamo/shared";
import { z } from "zod";

type TrpcCode = TRPCError["code"];

const BY_TOOL_CODE: Readonly<Record<ErrorCode, TrpcCode>> = {
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  INVALID: "BAD_REQUEST",
  CONFLICT: "CONFLICT",
  UNAVAILABLE: "SERVICE_UNAVAILABLE",
  NOT_IDENTIFIED: "PRECONDITION_FAILED",
  COMPLAINT_REQUIRED: "PRECONDITION_FAILED",
  EVIDENCE_REQUIRED: "PRECONDITION_FAILED",
  ABOVE_CAP: "FORBIDDEN",
  NOT_ELIGIBLE: "PRECONDITION_FAILED",
  POLICY_DENIED: "PRECONDITION_FAILED",
  DEFERRED: "PRECONDITION_FAILED",
  CONTROL_OPERATOR: "PRECONDITION_FAILED",
  TEMPLATE_REQUIRED: "PRECONDITION_FAILED",
  TEMPLATE_PARAM_NOT_ALLOWED: "BAD_REQUEST",
  RECIPIENT_NOT_ALLOWED: "FORBIDDEN",
  GROUNDING_FAIL: "PRECONDITION_FAILED",
  UNKNOWN_DELIVERY: "CONFLICT",
  TURN_CAP: "TOO_MANY_REQUESTS",
  AGENT_KILLED: "SERVICE_UNAVAILABLE",
};

// VALIDATION means a stored row does not match its schema: a data bug, never the caller's fault.
const BY_CONNECTOR_CODE: Readonly<Record<ConnectorErrorCode, TrpcCode>> = {
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION: "INTERNAL_SERVER_ERROR",
  THROTTLED: "TOO_MANY_REQUESTS",
  UNAVAILABLE: "SERVICE_UNAVAILABLE",
  TIMEOUT: "SERVICE_UNAVAILABLE",
};

/** The TRPCError a domain error stands for; `undefined` for anything else (left as it is). */
export function toTrpcError(error: unknown): TRPCError | undefined {
  if (error instanceof ToolError) return new TRPCError({ code: BY_TOOL_CODE[error.code], message: error.message, cause: error });
  if (error instanceof ConnectorError) {
    const code = BY_CONNECTOR_CODE[error.code];
    // The connector message names tables and keys: fine for the log, not for the browser.
    const message = code === "INTERNAL_SERVER_ERROR" || code === "SERVICE_UNAVAILABLE" ? "the data store could not complete the request" : error.message;
    return new TRPCError({ code, message, cause: error });
  }
  return undefined;
}

/** `reason` of the tRPC error `data`: the fine-grained code the console switches on. */
export function reasonOf(cause: unknown): string | null {
  if (cause instanceof ToolError) return cause.reason ?? cause.code;
  if (cause instanceof ConnectorError) return cause.code;
  return null;
}

/** Shorthand for the refusals procedures raise themselves. */
export function refusal(code: ErrorCode, message: string, reason?: string): ToolError {
  return new ToolError(code, message, reason);
}

/** Resolver of a procedure whose router is still a stub (docs/build-plan.md §1, note 8): HTTP 503. */
export function notImplemented(): never {
  throw refusal("UNAVAILABLE", "this procedure is not available yet", "NOT_IMPLEMENTED");
}

const FailureEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({ code: ErrorCode, message: z.string(), reason: z.string().optional() }),
});

export type ToolResponse = Readonly<Record<string, unknown>>;

/**
 * The payload of an in-process or remote tool call when it succeeded, parsed with `schema`;
 * otherwise the tool's own error, rethrown as a ToolError so the middleware maps it.
 */
export function requireToolOk<T>(response: ToolResponse, schema: z.ZodType<T>): T {
  const failure = FailureEnvelope.safeParse(response);
  if (failure.success) {
    const { code, message, reason } = failure.data.error;
    throw new ToolError(code, message, reason);
  }
  if (response.ok !== true) throw new ToolError("UNAVAILABLE", "the tool answered an unexpected envelope", "TOOL_OUTPUT");
  const parsed = schema.safeParse(response);
  if (!parsed.success) throw new ToolError("UNAVAILABLE", "the tool answered an unexpected shape", "TOOL_OUTPUT");
  return parsed.data;
}

/** `{ code, reason }` of a failed tool envelope, for results reported item by item. */
export function failureOf(response: ToolResponse): { code: ErrorCode; reason: string } | undefined {
  const failure = FailureEnvelope.safeParse(response);
  if (!failure.success) return response.ok === true ? undefined : { code: "UNAVAILABLE", reason: "TOOL_OUTPUT" };
  return { code: failure.data.error.code, reason: failure.data.error.reason ?? failure.data.error.code };
}
