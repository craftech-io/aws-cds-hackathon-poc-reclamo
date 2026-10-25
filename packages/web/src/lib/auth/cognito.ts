// The Cognito user-pool API calls the console makes, straight over fetch (JSON 1.1 protocol, the
// same endpoint the AWS SDK uses). Every operation here rides on the public client id or a challenge
// session, never on the access token: the pre-token trigger suppresses the
// `aws.cognito.signin.user.admin` scope for every group (ADR-0018), so the browser cannot change
// attributes, passwords or MFA settings, and TOTP is enrolled only inside the sign-in (MFA_SETUP).
// There is no "forgot password": recovery is by an administrator only (docs/architecture.md §11).
// Keeping the SDK out keeps the login bundle small; zod keeps the answers honest.
import { z } from "zod";
import { fetchWithRetry } from "../http";

export const TOTP_MFA = "SOFTWARE_TOKEN_MFA";

const AuthenticationResult = z.object({
  IdToken: z.string().min(1),
  AccessToken: z.string().min(1),
  RefreshToken: z.string().min(1).optional(),
  ExpiresIn: z.number().int().positive(),
});
export type AuthenticationResult = z.infer<typeof AuthenticationResult>;

const AuthResponse = z.object({
  AuthenticationResult: AuthenticationResult.optional(),
  ChallengeName: z.string().optional(),
  ChallengeParameters: z.record(z.string(), z.string()).optional(),
  Session: z.string().optional(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

const AssociateResponse = z.object({ SecretCode: z.string().min(16), Session: z.string().optional() });
const VerifyResponse = z.object({ Status: z.enum(["SUCCESS", "ERROR"]), Session: z.string().optional() });
const Empty = z.object({});

/** A Cognito refusal, by its error type (`NotAuthorizedException`, `CodeMismatchException`, …). */
export class CognitoError extends Error {
  override readonly name = "CognitoError";
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the sign-in flow needs of Cognito. `createCognitoApi` talks to AWS; tests use a fake. */
export interface CognitoApi {
  initiateSrp(username: string, srpA: string): Promise<AuthResponse>;
  respondToChallenge(challengeName: string, responses: Readonly<Record<string, string>>, session?: string): Promise<AuthResponse>;
  /** TOTP enrolment inside the MFA_SETUP challenge, with its session. */
  associateSoftwareToken(session: string): Promise<{ secretCode: string; session?: string }>;
  verifySoftwareToken(session: string, code: string): Promise<{ ok: boolean; session?: string }>;
  refresh(refreshToken: string): Promise<AuthenticationResult>;
  revoke(refreshToken: string): Promise<void>;
}

export interface CognitoApiConfig {
  readonly region: string;
  readonly clientId: string;
  /** Test seam; defaults to the browser's fetch with timeout and retry. */
  readonly fetch?: typeof fetchWithRetry;
}

const TARGET_PREFIX = "AWSCognitoIdentityProviderService.";
const TIMEOUT_MS = 10_000;
/** Shown to the authenticator app next to the account. */
export const TOTP_DEVICE_NAME = "Reclamo en regla";

const ErrorBody = z.object({ __type: z.string().optional(), message: z.string().optional(), Message: z.string().optional() });

// Cognito names errors `NotAuthorizedException` or, on some paths, `<namespace>#NotAuthorizedException`.
function errorType(raw: string | undefined): string {
  if (!raw) return "UnknownError";
  const name = raw.slice(raw.lastIndexOf("#") + 1);
  return name.slice(0, name.indexOf(":") === -1 ? undefined : name.indexOf(":"));
}

export function createCognitoApi(config: CognitoApiConfig): CognitoApi {
  const endpoint = `https://cognito-idp.${config.region}.amazonaws.com/`;
  const doFetch = config.fetch ?? fetchWithRetry;

  // Idempotent reads and the SRP start retry a network failure; a call that consumes a code, a
  // session or a password is sent once, so a timeout never replays it.
  async function call<T>(operation: string, body: Record<string, unknown>, schema: z.ZodType<T>, idempotent: boolean): Promise<T> {
    const response = await doFetch(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `${TARGET_PREFIX}${operation}` },
        body: JSON.stringify(body),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      },
      { attempts: idempotent ? 3 : 1, timeoutMs: TIMEOUT_MS },
    );
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const parsed = ErrorBody.safeParse(payload);
      const type = errorType((parsed.success ? parsed.data.__type : undefined) ?? response.headers.get("x-amzn-errortype") ?? undefined);
      throw new CognitoError(type, parsed.success ? (parsed.data.message ?? parsed.data.Message ?? type) : type);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new CognitoError("InvalidResponse", `unexpected ${operation} response`);
    return parsed.data;
  }

  const clientId = config.clientId;
  return {
    initiateSrp: (username, srpA) =>
      call("InitiateAuth", { AuthFlow: "USER_SRP_AUTH", ClientId: clientId, AuthParameters: { USERNAME: username, SRP_A: srpA } }, AuthResponse, true),
    respondToChallenge: (challengeName, responses, session) =>
      call(
        "RespondToAuthChallenge",
        { ChallengeName: challengeName, ClientId: clientId, ChallengeResponses: responses, ...(session !== undefined ? { Session: session } : {}) },
        AuthResponse,
        false,
      ),
    async associateSoftwareToken(session) {
      const result = await call("AssociateSoftwareToken", { Session: session }, AssociateResponse, false);
      return { secretCode: result.SecretCode, ...(result.Session !== undefined ? { session: result.Session } : {}) };
    },
    async verifySoftwareToken(session, code) {
      const result = await call("VerifySoftwareToken", { Session: session, UserCode: code, FriendlyDeviceName: TOTP_DEVICE_NAME }, VerifyResponse, false);
      return { ok: result.Status === "SUCCESS", ...(result.Session !== undefined ? { session: result.Session } : {}) };
    },
    async refresh(refreshToken) {
      const result = await call("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: clientId, AuthParameters: { REFRESH_TOKEN: refreshToken } }, AuthResponse, true);
      if (!result.AuthenticationResult) throw new CognitoError("InvalidResponse", "refresh answered without tokens");
      return result.AuthenticationResult;
    },
    async revoke(refreshToken) {
      await call("RevokeToken", { ClientId: clientId, Token: refreshToken }, Empty, true);
    },
  };
}

/** `us-east-1_AbC123` → `us-east-1`: the region is the prefix of every user pool id. */
export function regionOfPool(userPoolId: string): string | undefined {
  const match = /^([a-z]{2}(?:-[a-z]+)+-\d+)_[A-Za-z0-9]+$/.exec(userPoolId);
  return match?.[1];
}
