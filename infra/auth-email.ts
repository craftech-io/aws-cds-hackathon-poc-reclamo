// Emails of the console user pool, sent through the app's SES identity (docs/architecture.md §1 and
// §11, docs/architecture-guests.md §2, §9 and §12, ADR-0003: outbound only).
//
// What the pool sends: the staff invitation (`AdminCreateUser`, only to `demoRecipients`), and for a
// self-signup guest the sign-up code (and its resends) and the password-recovery code. The texts live
// in packages/bff/src/copy/auth-mail.ts, the single source: the custom-message trigger picks one per
// message and language, and the pool's own invitation template below is the same invitation. They are
// a declared exception to "every outbound message goes through the gate": the gate covers messages to
// customers, these are account emails.
//
// How it is sent, in two phases decided when the deploy starts (the identity belongs to
// infra/messaging-email.ts, WP-18, and DKIM takes a while after it is created):
//   1. identity missing or not verified for sending: Cognito's own sender (`COGNITO_DEFAULT`, no custom
//      FROM, 50 emails a day). The self-signup stays closed meanwhile: `GuestSignup.mailReady` is false
//      and `signup.start` answers `SIGNUP_UNAVAILABLE` (fail closed); scripts/console/invite.ts refuses
//      emailed invitations while the pool has no SES sender.
//   2. identity verified (DKIM SUCCESS): `DEVELOPER`, from `Reclamo en regla <no-reply@<domain>>`,
//      WITHOUT a configuration set (no header carries the technical id of the app). Cognito sends
//      through its service-linked role `AWSServiceRoleForAmazonCognitoIdpEmailService`, which the
//      deploy role may create (bootstrap `IamServiceLinkedRoles`).
// The sending authorization policy of the identity (Cognito's email principal, `aws:SourceAccount`,
// `ArnEquals aws:SourceArn` = the EXACT ARN of this pool, `ses:FromAddress` = no-reply@, no recipient
// condition) belongs to the identity's module, infra/messaging-email.ts (`cognito-user-pool-mail`,
// WP-18), built in every deploy from `userPool.arn`: the pool never depends on it, so there is no cycle
// and no lookup by name. If Cognito ever refused the switch to DEVELOPER in the deploy that created the
// policy, re-running the CI job fixes it (the policy exists by then); docs/architecture.md §16.
//
// Verify (reads only):
//   aws --profile craftech-demos cognito-idp describe-user-pool --user-pool-id <id> --query UserPool.EmailConfiguration

import { staffInvitationMail } from "../packages/bff/src/copy/auth-mail";
import { appDomain, appUrl, noReplyFromAddress } from "./dns";

/** FROM of every account email and of the lead notices, with the product name as display name. */
export const authMailFrom = `Reclamo en regla <${noReplyFromAddress}>`;

/** Sign-in page of the console. */
export const loginUrl = `${appUrl}/login`;

// Cognito's limits for the invitation template: {username} and {####} (the temporary password) must
// both appear in the message. The SMS text is never sent (the pool has no SMS configuration), but
// CreateUserPool rejects an empty one (length ≥ 6) because the provider always sends the field.
export const INVITATION_SUBJECT_MAX_LENGTH = 140;
export const INVITATION_MESSAGE_MAX_LENGTH = 20_000;
export const INVITATION_SMS_MIN_LENGTH = 6;
export const INVITATION_SMS_MAX_LENGTH = 140;

const invitation = staffInvitationMail(loginUrl);

/** Invitation template of the pool (`adminCreateUserConfig.inviteMessageTemplate`), the text of copy/auth-mail.ts. */
export const invitationTemplate = {
  emailSubject: invitation.subject,
  emailMessage: invitation.html,
  smsMessage: invitation.sms,
} as const;

/** What a deploy knows about the SES identity when it starts. */
export interface SesIdentityState {
  readonly arn: string;
  readonly verifiedForSending: boolean;
}

/** `emailConfiguration` of the pool for this deploy. */
export type AuthEmailConfiguration =
  | { readonly emailSendingAccount: "COGNITO_DEFAULT" }
  | { readonly emailSendingAccount: "DEVELOPER"; readonly sourceArn: string; readonly fromEmailAddress: string };

/** Phase 2 (SES, no-reply@) only with a verified identity; Cognito's default sender otherwise. */
export function authEmailConfiguration(identity: SesIdentityState | undefined): AuthEmailConfiguration {
  if (identity === undefined || !identity.verifiedForSending) return { emailSendingAccount: "COGNITO_DEFAULT" };
  return { emailSendingAccount: "DEVELOPER", sourceArn: identity.arn, fromEmailAddress: authMailFrom };
}

/** Whether the pool mails through SES: the self-signup opens only then (`GuestSignup.mailReady`). */
export function mailReady(configuration: AuthEmailConfiguration): boolean {
  return configuration.emailSendingAccount === "DEVELOPER";
}

/** Reads the SES identity once per deploy; a missing or foreign identity reads as "not there". */
export function readSesIdentity(): $util.Output<SesIdentityState | undefined> {
  return $util.output(
    aws.sesv2.getEmailIdentity({ emailIdentity: appDomain }).then(
      (result): SesIdentityState => ({ arn: result.arn, verifiedForSending: result.verifiedForSendingStatus }),
      () => undefined,
    ),
  );
}
