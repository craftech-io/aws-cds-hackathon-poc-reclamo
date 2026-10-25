// The one client of Cognito for the self-signup (docs/architecture-guests.md §2, §4): `SignUp`,
// `ConfirmSignUp`, `ResendConfirmationCode`, `ForgotPassword` and `ConfirmForgotPassword` with the
// confidential `GuestSignupClient` (its `SECRET_HASH` only the Bff can build), plus the two admin
// reads and writes of the pool the Bff holds (`AdminGetUser`, `AdminDeleteUser`). Timeouts and SDK
// retries come from lib/clients.ts; Cognito's errors become `CognitoFailure` codes here, so no SDK
// type crosses the port. The local flows and the browser specs run `testing/fake-cognito-idp.ts`
// through the same interface.
import { createHmac } from "node:crypto";
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { awsClientConfig } from "../lib/clients";

export type CognitoFailureCode =
  | "CODE_MISMATCH"
  | "CODE_EXPIRED"
  | "WEAK_PASSWORD"
  | "USERNAME_EXISTS"
  /** `ConfirmSignUp` of an account that is already confirmed. */
  | "ALREADY_CONFIRMED"
  | "USER_NOT_FOUND"
  | "LIMIT_EXCEEDED"
  /** A trigger refused (pre-sign-up) or failed. */
  | "TRIGGER_REFUSED"
  | "UNAVAILABLE";

export class CognitoFailure extends Error {
  override readonly name = "CognitoFailure";
  constructor(
    readonly code: CognitoFailureCode,
    options?: ErrorOptions,
  ) {
    super(`cognito: ${code}`, options);
  }
}

export type AccountStatus = "UNCONFIRMED" | "CONFIRMED" | "OTHER";

export interface AccountState {
  readonly status: AccountStatus;
  readonly sub?: string;
}

/** `clientMetadata` of every call: the request it belongs to and the language of its emails. */
export type ClientMetadata = Readonly<Record<string, string>>;

export interface GuestCognito {
  signUp(input: { readonly username: string; readonly password: string; readonly clientMetadata: ClientMetadata }): Promise<{ readonly sub: string }>;
  confirmSignUp(input: { readonly username: string; readonly code: string; readonly clientMetadata: ClientMetadata }): Promise<void>;
  resendCode(input: { readonly username: string; readonly clientMetadata: ClientMetadata }): Promise<void>;
  forgotPassword(input: { readonly username: string; readonly clientMetadata: ClientMetadata }): Promise<void>;
  confirmForgotPassword(input: { readonly username: string; readonly code: string; readonly password: string; readonly clientMetadata: ClientMetadata }): Promise<void>;
  /** `undefined` when the pool has no such user. */
  account(username: string): Promise<AccountState | undefined>;
  deleteAccount(username: string): Promise<void>;
}

export interface GuestCognitoConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** `SECRET_HASH` of a confidential app client: base64(HMAC-SHA256(secret, username + clientId)). */
export function secretHash(username: string, clientId: string, clientSecret: string): string {
  return createHmac("sha256", clientSecret).update(username + clientId).digest("base64");
}

const CODE_BY_NAME: Readonly<Record<string, CognitoFailureCode>> = {
  CodeMismatchException: "CODE_MISMATCH",
  ExpiredCodeException: "CODE_EXPIRED",
  InvalidPasswordException: "WEAK_PASSWORD",
  UsernameExistsException: "USERNAME_EXISTS",
  AliasExistsException: "USERNAME_EXISTS",
  UserNotFoundException: "USER_NOT_FOUND",
  LimitExceededException: "LIMIT_EXCEEDED",
  TooManyRequestsException: "LIMIT_EXCEEDED",
  TooManyFailedAttemptsException: "LIMIT_EXCEEDED",
  UserLambdaValidationException: "TRIGGER_REFUSED",
  UnexpectedLambdaException: "TRIGGER_REFUSED",
  InvalidLambdaResponseException: "TRIGGER_REFUSED",
};

/** A Cognito (or network) error as a `CognitoFailure`; anything unknown is `UNAVAILABLE`. */
export function toCognitoFailure(error: unknown): CognitoFailure {
  if (error instanceof CognitoFailure) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  // `ConfirmSignUp` of a confirmed user answers NotAuthorizedException "Current status is CONFIRMED".
  if (name === "NotAuthorizedException" && /CONFIRMED/.test(message)) return new CognitoFailure("ALREADY_CONFIRMED", { cause: error });
  if (name === "NotAuthorizedException") return new CognitoFailure("USER_NOT_FOUND", { cause: error });
  return new CognitoFailure(CODE_BY_NAME[name] ?? "UNAVAILABLE", { cause: error });
}

// Cognito answers in well under a second; the Bff has 3 s per public call (docs/test-plan.md).
const COGNITO_TIMEOUTS = { requestTimeoutMs: 2_500, connectionTimeoutMs: 1_000, maxAttempts: 2 } as const;

export function createGuestCognito(config: GuestCognitoConfig, client: CognitoIdentityProviderClient = new CognitoIdentityProviderClient({ region: config.region, ...awsClientConfig(COGNITO_TIMEOUTS) })): GuestCognito {
  const hash = (username: string) => secretHash(username, config.clientId, config.clientSecret);
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw toCognitoFailure(error);
    }
  };
  return {
    signUp: ({ username, password, clientMetadata }) =>
      call(async () => {
        const output = await client.send(
          new SignUpCommand({ ClientId: config.clientId, SecretHash: hash(username), Username: username, Password: password, UserAttributes: [{ Name: "email", Value: username }], ClientMetadata: { ...clientMetadata } }),
        );
        if (!output.UserSub) throw new CognitoFailure("UNAVAILABLE");
        return { sub: output.UserSub };
      }),
    confirmSignUp: ({ username, code, clientMetadata }) =>
      call(async () => {
        await client.send(new ConfirmSignUpCommand({ ClientId: config.clientId, SecretHash: hash(username), Username: username, ConfirmationCode: code, ClientMetadata: { ...clientMetadata } }));
      }),
    resendCode: ({ username, clientMetadata }) =>
      call(async () => {
        await client.send(new ResendConfirmationCodeCommand({ ClientId: config.clientId, SecretHash: hash(username), Username: username, ClientMetadata: { ...clientMetadata } }));
      }),
    forgotPassword: ({ username, clientMetadata }) =>
      call(async () => {
        await client.send(new ForgotPasswordCommand({ ClientId: config.clientId, SecretHash: hash(username), Username: username, ClientMetadata: { ...clientMetadata } }));
      }),
    confirmForgotPassword: ({ username, code, password, clientMetadata }) =>
      call(async () => {
        await client.send(
          new ConfirmForgotPasswordCommand({ ClientId: config.clientId, SecretHash: hash(username), Username: username, ConfirmationCode: code, Password: password, ClientMetadata: { ...clientMetadata } }),
        );
      }),
    account: (username) =>
      call(async () => {
        try {
          const output = await client.send(new AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: username }));
          const sub = output.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value;
          const status: AccountStatus = output.UserStatus === "CONFIRMED" ? "CONFIRMED" : output.UserStatus === "UNCONFIRMED" ? "UNCONFIRMED" : "OTHER";
          return { status, ...(sub ? { sub } : {}) };
        } catch (error) {
          if (toCognitoFailure(error).code === "USER_NOT_FOUND") return undefined;
          throw error;
        }
      }),
    deleteAccount: (username) =>
      call(async () => {
        await client.send(new AdminDeleteUserCommand({ UserPoolId: config.userPoolId, Username: username }));
      }),
  };
}
