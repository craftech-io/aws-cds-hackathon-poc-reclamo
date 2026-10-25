// Test-only Cognito user pool: the behaviour of the challenges the console handles, with real SRP
// verification (srp-server.ts) and real TOTP codes (totp.ts). The pool is username-based like
// infra/auth.ts (`operator-01`, `guest-03`, case-insensitive). Users are invited (temporary
// password, FORCE_CHANGE_PASSWORD) or confirmed, with or without TOTP; a user flagged
// `mfaSetup` gets the MFA_SETUP challenge, the only way TOTP is enrolled (ADR-0018). The id token
// carries the claims the pre-token trigger stamps (worldId, staffId, role). Every request is
// recorded so a test can assert what crossed the wire.
import { type AuthResponse, type AuthenticationResult, type CognitoApi, CognitoError, TOTP_MFA } from "../cognito";
import { missingPasswordRules } from "../credentials";
import { type ServerSession, type SrpVerifier, createVerifier, startServerSession } from "./srp-server";
import { randomBase32Secret, totpCode } from "./totp";

export const FAKE_POOL_ID = "us-east-1_FakePool1";

export interface FakeUserInit {
  readonly username: string;
  readonly password: string;
  readonly role?: string;
  readonly worldId?: string;
  readonly status?: "FORCE_CHANGE_PASSWORD" | "CONFIRMED";
  /** Base32 TOTP secret; set = TOTP already enabled. */
  readonly totpSecret?: string;
  /** Cognito asks this user to enrol TOTP (MFA_SETUP) after the password. */
  readonly mfaSetup?: boolean;
}

interface FakeUser {
  readonly sub: string;
  readonly username: string;
  readonly role: string;
  readonly worldId: string;
  readonly mfaSetup: boolean;
  status: "FORCE_CHANGE_PASSWORD" | "CONFIRMED";
  srp: SrpVerifier;
  password: string;
  totpSecret: string | undefined;
  totpEnabled: boolean;
  pendingSecret: string | undefined;
}

interface PendingSession {
  readonly sub: string;
  readonly kind: "NEW_PASSWORD_REQUIRED" | "SOFTWARE_TOKEN_MFA" | "MFA_SETUP" | "SELECT_MFA_TYPE";
  used: boolean;
}

export interface RecordedCall {
  readonly operation: string;
  readonly payload: string;
}

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Cognito accepts the code of the previous 30-second window too; so does the fake, which also keeps
// a test from failing when the window turns between producing and checking a code.
async function codeMatches(secret: string | undefined, code: string | undefined): Promise<boolean> {
  if (!secret || !code) return false;
  const now = Date.now();
  return code === (await totpCode(secret, now)) || code === (await totpCode(secret, now - 30_000));
}

function fail(type: string, message: string): never {
  throw new CognitoError(type, message);
}

export class FakeCognito implements CognitoApi {
  readonly calls: RecordedCall[] = [];
  readonly revoked = new Set<string>();
  /** Makes the next request of this operation fail: as the network would, or with a Cognito error type. */
  failNext: { readonly operation: string; readonly type?: string } | undefined;
  private readonly users = new Map<string, FakeUser>();
  private readonly srpSessions = new Map<string, { sub: string | undefined; session: ServerSession; srpA: string }>();
  private readonly sessions = new Map<string, PendingSession>();
  private readonly refreshTokens = new Map<string, string>();
  private counter = 0;

  constructor(readonly poolId: string = FAKE_POOL_ID) {}

  async addUser(init: FakeUserInit): Promise<FakeUser> {
    this.counter += 1;
    const sub = `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
    const user: FakeUser = {
      sub,
      username: init.username.toLowerCase(),
      role: init.role ?? "OPERATOR",
      worldId: init.worldId ?? "demo",
      mfaSetup: init.mfaSetup ?? false,
      status: init.status ?? "CONFIRMED",
      srp: await createVerifier(this.poolId, sub, init.password),
      password: init.password,
      totpSecret: init.totpSecret,
      totpEnabled: init.totpSecret !== undefined,
      pendingSecret: undefined,
    };
    this.users.set(user.username, user);
    return user;
  }

  user(username: string): FakeUser {
    const user = this.users.get(username.toLowerCase());
    if (!user) throw new Error(`no fake user ${username}`);
    return user;
  }

  /** The code an authenticator app would show right now for this user's (pending or active) secret. */
  async currentCode(username: string): Promise<string> {
    const user = this.user(username);
    const secret = user.pendingSecret ?? user.totpSecret;
    if (!secret) throw new Error("no TOTP secret");
    return totpCode(secret);
  }

  expireSessions(): void {
    for (const session of this.sessions.values()) session.used = true;
  }

  private record(operation: string, payload: unknown): void {
    this.calls.push({ operation, payload: JSON.stringify(payload) });
    const failure = this.failNext;
    if (failure?.operation === operation) {
      this.failNext = undefined;
      if (failure.type) fail(failure.type, "injected failure");
      throw new TypeError("Failed to fetch");
    }
  }

  private newSession(sub: string, kind: PendingSession["kind"]): string {
    this.counter += 1;
    const id = `session-${this.counter}`;
    this.sessions.set(id, { sub, kind, used: false });
    return id;
  }

  private takeSession(id: string | undefined, kind: PendingSession["kind"]): FakeUser {
    const session = id === undefined ? undefined : this.sessions.get(id);
    if (!session || session.used || session.kind !== kind) fail("NotAuthorizedException", "Invalid session for the user, session is expired.");
    session.used = true;
    const user = [...this.users.values()].find((candidate) => candidate.sub === session.sub);
    if (!user) fail("NotAuthorizedException", "Invalid session");
    return user;
  }

  private tokensFor(user: FakeUser): AuthenticationResult {
    this.counter += 1;
    const now = Math.floor(Date.now() / 1000);
    const staffId = `stf-${user.username.replace(/[^a-z0-9-]/g, "-")}`;
    const claims = {
      sub: user.sub,
      "cognito:username": user.username,
      "cognito:groups": [user.role],
      worldId: user.worldId,
      staffId,
      role: user.role,
      auth_time: now,
      exp: now + 900,
      iat: now,
      iss: "fake",
      aud: "fake",
      token_use: "id",
    };
    const idToken = `${base64Url({ alg: "none" })}.${base64Url(claims)}.sig`;
    const accessToken = `access-${this.counter}`;
    const refreshToken = `refresh-${this.counter}`;
    this.refreshTokens.set(refreshToken, user.sub);
    return { IdToken: idToken, AccessToken: accessToken, RefreshToken: refreshToken, ExpiresIn: 900 };
  }

  // What Cognito does once the password is proven (or changed): the next challenge or tokens.
  private afterPassword(user: FakeUser): AuthResponse {
    if (user.status === "FORCE_CHANGE_PASSWORD") {
      return { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: this.newSession(user.sub, "NEW_PASSWORD_REQUIRED"), ChallengeParameters: { USER_ID_FOR_SRP: user.sub, requiredAttributes: "[]", userAttributes: "{}" } };
    }
    if (user.totpEnabled) return { ChallengeName: "SOFTWARE_TOKEN_MFA", Session: this.newSession(user.sub, "SOFTWARE_TOKEN_MFA"), ChallengeParameters: {} };
    if (user.mfaSetup) {
      return { ChallengeName: "MFA_SETUP", Session: this.newSession(user.sub, "MFA_SETUP"), ChallengeParameters: { MFAS_CAN_SETUP: JSON.stringify([TOTP_MFA]) } };
    }
    return { AuthenticationResult: this.tokensFor(user) };
  }

  async initiateSrp(username: string, srpA: string): Promise<AuthResponse> {
    this.record("InitiateAuth", { username, srpA });
    const user = this.users.get(username.toLowerCase());
    // Unknown usernames get a challenge too (preventUserExistenceErrors), which then fails.
    const userId = user?.sub ?? "00000000-0000-4000-8000-ffffffffffff";
    const record = user?.srp ?? (await createVerifier(this.poolId, userId, crypto.randomUUID()));
    const session = await startServerSession(this.poolId, record);
    this.srpSessions.set(session.secretBlock, { sub: user?.sub, session, srpA });
    return {
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: { SALT: record.saltHex, SECRET_BLOCK: session.secretBlock, SRP_B: session.srpBHex, USERNAME: userId, USER_ID_FOR_SRP: userId },
    };
  }

  async respondToChallenge(challengeName: string, responses: Readonly<Record<string, string>>, session?: string): Promise<AuthResponse> {
    this.record("RespondToAuthChallenge", { challengeName, responses, session });
    switch (challengeName) {
      case "PASSWORD_VERIFIER":
        return this.passwordVerifier(responses);
      case "NEW_PASSWORD_REQUIRED": {
        const password = responses.NEW_PASSWORD ?? "";
        const pending = session === undefined ? undefined : this.sessions.get(session);
        if (pending && !pending.used && missingPasswordRules(password).length > 0) fail("InvalidPasswordException", "Password does not conform to policy");
        const user = this.takeSession(session, "NEW_PASSWORD_REQUIRED");
        user.password = password;
        user.srp = await createVerifier(this.poolId, user.sub, password);
        user.status = "CONFIRMED";
        return this.afterPassword(user);
      }
      case "SOFTWARE_TOKEN_MFA": {
        const pending = session === undefined ? undefined : this.sessions.get(session);
        const user = this.takeSession(session, "SOFTWARE_TOKEN_MFA");
        if (!(await codeMatches(user.totpSecret, responses.SOFTWARE_TOKEN_MFA_CODE))) {
          // A wrong code leaves the session usable for another try.
          if (pending) pending.used = false;
          fail("CodeMismatchException", "Invalid code received for user");
        }
        return { AuthenticationResult: this.tokensFor(user) };
      }
      case "MFA_SETUP": {
        const user = this.takeSession(session, "MFA_SETUP");
        if (!user.totpEnabled) fail("NotAuthorizedException", "software token not verified");
        return { AuthenticationResult: this.tokensFor(user) };
      }
      default:
        return fail("InvalidParameterException", `unexpected challenge ${challengeName}`);
    }
  }

  private async passwordVerifier(responses: Readonly<Record<string, string>>): Promise<AuthResponse> {
    const secretBlock = responses.PASSWORD_CLAIM_SECRET_BLOCK ?? "";
    const pending = this.srpSessions.get(secretBlock);
    this.srpSessions.delete(secretBlock);
    const user = [...this.users.values()].find((candidate) => candidate.sub === pending?.sub);
    const ok =
      pending !== undefined &&
      user !== undefined &&
      responses.USERNAME === user.sub &&
      (await pending.session.verify({
        srpAHex: pending.srpA,
        userId: user.sub,
        timestamp: responses.TIMESTAMP ?? "",
        secretBlock,
        signature: responses.PASSWORD_CLAIM_SIGNATURE ?? "",
      }));
    if (!ok || !user) return fail("NotAuthorizedException", "Incorrect username or password.");
    return this.afterPassword(user);
  }

  async associateSoftwareToken(session: string) {
    this.record("AssociateSoftwareToken", { session });
    const user = this.takeSession(session, "MFA_SETUP");
    user.pendingSecret = randomBase32Secret();
    return { secretCode: user.pendingSecret, session: this.newSession(user.sub, "MFA_SETUP") };
  }

  async verifySoftwareToken(session: string, code: string) {
    this.record("VerifySoftwareToken", { session, code });
    const pending = this.sessions.get(session);
    const user = this.takeSession(session, "MFA_SETUP");
    if (!(await codeMatches(user.pendingSecret, code))) {
      // A wrong code leaves the session usable for another try.
      if (pending) pending.used = false;
      fail("EnableSoftwareTokenMFAException", "Code mismatch");
    }
    const next = this.newSession(user.sub, "MFA_SETUP");
    user.totpSecret = user.pendingSecret;
    user.pendingSecret = undefined;
    user.totpEnabled = true;
    return { ok: true, session: next };
  }

  async refresh(refreshToken: string): Promise<AuthenticationResult> {
    this.record("InitiateAuth", { refreshToken });
    const sub = this.refreshTokens.get(refreshToken);
    const user = [...this.users.values()].find((candidate) => candidate.sub === sub);
    if (!user || this.revoked.has(refreshToken)) fail("NotAuthorizedException", "Refresh Token has been revoked");
    // Cognito does not rotate the refresh token on this flow.
    const fresh = this.tokensFor(user);
    return { IdToken: fresh.IdToken, AccessToken: fresh.AccessToken, ExpiresIn: fresh.ExpiresIn };
  }

  async revoke(refreshToken: string): Promise<void> {
    this.record("RevokeToken", { refreshToken });
    this.revoked.add(refreshToken);
  }
}
