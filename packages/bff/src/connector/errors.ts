// Errors of the connector edge. Every storage failure reaches the domain as a `ConnectorError`
// (@reclamo/shared) with a code the tools map to their envelope; a cancelled transaction also says
// which of its operations failed, so a caller that retries (appendChained, numbering) knows whether
// the chain head moved or its own condition failed (docs/architecture.md §8.3).
import { ConnectorError, type ConnectorErrorCode } from "@reclamo/shared";

/** DynamoDB's cancellation reason codes, one per operation of the transaction (`None` when it was fine). */
export type CancellationCode = "None" | "ConditionalCheckFailed" | "TransactionConflict" | "ThrottlingError" | "ValidationError" | "ItemCollectionSizeLimitExceeded" | string;

export class TransactionCancelledError extends ConnectorError {
  constructor(
    code: ConnectorErrorCode,
    readonly reasons: readonly CancellationCode[],
    table?: string,
    options?: ErrorOptions,
  ) {
    super(code, `transaction cancelled: ${reasons.join(", ")}`, table, options);
  }

  /** Positions of the operations whose condition failed. */
  failedConditions(): number[] {
    return this.reasons.flatMap((reason, index) => (reason === "ConditionalCheckFailed" ? [index] : []));
  }
}

/** The code a cancelled transaction maps to: a lost race or a failed condition is a `CONFLICT`. */
export function cancellationCode(reasons: readonly CancellationCode[]): ConnectorErrorCode {
  if (reasons.some((reason) => reason === "ThrottlingError")) return "THROTTLED";
  if (reasons.some((reason) => reason === "ValidationError")) return "VALIDATION";
  return "CONFLICT";
}

/** True for a failed condition or a lost race, the errors a caller answers by re-reading. */
export function isConflict(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}
