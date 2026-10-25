// Cognito's errors as the QaDriver answers them: every one comes back to the runner with an explicit
// `reason` (QA_REASON), never as an `UNAVAILABLE` without one. The trigger's sign-in refusals keep their
// own mapping (stage-cognito.ts `triggerRefusal`); a `ToolError` passes through as it is.
import { ToolError } from "@reclamo/shared";
import { QA_REASON } from "./contract";

const RATE_LIMITED = new Set(["TooManyRequestsException", "LimitExceededException", "TooManyFailedAttemptsException"]);
const INVALID = new Set(["InvalidPasswordException", "InvalidParameterException", "CodeMismatchException", "ExpiredCodeException"]);
const TRIGGER = new Set(["UserLambdaValidationException", "UnexpectedLambdaException", "InvalidLambdaResponseException"]);

export function cognitoRefusal(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  const name = error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? error.message : "";
  const options = { cause: error };
  // `AdminConfirmSignUp` of a confirmed account: "User cannot be confirmed. Current status is CONFIRMED".
  if (name === "NotAuthorizedException" && /status is CONFIRMED/i.test(message)) return new ToolError("CONFLICT", "the account is confirmed already", QA_REASON.ALREADY_CONFIRMED, options);
  if (name === "NotAuthorizedException") return new ToolError("FORBIDDEN", "Cognito refused the call", QA_REASON.COGNITO_NOT_AUTHORIZED, options);
  if (name === "UserNotConfirmedException") return new ToolError("FORBIDDEN", "the account is not confirmed", QA_REASON.NOT_CONFIRMED, options);
  if (name === "UserNotFoundException") return new ToolError("NOT_FOUND", "no such account", QA_REASON.USER_NOT_FOUND, options);
  if (RATE_LIMITED.has(name)) return new ToolError("UNAVAILABLE", "Cognito throttled the call", QA_REASON.COGNITO_RATE_LIMITED, options);
  if (INVALID.has(name)) return new ToolError("INVALID", `Cognito refused the input (${name})`, QA_REASON.COGNITO_INVALID, options);
  if (TRIGGER.has(name)) return new ToolError("UNAVAILABLE", `a trigger of the pool failed (${name})`, QA_REASON.TRIGGER_FAILED, options);
  return new ToolError("UNAVAILABLE", `Cognito answered ${name}`, QA_REASON.COGNITO_UNAVAILABLE, options);
}

/** Runs a Cognito call and answers its failure as `cognitoRefusal` does. */
export async function mappedCognito<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw cognitoRefusal(error);
  }
}
