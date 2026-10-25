// Cognito user pool of the console (docs/architecture.md §11, ADR-0018, docs/architecture-guests.md
// §2-§3 and §12, ADR-0020, docs/build-plan.md WP-08 and WP-53).
//
//   ConsoleUserPool    feature plan ESSENTIALS (the V2 pre-token trigger customises the access token, and
//                      a web ACL can only be associated with an ESSENTIALS or PLUS pool). Username-based:
//                      no `usernames` and no `aliases`, case-insensitive usernames: `guest-NN` (no email),
//                      `<role>-NN` for staff, `qa-<runId>-<scenario>-<role>` (QaDriver) and, for a
//                      self-signup guest, the normalised email. `custom:worldId` is immutable and no app
//                      client may write it; the world of a session comes from the staff row anyway.
//                      Self sign-up is allowed by the pool (`allowAdminCreateUserOnly false`) and fenced
//                      by the pre-sign-up trigger (only the GuestSignupClient, only the current request
//                      of that email) and by the Cognito web ACL (infra/waf.ts). Email auto-verified by
//                      code. Account recovery by verified email for the whole pool: only a self-signup
//                      guest has a verified email (`console:unverify-staff` runs BEFORE the deploy that
//                      turns this on, infra/bootstrap/README.md), the web ACL blocks ForgotPassword of
//                      every other client, and `password.*` acts only on self-signup accounts. Password
//                      of 12 with upper, lower and a number (the length protects; no symbol required).
//                      TOTP optional (off for GUEST). Emails: infra/auth-email.ts; the SES sending
//                      policy for this pool's exact ARN: infra/messaging-email.ts.
//   ConsoleClient      SRP from the browser (+ refresh), no hosted UI, no OAuth, no secret, token
//                      revocation, id and access tokens of 15 minutes, refresh 12 hours.
//   ServerClient       ADMIN_USER_PASSWORD_AUTH only, usable only with IAM: the Bff verifies a staff
//                      password and the QaDriver's `auth.session` signs in its ephemeral `qa-*` users.
//   GuestSignupClient  confidential (Cognito generates the secret, linked to the Bff and the QaDriver in
//                      `GuestSignup`): SignUp, ConfirmSignUp, ResendConfirmationCode, ForgotPassword and
//                      ConfirmForgotPassword with SECRET_HASH. `explicitAuthFlows` is set EXPLICITLY to
//                      refresh only: an empty or missing list enables SRP, CUSTOM_AUTH and refresh. Reads
//                      `email` and `email_verified`, writes only `email`.
//   Groups             OPERATOR, SUPERVISOR, COMPLIANCE, GUEST. A self-signup guest joins none: its role
//                      comes from its `STAFF#` row under the identity invariant (architecture-guests §3).
//   Triggers           Code in packages/bff/src/auth-triggers; SST lets only this pool invoke them
//                      (`cognito-idp.amazonaws.com` with `aws:SourceArn` = the pool).
//                        PreSignUpTrigger         GetItem of the sign-up requests in `Leads`, nothing else
//                        PostConfirmationTrigger  registers the lead, the world `REGISTERED`, its `STAFF#`
//                                                 row and the provisioning ticket; invokes WorldJanitor
//                                                 and LeadNotifier asynchronously; no secret
//                        CustomMessageTrigger     the texts of copy/auth-mail.ts; no permission at all
//                        PreTokenTrigger (V2_0)   world, role and staffId from `STAFF#`; reads only, plus
//                                                 `worldId` of the guest's lead and its AuditLog
//                      Their access is exactly their row of infra/iam-capabilities.ts (tables by
//                      `tableAccess`, `Leads` by `leadsPermissions` of infra/leads.ts).
//   Auth / GuestSignup Linkables: pool and client ids (Bff, QaDriver, scripts/console), and the
//                      confidential client with its secret and `mailReady` (Bff, QaDriver).
//
// Verify (reads only, docs/architecture-guests.md §15):
//   aws --profile craftech-demos cognito-idp describe-user-pool --user-pool-id <id> \
//     --query 'UserPool.[AdminCreateUserConfig.AllowAdminCreateUserOnly,AutoVerifiedAttributes,AccountRecoverySetting,EmailConfiguration.EmailSendingAccount,LambdaConfig]'
//   aws --profile craftech-demos cognito-idp describe-user-pool-client --user-pool-id <id> --client-id <GuestSignupClient> \
//     --query 'UserPoolClient.[ExplicitAuthFlows,ReadAttributes,WriteAttributes]'

import { authEmailConfiguration, invitationTemplate, mailReady, readSesIdentity, type AuthEmailConfiguration } from "./auth-email";
import { SIGNUP_FUNCTION_BUDGETS } from "./guest-limits";
import { WORLD_LEADING_KEYS } from "./iam-capabilities";
import { leadNotifier, leadsPermissions } from "./leads";
import { tableAccess } from "./storage";
import { leadingKeysConditions } from "./storage-keys";
import { AuditLog, Leads, Runtime, Worlds } from "./storage-tables";
import { WorldJanitorInvoke } from "./world-janitor-link";

/** Cognito groups, one per staff role (`StaffRole` of @reclamo/shared), in precedence order. */
export const STAFF_GROUPS = ["SUPERVISOR", "OPERATOR", "COMPLIANCE", "GUEST"] as const;
export type StaffGroup = (typeof STAFF_GROUPS)[number];

/** `custom:worldId`: at most the longest world id (`WORLD_ID_MAX_LENGTH` of @reclamo/shared). */
export const WORLD_ID_ATTRIBUTE = { name: "worldId", maxLength: 48 } as const;

/** Lambda entries of the triggers (packages/bff/src/auth-triggers). */
export const TRIGGER_HANDLERS = {
  preToken: "packages/bff/src/auth-triggers/pre-token.handler",
  preSignUp: "packages/bff/src/auth-triggers/pre-sign-up.handler",
  postConfirmation: "packages/bff/src/auth-triggers/post-confirmation.handler",
  customMessage: "packages/bff/src/auth-triggers/custom-message.handler",
} as const;

export const TOKEN_VALIDITY = {
  idTokenMinutes: 15,
  accessTokenMinutes: 15,
  consoleRefreshHours: 12,
  // Cognito's minimum; neither the ServerClient nor the GuestSignupClient ever uses a refresh token.
  serverRefreshMinutes: 60,
  // Between the steps of one sign-in (password, new password, TOTP enrolment with its QR code).
  signInSessionMinutes: 10,
} as const;

export const PASSWORD_POLICY = {
  minimumLength: 12,
  requireLowercase: true,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: false,
  temporaryPasswordValidityDays: 7,
} as const;

/** What the GuestSignupClient may read and write (docs/architecture-guests.md §2). */
export const GUEST_SIGNUP_ATTRIBUTES = { read: ["email", "email_verified"], write: ["email"] } as const;

/** Item actions of the post-confirmation trigger on Worlds and Runtime: no delete, no batch, no scan. */
export const POST_CONFIRMATION_TABLE_ACTIONS = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"] as const;

type UserPoolArgs = aws.cognito.UserPoolArgs;
type UserPoolClientArgs = aws.cognito.UserPoolClientArgs;

/** Everything the pool enforces, on top of what SST sets (SST's defaults are overwritten, not trusted). */
export function applyPoolPolicy(args: UserPoolArgs, emailConfiguration: $util.Input<AuthEmailConfiguration>): undefined {
  args.userPoolTier = "ESSENTIALS";
  args.aliasAttributes = undefined;
  args.usernameAttributes = undefined;
  args.usernameConfiguration = { caseSensitive: false };
  args.autoVerifiedAttributes = ["email"];
  args.signInPolicy = { allowedFirstAuthFactors: ["PASSWORD"] };
  args.adminCreateUserConfig = { allowAdminCreateUserOnly: false, inviteMessageTemplate: { ...invitationTemplate } };
  args.accountRecoverySetting = { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] };
  args.passwordPolicy = { ...PASSWORD_POLICY };
  args.schemas = [
    {
      name: WORLD_ID_ATTRIBUTE.name,
      attributeDataType: "String",
      mutable: false,
      required: false,
      developerOnlyAttribute: false,
      stringAttributeConstraints: { minLength: "1", maxLength: String(WORLD_ID_ATTRIBUTE.maxLength) },
    },
  ];
  args.emailConfiguration = emailConfiguration;
  // The custom-message trigger writes every text; Cognito's own template stays the neutral default.
  args.verificationMessageTemplate = undefined;
  args.deletionProtection = "INACTIVE";
}

// No hosted UI: no OAuth flow, scope, callback or identity provider besides the pool itself. The write
// attributes list is empty: `custom:worldId` is never among them (Cognito's default without a list
// covers standard attributes only), it is immutable anyway, and the pre-token trigger strips the scope
// the browser would need to write any attribute at all.
function withoutHostedUi(args: UserPoolClientArgs): void {
  args.allowedOauthFlowsUserPoolClient = false;
  args.allowedOauthFlows = [];
  args.allowedOauthScopes = [];
  args.callbackUrls = [];
  args.logoutUrls = [];
  args.supportedIdentityProviders = ["COGNITO"];
  args.generateSecret = false;
  args.preventUserExistenceErrors = "ENABLED";
  args.enableTokenRevocation = true;
  args.writeAttributes = [];
  args.idTokenValidity = TOKEN_VALIDITY.idTokenMinutes;
  args.accessTokenValidity = TOKEN_VALIDITY.accessTokenMinutes;
}

export function applyConsoleClient(args: UserPoolClientArgs): undefined {
  withoutHostedUi(args);
  args.explicitAuthFlows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"];
  args.refreshTokenValidity = TOKEN_VALIDITY.consoleRefreshHours;
  args.tokenValidityUnits = { idToken: "minutes", accessToken: "minutes", refreshToken: "hours" };
  args.authSessionValidity = TOKEN_VALIDITY.signInSessionMinutes;
}

export function applyServerClient(args: UserPoolClientArgs): undefined {
  withoutHostedUi(args);
  args.explicitAuthFlows = ["ALLOW_ADMIN_USER_PASSWORD_AUTH"];
  args.refreshTokenValidity = TOKEN_VALIDITY.serverRefreshMinutes;
  args.tokenValidityUnits = { idToken: "minutes", accessToken: "minutes", refreshToken: "minutes" };
}

export function applyGuestSignupClient(args: UserPoolClientArgs): undefined {
  withoutHostedUi(args);
  args.generateSecret = true;
  args.explicitAuthFlows = ["ALLOW_REFRESH_TOKEN_AUTH"];
  args.readAttributes = [...GUEST_SIGNUP_ATTRIBUTES.read];
  args.writeAttributes = [...GUEST_SIGNUP_ATTRIBUTES.write];
  args.refreshTokenValidity = TOKEN_VALIDITY.serverRefreshMinutes;
  args.tokenValidityUnits = { idToken: "minutes", accessToken: "minutes", refreshToken: "minutes" };
}

export const preTokenTrigger = new sst.aws.Function("PreTokenTrigger", {
  handler: TRIGGER_HANDLERS.preToken,
  description: "Console sign-in: world, role and staff id from the staff row; READY worlds, any state for a self-signup world",
  // Cognito waits 5 s for a trigger; the trigger's own budget is 1 s (a few reads and one append).
  timeout: "5 seconds",
  memory: "512 MB",
  // Links carry only the table names (infra/storage-tables.ts); the access is exactly this.
  link: [Worlds, AuditLog, Leads],
  permissions: [
    tableAccess("Worlds", "read"),
    tableAccess("AuditLog", "append", WORLD_LEADING_KEYS.PreTokenTrigger.write),
    ...leadsPermissions("PreTokenTrigger", Leads.arn),
  ],
});

const budgets = SIGNUP_FUNCTION_BUDGETS;

export const preSignUpTrigger = new sst.aws.Function("PreSignUpTrigger", {
  handler: TRIGGER_HANDLERS.preSignUp,
  description: "Console user pool: invitations, and a self sign-up only from the current request of that email",
  timeout: `${budgets.PreSignUpTrigger.timeoutSeconds} seconds`,
  memory: `${budgets.PreSignUpTrigger.memoryMb} MB`,
  link: [Leads],
  permissions: leadsPermissions("PreSignUpTrigger", Leads.arn),
});

// Worlds and Runtime only in the self-signup and QA partitions; AuditLog in those and in the signup's
// global audit partition (WORLD_LEADING_KEYS.PostConfirmationTrigger).
const postConfirmationKeys: readonly string[] = WORLD_LEADING_KEYS.PostConfirmationTrigger.write;
const worldPartitions = postConfirmationKeys.filter((key) => key.startsWith("W#"));
const itemWrites = (table: typeof Worlds) => ({ actions: [...POST_CONFIRMATION_TABLE_ACTIONS], resources: [table.arn], conditions: leadingKeysConditions(worldPartitions) });

export const postConfirmationTrigger = new sst.aws.Function("PostConfirmationTrigger", {
  handler: TRIGGER_HANDLERS.postConfirmation,
  description: "Self sign-up confirmed: registers the lead and asks for the guest world; never builds it",
  timeout: `${budgets.PostConfirmationTrigger.timeoutSeconds} seconds`,
  memory: `${budgets.PostConfirmationTrigger.memoryMb} MB`,
  // WorldJanitor by its fixed name (infra/world-janitor-link.ts), never its Function: the janitor links
  // the pool, and the pool needs this trigger's ARN (a dependency cycle). LeadNotifier links no pool.
  link: [Leads, Worlds, Runtime, AuditLog, leadNotifier, WorldJanitorInvoke],
  permissions: [
    ...leadsPermissions("PostConfirmationTrigger", Leads.arn),
    itemWrites(Worlds),
    itemWrites(Runtime),
    tableAccess("AuditLog", "append", postConfirmationKeys),
  ],
});

export const customMessageTrigger = new sst.aws.Function("CustomMessageTrigger", {
  handler: TRIGGER_HANDLERS.customMessage,
  description: "Texts of the sign-up, recovery and invitation emails (es/en), no data, no link",
  timeout: `${budgets.CustomMessageTrigger.timeoutSeconds} seconds`,
  memory: `${budgets.CustomMessageTrigger.memoryMb} MB`,
});

const emailConfiguration = readSesIdentity().apply(authEmailConfiguration);

export const userPool = new sst.aws.CognitoUserPool("ConsoleUserPool", {
  mfa: "optional",
  softwareToken: true,
  triggers: {
    preSignUp: preSignUpTrigger.arn,
    postConfirmation: postConfirmationTrigger.arn,
    customMessage: customMessageTrigger.arn,
    preTokenGeneration: preTokenTrigger.arn,
    preTokenGenerationVersion: "v2",
  },
  transform: {
    userPool: (args) => applyPoolPolicy(args, emailConfiguration),
  },
});

export const consoleClient = userPool.addClient("ConsoleClient", { transform: { client: applyConsoleClient } });
export const serverClient = userPool.addClient("ServerClient", { transform: { client: applyServerClient } });
export const guestSignupClient = userPool.addClient("GuestSignupClient", { transform: { client: applyGuestSignupClient } });

const GROUP_DESCRIPTIONS: Readonly<Record<StaffGroup, string>> = {
  SUPERVISOR: "Approves above the operator cap and escalations",
  OPERATOR: "Works the inbox, approves up to its cap, answers in writing",
  COMPLIANCE: "Read-only: tape, register, emails and metrics",
  GUEST: "Guest: own world, no password change, no TOTP",
};

export const staffGroups = STAFF_GROUPS.map(
  (group, precedence) =>
    new aws.cognito.UserGroup(`${group.charAt(0)}${group.slice(1).toLowerCase()}Group`, {
      userPoolId: userPool.id,
      name: group,
      precedence,
      description: GROUP_DESCRIPTIONS[group],
    }),
);

const region = aws.getRegionOutput({}).region;

/** Linked as `Resource.Auth` (packages/bff/src/auth/config.ts); ids only, no permission. */
export const auth = new sst.Linkable("Auth", {
  properties: {
    userPoolId: userPool.id,
    consoleClientId: consoleClient.id,
    serverClientId: serverClient.id,
    region,
  },
});

/**
 * Linked as `Resource.GuestSignup` to the Bff and the QaDriver only (packages/bff/src/guests/runtime.ts):
 * the confidential client with its secret, and whether the pool already mails through SES.
 */
export const guestSignup = new sst.Linkable("GuestSignup", {
  properties: {
    userPoolId: userPool.id,
    clientId: guestSignupClient.id,
    clientSecret: guestSignupClient.secret,
    region,
    mailReady: emailConfiguration.apply(mailReady),
  },
});

/** Variables Vite reads at build time (packages/web/src/lib/env.ts); only the SRP client. */
export const authWebEnvironment: Record<string, $util.Input<string>> = {
  VITE_COGNITO_USER_POOL_ID: userPool.id,
  VITE_COGNITO_CLIENT_ID: consoleClient.id,
};
