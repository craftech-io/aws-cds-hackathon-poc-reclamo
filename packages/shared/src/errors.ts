// Typed errors for the three edges (tool, channel, connector) and the `{ ok, error }` envelope
// every tool returns instead of throwing (docs/tool-catalog.md, Convenciones).
import { z } from "zod";
import { Channel, ErrorCode } from "./enums";

// Detail codes that qualify an ErrorCode; the model only sees `code`, the reason feeds logs and
// the turn retry (SESSION_EXPIRED) or the outbound pipeline (GROUNDING_FAIL).
export const ERROR_REASON = {
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_INVALID: "SESSION_INVALID",
  CROSS_WORLD: "CROSS_WORLD",
  IDENTITY_UNKNOWN: "IDENTITY_UNKNOWN",
  GROUNDING_FAIL: "GROUNDING_FAIL",
  ROLE_NOT_ALLOWED: "ROLE_NOT_ALLOWED",
  NOT_IN_SESSION: "NOT_IN_SESSION",
} as const;
export type ErrorReason = (typeof ERROR_REASON)[keyof typeof ERROR_REASON];

export const ToolErrorSchema = z.object({
  code: ErrorCode,
  message: z.string(),
  reason: z.string().optional(),
});
export type ToolErrorShape = z.infer<typeof ToolErrorSchema>;

export const ToolFailureSchema = z.object({ ok: z.literal(false), error: ToolErrorSchema });
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

export type ToolOk<T extends object> = { ok: true } & T;
export type ToolResult<T extends object> = ToolOk<T> | ToolFailure;

export function ok<T extends object>(data: T): ToolOk<T> {
  return { ok: true, ...data };
}

export function fail(code: ErrorCode, message: string, reason?: string): ToolFailure {
  return { ok: false, error: reason === undefined ? { code, message } : { code, message, reason } };
}

export class ToolError extends Error {
  override readonly name = "ToolError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  toFailure(): ToolFailure {
    return fail(this.code, this.message, this.reason);
  }
}

export const ChannelErrorCode = z.enum([
  "INVALID",
  "PARSE_FAILED",
  "SEND_FAILED",
  "UNAVAILABLE",
  "OPTED_OUT",
  "RATE_LIMITED",
  "TIMEOUT",
]);
export type ChannelErrorCode = z.infer<typeof ChannelErrorCode>;

const RETRYABLE_CHANNEL: ReadonlySet<ChannelErrorCode> = new Set<ChannelErrorCode>(["SEND_FAILED", "RATE_LIMITED", "TIMEOUT"]);

export class ChannelError extends Error {
  override readonly name = "ChannelError";
  readonly retryable: boolean;
  constructor(
    readonly code: ChannelErrorCode,
    readonly channel: Channel,
    message: string,
    options?: ErrorOptions & { retryable?: boolean },
  ) {
    super(message, options);
    this.retryable = options?.retryable ?? RETRYABLE_CHANNEL.has(code);
  }
}

export const ConnectorErrorCode = z.enum(["NOT_FOUND", "CONFLICT", "VALIDATION", "THROTTLED", "UNAVAILABLE", "TIMEOUT"]);
export type ConnectorErrorCode = z.infer<typeof ConnectorErrorCode>;

const RETRYABLE_CONNECTOR: ReadonlySet<ConnectorErrorCode> = new Set<ConnectorErrorCode>(["THROTTLED", "UNAVAILABLE", "TIMEOUT"]);

export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  readonly retryable: boolean;
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly table?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.retryable = RETRYABLE_CONNECTOR.has(code);
  }
}

const CONNECTOR_TO_TOOL: Readonly<Record<ConnectorErrorCode, ErrorCode>> = {
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION: "INVALID",
  THROTTLED: "UNAVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
  TIMEOUT: "UNAVAILABLE",
};

const CHANNEL_TO_TOOL: Readonly<Record<ChannelErrorCode, ErrorCode>> = {
  INVALID: "INVALID",
  PARSE_FAILED: "INVALID",
  SEND_FAILED: "UNAVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
  OPTED_OUT: "POLICY_DENIED",
  RATE_LIMITED: "UNAVAILABLE",
  TIMEOUT: "UNAVAILABLE",
};

// Converts anything thrown inside a handler into the envelope. Unknown errors become UNAVAILABLE
// with a generic message: the model never sees stack traces or internal text.
export function toToolFailure(error: unknown): ToolFailure {
  if (error instanceof ToolError) return error.toFailure();
  if (error instanceof ConnectorError) return fail(CONNECTOR_TO_TOOL[error.code], error.message, error.code);
  if (error instanceof ChannelError) return fail(CHANNEL_TO_TOOL[error.code], error.message, error.code);
  if (error instanceof z.ZodError) return fail("INVALID", "invalid input", "VALIDATION");
  return fail("UNAVAILABLE", "temporary failure, try again later");
}

export function isRetryable(error: unknown): boolean {
  return (error instanceof ChannelError || error instanceof ConnectorError) && error.retryable;
}
