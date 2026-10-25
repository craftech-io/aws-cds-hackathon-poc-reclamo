// What a call to the lender core can end in, besides its answer. A `CoreError` carries the
// contract's code (and the existing `actionId` of a `CONFLICT` on a money route) and extends
// `ToolError`, so a tool that lets it through answers the model with the tool's own code
// (`toToolFailure`): `ABOVE_CAP`, `CONFLICT`, `FORBIDDEN`, `NOT_ELIGIBLE`…, never the core's text.
import type { ContractErrorCode } from "@reclamo/core-contract";
import { type ErrorCode, ToolError } from "@reclamo/shared";

/** How each contract code reaches a tool. */
const TOOL_CODE: Readonly<Record<ContractErrorCode, ErrorCode>> = {
  INVALID: "INVALID",
  WORLD_NOT_FOUND: "NOT_FOUND",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  // A role or world the core refuses is a deployment fault, never something the model can fix.
  CALLER_NOT_ALLOWED: "UNAVAILABLE",
  CALLER_WORLD_DENIED: "UNAVAILABLE",
  CONFLICT: "CONFLICT",
  ABOVE_CAP: "ABOVE_CAP",
  EXCEEDS_OUTSTANDING: "NOT_ELIGIBLE",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  UNAVAILABLE: "UNAVAILABLE",
};

export interface CoreErrorDetail {
  /** HTTP status of the last attempt; absent when the core never answered (timeout, network). */
  readonly status?: number;
  readonly attempts: number;
  /** The action that already holds the claim (`CONFLICT` on a money route). */
  readonly actionId?: string;
}

export class CoreError extends ToolError {
  readonly status?: number;
  readonly attempts: number;
  readonly actionId?: string;
  readonly retryable: boolean;

  constructor(
    readonly contractCode: ContractErrorCode,
    message: string,
    detail: CoreErrorDetail,
    options?: ErrorOptions,
  ) {
    super(TOOL_CODE[contractCode], message, contractCode, options);
    this.attempts = detail.attempts;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.actionId !== undefined) this.actionId = detail.actionId;
    this.retryable = contractCode === "UNAVAILABLE";
  }
}
