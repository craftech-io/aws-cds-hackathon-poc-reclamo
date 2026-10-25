// The console's user pool as the QaDriver uses it (capability COGNITO_QA, docs/tool-catalog.md
// `auth.session`, `guest.*`): the pool and the clients come from the linked `Auth` (never `process.env`).
// IAM lets the driver's role administer any user of the pool, so the names are fenced here:
//
//   qa-<runId>-<scenario>-<role>                          `auth.session` and `guest.invite` users
//   success+qa-<runId>-su<n>@simulator.amazonses.com      the runner's own self-signups (`guest.*`)
//
// `probeClients` sends the public calls a bot would (SignUp, ForgotPassword, ConfirmForgotPassword) with
// the two clients whose ids are not secret. The driver never lists the pool: a self-signup's username is
// the lead's email (deploy.yml runs `console:unverify-staff -- --check` with the deploy role instead).
// Logins go through the deployed pre-token trigger: `ADMIN_USER_PASSWORD_AUTH` by `ServerClient`, or
// `USER_SRP_AUTH` by `ConsoleClient` (the browser's flow, SRP-6a by `cognito-srp-helper`). A challenge
// (MFA) is never answered. Every call has a deadline and the SDK's retries (lib/clients.ts).
import {
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  type AuthenticationResultType,
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  DeleteUserCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
  UpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { ToolError } from "@reclamo/shared";
import { authConfig } from "../auth/config";
import { STAFF_TEXT } from "../copy/es-AR";
import { awsClientConfig } from "../lib/clients";
import { challengeRefusal } from "./actions-auth";
import { cognitoRefusal, mappedCognito } from "./cognito-refusal";
import type { QaAccountStatus, QaCognito, SessionTokens } from "./ports";

const COGNITO_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

const QA_USER = /^qa-(?:live-)?\d{1,20}-\d{1,3}(?:-[a-z0-9-]{2,24})?-(operator|supervisor|compliance|guest)$/;
const QA_SIGNUP = /^success\+qa-\d{1,20}-\d{1,3}-su\d{1,3}@simulator\.amazonses\.com$/;

function fenced(username: string, allowSignup: boolean): void {
  if (QA_USER.test(username) || (allowSignup && QA_SIGNUP.test(username))) return;
  throw new ToolError("FORBIDDEN", "the QA driver administers only its own users", "QA_FENCE");
}

function claim(token: string, name: string): number {
  const payload = token.split(".")[1] ?? "";
  const value: unknown = Reflect.get(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as object, name);
  if (typeof value !== "number") throw new ToolError("UNAVAILABLE", `the token has no ${name}`, "TOKEN_SHAPE");
  return value;
}

function tokensOf(result: AuthenticationResultType | undefined, startedMs: number, nowMs: number): SessionTokens {
  if (result?.IdToken === undefined || result.AccessToken === undefined) throw new ToolError("UNAVAILABLE", "Cognito returned no tokens", "NO_TOKENS");
  return { idToken: result.IdToken, accessToken: result.AccessToken, exp: claim(result.IdToken, "exp"), authTime: claim(result.IdToken, "auth_time"), loginMs: nowMs - startedMs };
}

/**
 * A sign-in the deployed pre-token trigger refused reaches the caller as `UserLambdaValidationException`
 * carrying the trigger's fixed text: the runner gets `FORBIDDEN` with `WORLD_NOT_READY` or `ACCESS_DENIED`.
 */
export function triggerRefusal(error: unknown): ToolError | undefined {
  if (!(error instanceof Error) || error.name !== "UserLambdaValidationException") return undefined;
  const notReady = error.message.includes(STAFF_TEXT.WORLD_NOT_READY);
  return new ToolError("FORBIDDEN", notReady ? "the world is not ready" : "the sign-in was refused", notReady ? "WORLD_NOT_READY" : "ACCESS_DENIED");
}

async function refusedByTrigger<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw triggerRefusal(error) ?? cognitoRefusal(error);
  }
}

async function errorName(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "OK";
  } catch (error) {
    return error instanceof Error ? error.name : "unknown";
  }
}

export function stageQaCognito(now: () => Date, client?: Pick<CognitoIdentityProviderClient, "send">): QaCognito {
  let cognito = client;
  const send = () => (cognito ??= new CognitoIdentityProviderClient(awsClientConfig(COGNITO_TIMEOUTS)));

  async function srpLogin(username: string, password: string): Promise<AuthenticationResultType | undefined> {
    const config = authConfig();
    const srp = await import("cognito-srp-helper");
    const session = srp.createSrpSession(username, password, config.userPoolId, false);
    const started = await send().send(new InitiateAuthCommand({ AuthFlow: "USER_SRP_AUTH", ClientId: config.consoleClientId, AuthParameters: { USERNAME: username, SRP_A: session.largeA } }));
    if (started.ChallengeName !== "PASSWORD_VERIFIER" || started.ChallengeParameters === undefined) throw challengeRefusal(started.ChallengeName ?? "NONE");
    const signed = srp.signSrpSession(session, { ChallengeName: "PASSWORD_VERIFIER", ChallengeParameters: { ...started.ChallengeParameters } });
    const answer = await send().send(
      new RespondToAuthChallengeCommand({
        ClientId: config.consoleClientId,
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeResponses: {
          USERNAME: started.ChallengeParameters.USER_ID_FOR_SRP ?? username,
          PASSWORD_CLAIM_SECRET_BLOCK: signed.secret,
          PASSWORD_CLAIM_SIGNATURE: signed.passwordSignature,
          TIMESTAMP: signed.timestamp,
        },
      }),
    );
    if (answer.ChallengeName !== undefined) throw challengeRefusal(answer.ChallengeName);
    return answer.AuthenticationResult;
  }

  return {
    async createUser({ username, worldId, group }) {
      fenced(username, false);
      const { userPoolId } = authConfig();
      try {
        const created = await send().send(
          new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: username, MessageAction: "SUPPRESS", UserAttributes: [{ Name: "custom:worldId", Value: worldId }] }),
        );
        const sub = created.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
        if (sub === undefined) throw new ToolError("UNAVAILABLE", "Cognito returned no sub", "NO_SUB");
        await send().send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: group }));
        return { sub };
      } catch (error) {
        if (error instanceof Error && error.name === "UsernameExistsException") return "EXISTS";
        throw error;
      }
    },

    async setPassword(username, password) {
      fenced(username, true);
      await mappedCognito(() => send().send(new AdminSetUserPasswordCommand({ UserPoolId: authConfig().userPoolId, Username: username, Password: password, Permanent: true })));
    },

    async accountStatus(username): Promise<QaAccountStatus> {
      fenced(username, true);
      try {
        const output = await send().send(new AdminGetUserCommand({ UserPoolId: authConfig().userPoolId, Username: username }));
        return output.UserStatus === "CONFIRMED" ? "CONFIRMED" : output.UserStatus === "UNCONFIRMED" ? "UNCONFIRMED" : "OTHER";
      } catch (error) {
        if (error instanceof Error && error.name === "UserNotFoundException") return "MISSING";
        throw cognitoRefusal(error);
      }
    },

    async login(flow, username, password) {
      fenced(username, true);
      const started = now().getTime();
      if (flow === "SRP") return tokensOf(await refusedByTrigger(() => srpLogin(username, password)), started, now().getTime());
      const config = authConfig();
      const answer = await refusedByTrigger(() =>
        send().send(new AdminInitiateAuthCommand({ UserPoolId: config.userPoolId, ClientId: config.serverClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: username, PASSWORD: password } })),
      );
      if (answer.ChallengeName !== undefined) throw challengeRefusal(answer.ChallengeName);
      return tokensOf(answer.AuthenticationResult, started, now().getTime());
    },

    async probeSelfService(accessToken) {
      return {
        updateAttributes: await errorName(send().send(new UpdateUserAttributesCommand({ AccessToken: accessToken, UserAttributes: [{ Name: "custom:worldId", Value: "demo" }] }))),
        changePassword: await errorName(send().send(new ChangePasswordCommand({ AccessToken: accessToken, PreviousPassword: "not-the-password-1A", ProposedPassword: "Not-a-new-password-2B" }))),
        deleteUser: await errorName(send().send(new DeleteUserCommand({ AccessToken: accessToken }))),
      };
    },

    async probeClients(username, password) {
      fenced(username, false);
      const config = authConfig();
      const probe = async (clientId: string) => ({
        signUp: await errorName(send().send(new SignUpCommand({ ClientId: clientId, Username: username, Password: password }))),
        forgotPassword: await errorName(send().send(new ForgotPasswordCommand({ ClientId: clientId, Username: username }))),
        confirmForgotPassword: await errorName(send().send(new ConfirmForgotPasswordCommand({ ClientId: clientId, Username: username, ConfirmationCode: "000000", Password: password }))),
      });
      return { SERVER: await probe(config.serverClientId), CONSOLE: await probe(config.consoleClientId) };
    },

    async adminConfirmSignUp(username, clientMetadata) {
      if (!QA_SIGNUP.test(username)) throw new ToolError("FORBIDDEN", "AdminConfirmSignUp only confirms the runner's own sign-ups", "QA_FENCE");
      await mappedCognito(() => send().send(new AdminConfirmSignUpCommand({ UserPoolId: authConfig().userPoolId, Username: username, ClientMetadata: { ...clientMetadata } })));
    },

    async deleteUser(username) {
      fenced(username, false);
      try {
        await send().send(new AdminDeleteUserCommand({ UserPoolId: authConfig().userPoolId, Username: username }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "UserNotFoundException")) throw error;
      }
    },
  };
}
