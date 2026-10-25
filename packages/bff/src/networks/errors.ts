// What a call to the simulated networks can end in, besides its answer. The client already retried
// what is worth retrying, so every `NetworkClientError` is final for the call that got it:
//
//   a contract code   the network refused (400 INVALID, 403 FORBIDDEN / CALLER_*, 404, 409 CONFLICT
//                     with `actionId` on the reversal, 422 ABOVE_CAP / NOT_ELIGIBLE …): nothing moved
//   UNAVAILABLE       retries exhausted (503, 429, 5xx, timeouts, network errors) or unsigned
//   INVALID_RESPONSE  an answer outside the contract: never used as data
import type { ContractErrorCode } from "@reclamo/core-contract";

export type NetworkFailureCode = ContractErrorCode | "INVALID_RESPONSE";

export interface NetworkErrorDetails {
  /** Attempts made, the first one included. */
  readonly attempts: number;
  /** HTTP status of the last answer, when there was one. */
  readonly status?: number;
  /** With `CONFLICT` on the reversal: the action that already holds the `TRV#` claim. */
  readonly actionId?: string;
}

export class NetworkClientError extends Error {
  override readonly name = "NetworkClientError";
  /** Final: the client already spent its retries. */
  readonly retryable = false;
  constructor(
    readonly code: NetworkFailureCode,
    message: string,
    readonly details: NetworkErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isNetworkConflict(error: unknown): error is NetworkClientError {
  return error instanceof NetworkClientError && error.code === "CONFLICT";
}
