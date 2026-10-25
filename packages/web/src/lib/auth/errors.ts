// What went wrong in a sign-in step, as the screen needs it. Cognito's error types are collapsed
// into a few codes whose texts never say whether a username has an account: a wrong password, an
// unknown user and an account that must reset its password all read the same.
import { CognitoError } from "./cognito";
import { SrpError } from "./srp";

export type AuthFlowErrorCode =
  /** Username or password not accepted (never says which, nor whether the account exists). */
  | "INVALID_CREDENTIALS"
  /** A TOTP code that is wrong or expired. */
  | "INVALID_CODE"
  /** The new password does not meet the pool's policy. */
  | "WEAK_PASSWORD"
  /** The challenge took too long; start again from the username and password. */
  | "SESSION_EXPIRED"
  | "TOO_MANY_ATTEMPTS"
  /** Cognito or the network did not answer. */
  | "UNAVAILABLE"
  /** A challenge this console does not handle (SMS or email MFA are not configured). */
  | "UNSUPPORTED"
  /** A step-up that signed in as somebody else than the current session. */
  | "DIFFERENT_USER";

export type FlowStep = "credentials" | "challenge" | "setup";

const THROTTLED = new Set(["LimitExceededException", "TooManyRequestsException", "TooManyFailedAttemptsException"]);
const BAD_CODE = new Set(["CodeMismatchException", "ExpiredCodeException", "EnableSoftwareTokenMFAException"]);
// Refusals of the username + password step. PasswordResetRequired and UserNotConfirmed would reveal
// that the account exists, so they are reported as a plain rejection too.
const REJECTED = new Set([
  "NotAuthorizedException",
  "UserNotFoundException",
  "PasswordResetRequiredException",
  "UserNotConfirmedException",
  "InvalidParameterException",
]);

export function errorCodeOf(error: unknown, step: FlowStep): AuthFlowErrorCode {
  if (error instanceof SrpError) return "INVALID_CREDENTIALS";
  if (!(error instanceof CognitoError)) return "UNAVAILABLE";
  const { type } = error;
  if (THROTTLED.has(type)) return "TOO_MANY_ATTEMPTS";
  if (type === "InvalidPasswordException") return step === "credentials" ? "INVALID_CREDENTIALS" : "WEAK_PASSWORD";
  switch (step) {
    case "credentials":
      return REJECTED.has(type) ? "INVALID_CREDENTIALS" : "UNAVAILABLE";
    case "challenge":
    case "setup":
      if (BAD_CODE.has(type)) return "INVALID_CODE";
      // A challenge session that expired or was already used answers NotAuthorized.
      return type === "NotAuthorizedException" ? "SESSION_EXPIRED" : "UNAVAILABLE";
  }
}
