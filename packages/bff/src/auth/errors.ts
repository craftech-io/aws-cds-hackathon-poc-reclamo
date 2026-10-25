// Why a console request was refused. `reason` travels to the console in the tRPC error `data`
// so the web can react (re-authenticate, ask for the password again, show the reset screen)
// without parsing messages.
export const AUTH_REASON = {
  TOKEN_MISSING: "TOKEN_MISSING",
  TOKEN_INVALID: "TOKEN_INVALID",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /** The token is genuine but carries no world, staff id or role: the account is incomplete. */
  PRINCIPAL_INCOMPLETE: "PRINCIPAL_INCOMPLETE",
  /** A `ServerClient` token of a user that is not `qa-*`, or whose staff row is not in a `qa-*` world. */
  SERVER_CLIENT_AUDIENCE: "SERVER_CLIENT_AUDIENCE",
  /** The staff row named by the token does not exist, is inactive, has another role or another `sub`. */
  STAFF_INACTIVE: "STAFF_INACTIVE",
  ROLE_NOT_ALLOWED: "ROLE_NOT_ALLOWED",
  /** Every mutation is refused to `COMPLIANCE` (FL-095). */
  READ_ONLY_ROLE: "READ_ONLY_ROLE",
  CROSS_WORLD: "CROSS_WORLD",
  /** The procedure exists only in some classes of world (e.g. the agent kill switch, only in `demo`). */
  WORLD_NOT_ALLOWED: "WORLD_NOT_ALLOWED",
  /** An in-process principal (QaDriver) outside a QA world, or `GUEST` outside a `qa-*` world. */
  IN_PROCESS_WORLD_DENIED: "IN_PROCESS_WORLD_DENIED",
  /** The last interactive sign-in is older than 15 minutes: approving money needs a fresh password. */
  LOGIN_NOT_RECENT: "LOGIN_NOT_RECENT",
  /** The world is being reset; only `clock.resetStatus` answers (docs/architecture.md §10). */
  WORLD_RESETTING: "WORLD_RESETTING",
  /** The world has no `META`, or it is still `REGISTERED` or `CREATING`. */
  WORLD_NOT_READY: "WORLD_NOT_READY",
  /** Cognito (JWKS) or the staff directory could not be reached; the request fails closed. */
  AUTH_UNAVAILABLE: "AUTH_UNAVAILABLE",
} as const;
export type AuthReason = (typeof AUTH_REASON)[keyof typeof AUTH_REASON];

/** What a refusal means over HTTP: 401, 403, 409 or 503. */
export type AuthRefusal = "UNAUTHENTICATED" | "FORBIDDEN" | "BUSY" | "UNAVAILABLE";

export const AUTH_REFUSAL: Readonly<Record<AuthReason, AuthRefusal>> = {
  TOKEN_MISSING: "UNAUTHENTICATED",
  TOKEN_INVALID: "UNAUTHENTICATED",
  TOKEN_EXPIRED: "UNAUTHENTICATED",
  PRINCIPAL_INCOMPLETE: "UNAUTHENTICATED",
  SERVER_CLIENT_AUDIENCE: "UNAUTHENTICATED",
  STAFF_INACTIVE: "FORBIDDEN",
  ROLE_NOT_ALLOWED: "FORBIDDEN",
  READ_ONLY_ROLE: "FORBIDDEN",
  CROSS_WORLD: "FORBIDDEN",
  WORLD_NOT_ALLOWED: "FORBIDDEN",
  IN_PROCESS_WORLD_DENIED: "FORBIDDEN",
  LOGIN_NOT_RECENT: "FORBIDDEN",
  WORLD_RESETTING: "BUSY",
  WORLD_NOT_READY: "BUSY",
  AUTH_UNAVAILABLE: "UNAVAILABLE",
};

/** Error class and message only, for log lines: stacks and causes may quote request data. */
export function describeError(error: unknown): { errorName: string; errorMessage?: string } {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message };
  return { errorName: "UnknownError" };
}

export class AuthError extends Error {
  override readonly name = "AuthError";
  constructor(
    readonly reason: AuthReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  /** True when retrying later may succeed: nothing is wrong with the caller's credentials. */
  get unavailable(): boolean {
    return this.reason === AUTH_REASON.AUTH_UNAVAILABLE;
  }
}
