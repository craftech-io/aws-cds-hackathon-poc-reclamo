// A refusal of the network mock: a contract error code (docs/architecture-integrations.md §5-§6)
// that the HTTP layer turns into its status and `ErrorBody`. Messages are fixed text of the mock,
// never data from the request (an echo could carry anything).
import type { ContractErrorCode, ResourceId } from "@reclamo/core-contract";

export class NetworkError extends Error {
  override readonly name = "NetworkError";
  constructor(
    readonly code: ContractErrorCode,
    message: string,
    /** Only with `CONFLICT` on a money route: the action that already holds the claim. */
    readonly actionId?: ResourceId,
  ) {
    super(message);
  }
}

/** A dependency (DynamoDB, S3) failed or timed out: the caller retries with backoff. */
export class NetworkUnavailableError extends Error {
  override readonly name = "NetworkUnavailableError";
}
