// The console's sign-in as a small state machine: a state, an action, and `advance` computes the
// next state against Cognito. No React here, so every path (first login with a temporary password,
// TOTP enrolment inside MFA_SETUP, the TOTP code, an expired challenge) is unit-tested with a fake
// Cognito (flow.test.ts).
//
//   credentials ──signIn──▶ SRP ──▶ newPassword ──▶ (mfaSetup | totp | done)
//                           ├──▶ totp ─────────▶ done
//                           ├──▶ mfaSetup ─────▶ done        (Cognito MFA_SETUP, inside the sign-in)
//                           └──▶ done
//
// The pool is username-based (docs/architecture.md §11): `operator-01`, `guest-03`, and the email of a
// self-signup guest. Only a self-signup guest recovers a password, through the BFF's public
// procedures (lib/auth/public-api.ts); staff recover through an administrator. There is no TOTP
// enrolment after sign-in: the access token carries no user-admin scope (ADR-0018).
//
// The same machine runs the recent-login step-up (mode `stepUp`): approving money, answering in
// writing and resetting a world need an interactive sign-in in the last 15 minutes (`auth_time`,
// ADR-0005), so the console signs the same person in again, in place, and swaps the tokens.
import { type AuthResponse, type CognitoApi, TOTP_MFA } from "./cognito";
import { missingPasswordRules, normalizeTotpCode, normalizeUsername } from "./credentials";
import { type AuthFlowErrorCode, type FlowStep, errorCodeOf } from "./errors";
import type { SrpClient } from "./srp";
import { type TokenSet, tokenSetOf } from "./tokens";

export type FlowMode = { readonly kind: "signIn" } | { readonly kind: "stepUp"; readonly sub: string; readonly username: string };

/** A pending Cognito challenge: who (USER_ID_FOR_SRP) and the session that answers it. */
export interface ChallengeContext {
  /** What the person typed, normalized: shown next to the TOTP secret. */
  readonly login: string;
  /** What Cognito calls the user in its challenges. */
  readonly username: string;
  readonly session: string;
}

export interface MfaSetup {
  readonly login: string;
  /** Base32 secret for the authenticator app. Memory only: never stored, never logged. */
  readonly secret: string;
  readonly username: string;
  readonly session: string;
}

export type AuthFlowState =
  | { readonly step: "credentials" }
  | { readonly step: "newPassword"; readonly challenge: ChallengeContext }
  | { readonly step: "totp"; readonly challenge: ChallengeContext }
  | { readonly step: "mfaSetup"; readonly setup: MfaSetup }
  /** `totpVerified`: this sign-in passed a TOTP code. */
  | { readonly step: "done"; readonly tokens: TokenSet; readonly totpVerified: boolean };

export type AuthFlowAction =
  | { readonly type: "signIn"; readonly username: string; readonly password: string }
  | { readonly type: "newPassword"; readonly password: string }
  | { readonly type: "totp"; readonly code: string }
  | { readonly type: "verifyMfaSetup"; readonly code: string }
  | { readonly type: "restart" };

export interface Transition {
  readonly state: AuthFlowState;
  readonly error?: AuthFlowErrorCode;
}

export interface AuthFlowDeps {
  readonly cognito: CognitoApi;
  readonly srp: SrpClient;
  readonly mode: FlowMode;
  readonly now: () => number;
  /** `sub` of the id token, to tell whether a step-up signed in the same person. */
  readonly subOf: (tokens: TokenSet) => string | undefined;
}

export const INITIAL_STATE: AuthFlowState = { step: "credentials" };

function stay(state: AuthFlowState, error: AuthFlowErrorCode): Transition {
  return { state, error };
}

function restart(error: AuthFlowErrorCode): Transition {
  return { state: INITIAL_STATE, error };
}

/** Runs one action. Never throws for a Cognito or network failure: that comes back as `error`. */
export async function advance(state: AuthFlowState, action: AuthFlowAction, deps: AuthFlowDeps): Promise<Transition> {
  if (action.type === "restart") return { state: INITIAL_STATE };
  switch (state.step) {
    case "credentials":
      return action.type === "signIn" ? signIn(state, action.username, action.password, deps) : { state };
    case "newPassword":
      return action.type === "newPassword" ? newPassword(state, state.challenge, action.password, deps) : { state };
    case "totp":
      return action.type === "totp" ? totp(state, state.challenge, action.code, deps) : { state };
    case "mfaSetup":
      return action.type === "verifyMfaSetup" ? verifyMfaSetup(state, state.setup, action.code, deps) : { state };
    case "done":
      return { state };
  }
}

async function signIn(state: AuthFlowState, rawUsername: string, password: string, deps: AuthFlowDeps): Promise<Transition> {
  // A step-up signs in the person already in session, whatever the form says.
  const login = deps.mode.kind === "stepUp" ? deps.mode.username : normalizeUsername(rawUsername);
  if (!login || !password) return stay(state, "INVALID_CREDENTIALS");
  try {
    const exchange = await deps.srp.start(login, password);
    const verifier = await deps.cognito.initiateSrp(login, exchange.srpA);
    if (verifier.ChallengeName !== "PASSWORD_VERIFIER" || !verifier.ChallengeParameters) return stay(state, "UNSUPPORTED");
    const responses = await exchange.sign(verifier.ChallengeParameters);
    const answer = await deps.cognito.respondToChallenge("PASSWORD_VERIFIER", responses, verifier.Session);
    return await onAuthResponse(answer, { login, username: responses.USERNAME ?? login }, false, deps);
  } catch (error) {
    return stay(state, errorCodeOf(error, "credentials"));
  }
}

async function newPassword(state: AuthFlowState, challenge: ChallengeContext, password: string, deps: AuthFlowDeps): Promise<Transition> {
  if (missingPasswordRules(password).length > 0) return stay(state, "WEAK_PASSWORD");
  return inChallenge(state, "challenge", async () => {
    const answer = await deps.cognito.respondToChallenge("NEW_PASSWORD_REQUIRED", { USERNAME: challenge.username, NEW_PASSWORD: password }, challenge.session);
    return onAuthResponse(answer, challenge, false, deps);
  });
}

async function totp(state: AuthFlowState, challenge: ChallengeContext, rawCode: string, deps: AuthFlowDeps): Promise<Transition> {
  const code = normalizeTotpCode(rawCode);
  if (!code) return stay(state, "INVALID_CODE");
  return inChallenge(state, "challenge", async () => {
    const answer = await deps.cognito.respondToChallenge("SOFTWARE_TOKEN_MFA", { USERNAME: challenge.username, SOFTWARE_TOKEN_MFA_CODE: code }, challenge.session);
    return onAuthResponse(answer, challenge, true, deps);
  });
}

async function verifyMfaSetup(state: AuthFlowState, setup: MfaSetup, rawCode: string, deps: AuthFlowDeps): Promise<Transition> {
  const code = normalizeTotpCode(rawCode);
  if (!code) return stay(state, "INVALID_CODE");
  return inChallenge(state, "setup", async () => {
    const verified = await deps.cognito.verifySoftwareToken(setup.session, code);
    if (!verified.ok) return stay(state, "INVALID_CODE");
    const answer = await deps.cognito.respondToChallenge("MFA_SETUP", { USERNAME: setup.username }, verified.session ?? setup.session);
    return onAuthResponse(answer, { login: setup.login, username: setup.username }, true, deps);
  });
}

// A failure inside a challenge keeps the step, except an expired session, which starts over.
async function inChallenge(state: AuthFlowState, step: FlowStep, run: () => Promise<Transition>): Promise<Transition> {
  try {
    return await run();
  } catch (error) {
    const code = errorCodeOf(error, step);
    return code === "SESSION_EXPIRED" ? restart(code) : stay(state, code);
  }
}

async function onAuthResponse(
  response: AuthResponse,
  who: { readonly login: string; readonly username: string },
  totpVerified: boolean,
  deps: AuthFlowDeps,
): Promise<Transition> {
  if (response.AuthenticationResult) return afterTokens(tokenSetOf(response.AuthenticationResult, deps.now()), totpVerified, deps);
  const session = response.Session;
  if (!session) return restart("UNAVAILABLE");
  const username = response.ChallengeParameters?.USER_ID_FOR_SRP ?? who.username;
  const challenge: ChallengeContext = { login: who.login, username, session };
  switch (response.ChallengeName) {
    case "NEW_PASSWORD_REQUIRED":
      return { state: { step: "newPassword", challenge } };
    case "SOFTWARE_TOKEN_MFA":
      return { state: { step: "totp", challenge } };
    case "SELECT_MFA_TYPE": {
      if (!listParam(response, "MFAS_CAN_CHOOSE").includes(TOTP_MFA)) return restart("UNSUPPORTED");
      const answer = await deps.cognito.respondToChallenge("SELECT_MFA_TYPE", { USERNAME: username, ANSWER: TOTP_MFA }, session);
      return onAuthResponse(answer, challenge, totpVerified, deps);
    }
    case "MFA_SETUP": {
      const canSetup = listParam(response, "MFAS_CAN_SETUP");
      if (canSetup.length > 0 && !canSetup.includes(TOTP_MFA)) return restart("UNSUPPORTED");
      const association = await deps.cognito.associateSoftwareToken(session);
      return { state: { step: "mfaSetup", setup: { login: who.login, secret: association.secretCode, username, session: association.session ?? session } } };
    }
    default:
      return restart("UNSUPPORTED");
  }
}

// Cognito sends list parameters as JSON strings (`["SOFTWARE_TOKEN_MFA"]`).
function listParam(response: AuthResponse, name: string): string[] {
  const raw = response.ChallengeParameters?.[name];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function afterTokens(tokens: TokenSet, totpVerified: boolean, deps: AuthFlowDeps): Promise<Transition> {
  if (deps.mode.kind === "stepUp" && deps.subOf(tokens) !== deps.mode.sub) {
    // Somebody else's session must not outlive this screen.
    if (tokens.refreshToken) await deps.cognito.revoke(tokens.refreshToken).catch(() => undefined);
    return restart("DIFFERENT_USER");
  }
  return { state: { step: "done", tokens, totpVerified } };
}

/**
 * The sign-in right after a confirmed self-signup (docs/landing-spec.md §9.3): the email and the
 * password the person typed a moment ago, without a screen. The tokens when Cognito answered them
 * at once; `undefined` for anything else (a challenge, a refusal, the network), and the caller sends
 * the person to `/login` with the "account confirmed" notice instead.
 */
export async function silentSignIn(username: string, password: string, deps: AuthFlowDeps): Promise<TokenSet | undefined> {
  const transition = await advance(INITIAL_STATE, { type: "signIn", username, password }, deps);
  return transition.state.step === "done" ? transition.state.tokens : undefined;
}
