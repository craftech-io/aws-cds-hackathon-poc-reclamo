// A failed console call as the views need it: a kind that decides what to show, the tRPC code and
// HTTP status, the BFF's fine-grained `reason` (an old sign-in, a file that is not complete)
// and the correlation id support asks for. The error crossed the network, so its shape is parsed
// with zod before anything reads it.
import { z } from "zod";

export type ApiErrorKind =
  | "recentLogin"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "invalid"
  | "precondition"
  | "unavailable"
  | "network"
  | "unknown";

export interface ApiError {
  readonly kind: ApiErrorKind;
  /** tRPC error code (`FORBIDDEN`, `CONFLICT`, …); `NETWORK` or `UNKNOWN` when the BFF never answered. */
  readonly code: string;
  readonly httpStatus: number | null;
  readonly reason: string | null;
  readonly correlationId: string | null;
  readonly message: string;
}

const ClientErrorShape = z.object({
  message: z.string(),
  data: z
    .object({
      code: z.string(),
      httpStatus: z.number().optional(),
      reason: z.string().nullable().optional(),
      correlationId: z.string().nullable().optional(),
    })
    .nullish(),
});

/** The refusal a fresh sign-in fixes (packages/bff/src/routers/trpc.ts, `recentLoginProcedure`). */
export const RECENT_LOGIN_REASONS: ReadonlySet<string> = new Set(["LOGIN_NOT_RECENT"]);

const KIND_BY_CODE: Readonly<Record<string, ApiErrorKind>> = {
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "notFound",
  CONFLICT: "conflict",
  BAD_REQUEST: "invalid",
  PRECONDITION_FAILED: "precondition",
  SERVICE_UNAVAILABLE: "unavailable",
  TOO_MANY_REQUESTS: "unavailable",
  INTERNAL_SERVER_ERROR: "unavailable",
  TIMEOUT: "unavailable",
};

const Named = z.object({ name: z.string() });
const WithCause = z.object({ cause: z.unknown() });

/** A request the view itself cancelled (key changed, unmount): not an error to show. */
export function isAbortError(error: unknown): boolean {
  const named = Named.safeParse(error);
  if (named.success && named.data.name === "AbortError") return true;
  const wrapped = WithCause.safeParse(error);
  return wrapped.success && wrapped.data.cause !== undefined && wrapped.data.cause !== error && isAbortError(wrapped.data.cause);
}

export function toApiError(error: unknown): ApiError {
  const parsed = ClientErrorShape.safeParse(error);
  if (!parsed.success) {
    return { kind: "unknown", code: "UNKNOWN", httpStatus: null, reason: null, correlationId: null, message: error instanceof Error ? error.message : String(error) };
  }
  const { message, data } = parsed.data;
  // A client error without server data never got an answer: timeout, offline.
  if (!data) return { kind: "network", code: "NETWORK", httpStatus: null, reason: null, correlationId: null, message };
  const reason = data.reason ?? null;
  const kind: ApiErrorKind = reason !== null && RECENT_LOGIN_REASONS.has(reason) ? "recentLogin" : (KIND_BY_CODE[data.code] ?? "unknown");
  return { kind, code: data.code, httpStatus: data.httpStatus ?? null, reason, correlationId: data.correlationId ?? null, message };
}

/** Same as `toApiError`; both names are in use across the views. */
export const apiErrorOf = toApiError;
