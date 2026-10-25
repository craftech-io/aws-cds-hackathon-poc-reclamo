// `account` router (docs/tool-catalog.md "Procedimientos de la consola"; docs/architecture.md §11):
//
//   changePassword  a personal staff account (OPERATOR, SUPERVISOR; never a GUEST, whose account is
//                   shared or recovers by email) with a sign-in of at most 15 minutes: the current
//                   password is checked with `AdminInitiateAuth` on the `ServerClient` and the new one set
//                   with `AdminSetUserPassword` (the access token has no admin scope, so the browser can
//                   never call `ChangePassword` itself). Audited `PASSWORD_CHANGED`; no password is
//                   ever logged or echoed
//   session         the "another session" notice of a guest account (auth/session-presence.ts): another
//                   session of the same account active in the last 2 real hours warns, never blocks; the
//                   world's `CLOCK.lastSession` keeps this one. Answered also while a self-signup world
//                   is being prepared (auth/guest-identity.ts), when there is no clock yet
import {
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { z } from "zod";
import { ToolError } from "@reclamo/shared";
import { authConfig } from "../auth/config";
import { sessionPresence } from "../auth/session-presence";
import { dynamoConnector } from "../connector/dynamo/connector";
import { isConflict } from "../connector/errors";
import type { Connector } from "../connector/port";
import { awsClientConfig } from "../lib/clients";
import type { ContextDeps } from "./deps";
import { auditConsole } from "./register";
import { accessProcedure } from "./roles";
import { router } from "./trpc";

/** The two Cognito admin calls of a password change. */
export interface PasswordAdmin {
  /** Whether `password` is the user's current one; a wrong one answers `false`, an outage throws. */
  verify(username: string, password: string): Promise<boolean>;
  /** Sets a permanent password; `InvalidPasswordException` when the pool's policy refuses it. */
  set(username: string, password: string): Promise<void>;
}

export interface AccountPorts {
  readonly connector: Connector;
  readonly passwords: PasswordAdmin;
}

declare module "./deps" {
  interface ContextDeps {
    /** `account.*` (routers/account.ts); the linked resources when absent. */
    readonly accountPorts?: AccountPorts;
  }
}

const COGNITO_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 2 } as const;
/** Cognito's answers to a wrong password or user: the check fails, nothing else happened. */
const WRONG_PASSWORD = new Set(["NotAuthorizedException", "UserNotFoundException", "PasswordResetRequiredException", "UserNotConfirmedException"]);

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** Over the linked `Auth` pool and its `ServerClient` (ADMIN_USER_PASSWORD_AUTH only, IAM-signed). */
export function cognitoPasswordAdmin(client: CognitoIdentityProviderClient = new CognitoIdentityProviderClient(awsClientConfig(COGNITO_TIMEOUTS))): PasswordAdmin {
  return {
    async verify(username, password) {
      const { userPoolId, serverClientId } = authConfig();
      try {
        const output = await client.send(
          new AdminInitiateAuthCommand({ UserPoolId: userPoolId, ClientId: serverClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: username, PASSWORD: password } }),
        );
        // A challenge (TOTP) is issued only after the password matched.
        return output.AuthenticationResult !== undefined || output.ChallengeName !== undefined;
      } catch (error) {
        if (WRONG_PASSWORD.has(errorName(error))) return false;
        throw error;
      }
    },
    async set(username, password) {
      const { userPoolId } = authConfig();
      await client.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }));
    },
  };
}

let stagePorts: AccountPorts | undefined;

function accountPortsOf(deps: ContextDeps): AccountPorts {
  if (deps.accountPorts) return deps.accountPorts;
  stagePorts ??= { connector: dynamoConnector(), passwords: cognitoPasswordAdmin() };
  return stagePorts;
}

/** `CLOCK.lastSession` of the same session is rewritten at most once a minute (each write moves the clock's version). */
export const SESSION_TOUCH_MS = 60_000;

const Password = z.string().min(8).max(256);
export const ChangePasswordInput = z
  .object({ currentPassword: Password, newPassword: Password })
  .strict()
  .refine((input) => input.currentPassword !== input.newPassword, { message: "the new password must differ from the current one", path: ["newPassword"] });

export const accountRouter = router({
  changePassword: accessProcedure("account.changePassword")
    .input(ChangePasswordInput)
    .mutation(async ({ ctx, input }) => {
      const ports = accountPortsOf(ctx.deps);
      const { username } = ctx.principal;
      if (!(await ports.passwords.verify(username, input.currentPassword))) {
        ctx.log.warn("account.password_check_failed", {});
        throw new ToolError("FORBIDDEN", "the current password is not right", "WRONG_PASSWORD");
      }
      try {
        await ports.passwords.set(username, input.newPassword);
      } catch (error) {
        if (errorName(error) === "InvalidPasswordException") throw new ToolError("INVALID", "the new password does not meet the policy", "WEAK_PASSWORD");
        throw error;
      }
      await auditConsole(ctx, ports.connector, "PASSWORD_CHANGED", { staffId: ctx.principal.staffId });
      ctx.log.info("account.password_changed", {});
      return { changed: true as const };
    }),

  session: accessProcedure("account.session").query(async ({ ctx }) => {
    const { connector } = accountPortsOf(ctx.deps);
    const { worldId } = ctx.principal;
    // Staff of a shared world (`demo`) are many people: only a guest account is one person per session.
    if (ctx.principal.role !== "GUEST") return { otherSessionActive: false };
    const clock = await connector.runtime.getClock(worldId);
    if (clock === undefined) return { otherSessionActive: false };
    const realNow = ctx.deps.wallClock();
    const presence = sessionPresence(clock.lastSession, ctx.principal, realNow);
    const last = clock.lastSession;
    const stale = last === undefined || last.sessionId !== presence.next.sessionId || realNow.getTime() - Date.parse(last.lastActiveAtReal) >= SESSION_TOUCH_MS;
    if (stale) {
      try {
        await connector.write(connector.runtime.updateClockOp(worldId, clock.version, { lastSession: presence.next }));
      } catch (error) {
        // The clock moved in between: the next poll records the session.
        if (!isConflict(error)) throw error;
      }
    }
    return { otherSessionActive: presence.otherSessionActive };
  }),
});
