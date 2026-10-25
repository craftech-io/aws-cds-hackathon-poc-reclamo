// A Cognito user pool in memory for the local flows and the unit tests (docs/test-plan.md, levels U
// and LF): the `GuestCognito` port with Cognito's rules that the self-signup depends on — usernames
// are case-insensitive, one per name; `SignUp` runs the pre-sign-up trigger and leaves the user
// `UNCONFIRMED`; a code is six digits and expires (24 h for a sign-up, 1 h for a recovery); a wrong
// code fails; `ConfirmSignUp` runs the post-confirmation trigger; every email goes through the
// custom-message trigger into an outbox the test reads (no email leaves the process). The password
// policy is the pool's (12 characters, upper, lower, digit).
import type { CustomMessageTriggerEvent, PostConfirmationTriggerEvent, PreSignUpTriggerEvent } from "aws-lambda";
import { passwordProblem } from "../schemas";
import { type AccountState, type ClientMetadata, CognitoFailure, type GuestCognito } from "../cognito-port";

export interface FakeTriggers {
  readonly preSignUp?: (event: PreSignUpTriggerEvent) => Promise<PreSignUpTriggerEvent>;
  readonly postConfirmation?: (event: PostConfirmationTriggerEvent) => Promise<PostConfirmationTriggerEvent>;
  readonly customMessage?: (event: CustomMessageTriggerEvent) => Promise<CustomMessageTriggerEvent>;
}

export interface FakeMail {
  readonly to: string;
  readonly kind: "SIGNUP" | "RECOVERY";
  readonly code: string;
  readonly subject: string;
  readonly body: string;
}

interface FakeUser {
  readonly username: string;
  readonly sub: string;
  password: string;
  status: "UNCONFIRMED" | "CONFIRMED";
  signupCode?: { readonly code: string; readonly expiresAt: number };
  recoveryCode?: { readonly code: string; readonly expiresAt: number };
}

export interface FakeCognitoOptions {
  readonly clientId?: string;
  readonly now?: () => Date;
  readonly triggers?: FakeTriggers;
}

const SIGNUP_CODE_MS = 24 * 3_600_000;
const RECOVERY_CODE_MS = 3_600_000;

export interface FakeCognito extends GuestCognito {
  readonly outbox: FakeMail[];
  readonly calls: string[];
  /** The last code mailed to `username`. */
  lastCode(username: string, kind?: FakeMail["kind"]): string | undefined;
  /** SRP stand-in: whether this password signs this user in (confirmed users only). */
  passwordMatches(username: string, password: string): boolean;
  user(username: string): Readonly<FakeUser> | undefined;
  /** Makes the next call of `operation` fail with `code`. */
  failNext(operation: string, code: CognitoFailure["code"]): void;
}

export function createFakeCognito(options: FakeCognitoOptions = {}): FakeCognito {
  const clientId = options.clientId ?? "fake-guest-signup-client";
  const now = options.now ?? (() => new Date());
  const users = new Map<string, FakeUser>();
  const outbox: FakeMail[] = [];
  const calls: string[] = [];
  const failures = new Map<string, CognitoFailure["code"]>();
  let sequence = 0;

  const key = (username: string) => username.trim().toLowerCase();
  const nextSub = () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
  const nextCode = () => String(100_000 + ((sequence * 7_919 + outbox.length * 104_729) % 900_000));

  const enter = (operation: string) => {
    calls.push(operation);
    const failure = failures.get(operation);
    if (failure) {
      failures.delete(operation);
      throw new CognitoFailure(failure);
    }
  };

  const mail = async (user: FakeUser, kind: FakeMail["kind"], clientMetadata: ClientMetadata) => {
    const code = nextCode();
    const expiresAt = now().getTime() + (kind === "SIGNUP" ? SIGNUP_CODE_MS : RECOVERY_CODE_MS);
    if (kind === "SIGNUP") user.signupCode = { code, expiresAt };
    else user.recoveryCode = { code, expiresAt };
    const triggerSource = kind === "SIGNUP" ? "CustomMessage_SignUp" : "CustomMessage_ForgotPassword";
    const event = { triggerSource, userName: user.username, request: { codeParameter: "{####}", clientMetadata: { ...clientMetadata }, userAttributes: { email: user.username } }, response: {} };
    const rendered = options.triggers?.customMessage ? await options.triggers.customMessage(event as unknown as CustomMessageTriggerEvent) : undefined;
    const subject = rendered?.response.emailSubject ?? "code";
    const body = (rendered?.response.emailMessage ?? "{####}").replaceAll("{####}", code);
    outbox.push({ to: user.username, kind, code, subject, body });
  };

  const checkCode = (stored: FakeUser["signupCode"], code: string) => {
    if (!stored || stored.code !== code) throw new CognitoFailure("CODE_MISMATCH");
    if (stored.expiresAt <= now().getTime()) throw new CognitoFailure("CODE_EXPIRED");
  };

  return {
    outbox,
    calls,
    lastCode: (username, kind = "SIGNUP") => [...outbox].reverse().find((item) => item.to === key(username) && item.kind === kind)?.code,
    passwordMatches: (username, password) => {
      const user = users.get(key(username));
      return user?.status === "CONFIRMED" && user.password === password;
    },
    user: (username) => users.get(key(username)),
    failNext: (operation, code) => failures.set(operation, code),

    async signUp({ username, password, clientMetadata }) {
      enter("SignUp");
      const name = key(username);
      if (users.has(name)) throw new CognitoFailure("USERNAME_EXISTS");
      if (passwordProblem(password)) throw new CognitoFailure("WEAK_PASSWORD");
      const event = { triggerSource: "PreSignUp_SignUp", userName: name, callerContext: { clientId }, request: { userAttributes: { email: name }, clientMetadata: { ...clientMetadata } }, response: {} };
      try {
        await options.triggers?.preSignUp?.(event as unknown as PreSignUpTriggerEvent);
      } catch (error) {
        throw new CognitoFailure("TRIGGER_REFUSED", { cause: error });
      }
      const user: FakeUser = { username: name, sub: nextSub(), password, status: "UNCONFIRMED" };
      users.set(name, user);
      await mail(user, "SIGNUP", clientMetadata);
      return { sub: user.sub };
    },

    async confirmSignUp({ username, code, clientMetadata }) {
      enter("ConfirmSignUp");
      const user = users.get(key(username));
      if (!user) throw new CognitoFailure("USER_NOT_FOUND");
      if (user.status === "CONFIRMED") throw new CognitoFailure("ALREADY_CONFIRMED");
      checkCode(user.signupCode, code);
      user.status = "CONFIRMED";
      delete user.signupCode;
      const event = { triggerSource: "PostConfirmation_ConfirmSignUp", userName: user.username, request: { userAttributes: { sub: user.sub, email: user.username }, clientMetadata: { ...clientMetadata } }, response: {} };
      await options.triggers?.postConfirmation?.(event as unknown as PostConfirmationTriggerEvent);
    },

    async resendCode({ username, clientMetadata }) {
      enter("ResendConfirmationCode");
      const user = users.get(key(username));
      if (!user || user.status !== "UNCONFIRMED") throw new CognitoFailure("USER_NOT_FOUND");
      await mail(user, "SIGNUP", clientMetadata);
    },

    async forgotPassword({ username, clientMetadata }) {
      enter("ForgotPassword");
      const user = users.get(key(username));
      if (!user || user.status !== "CONFIRMED") throw new CognitoFailure("USER_NOT_FOUND");
      await mail(user, "RECOVERY", clientMetadata);
    },

    async confirmForgotPassword({ username, code, password }) {
      enter("ConfirmForgotPassword");
      const user = users.get(key(username));
      if (!user) throw new CognitoFailure("USER_NOT_FOUND");
      checkCode(user.recoveryCode, code);
      if (passwordProblem(password)) throw new CognitoFailure("WEAK_PASSWORD");
      user.password = password;
      delete user.recoveryCode;
    },

    async account(username): Promise<AccountState | undefined> {
      enter("AdminGetUser");
      const user = users.get(key(username));
      return user ? { status: user.status, sub: user.sub } : undefined;
    },

    async deleteAccount(username) {
      enter("AdminDeleteUser");
      if (!users.delete(key(username))) throw new CognitoFailure("USER_NOT_FOUND");
    },
  };
}
