// Wiring of the sign-in machine for the browser: the real Cognito client and SRP, plus the one
// question the machine asks about a token set. Kept apart from flow.ts so tests pass a fake Cognito
// through the same functions the console uses.
import { parseIdTokenClaims } from "../auth-claims";
import type { CognitoApi } from "./cognito";
import type { AuthFlowDeps, FlowMode } from "./flow";
import type { SrpClient } from "./srp";
import type { TokenSet } from "./tokens";

export function subOf(tokens: TokenSet): string | undefined {
  try {
    return parseIdTokenClaims(tokens.idToken).sub;
  } catch {
    return undefined;
  }
}

export function flowDeps(cognito: CognitoApi, srp: SrpClient, mode: FlowMode, now: () => number = Date.now): AuthFlowDeps {
  return { cognito, srp, mode, now, subOf };
}
