/// <reference path="../../sst-env.d.ts" />
// Custom-message trigger of the console user pool (docs/architecture-guests.md §3, §9): the subject
// and body of every email Cognito sends, from copy/auth-mail.ts, in the language of the sign-up
// (`clientMetadata.locale`, Spanish by default). Sign-up and resend → the confirmation code; forgot
// password → the recovery code; an administrator's invitation → the staff invitation; anything else →
// a neutral text with the code. No link, no demo data, nothing about how the product was built. It
// reads and writes nothing.
import type { CustomMessageTriggerEvent } from "aws-lambda";
import { type AuthMail, fallbackCodeMail, recoveryCodeMail, signupCodeMail, staffInvitationMail } from "../copy/auth-mail";
import type { SignupLocale } from "../copy/signup-consent";

/** Sign-in page named by the staff invitation; the app's own domain (infra/dns.ts). */
export const LOGIN_URL = "https://reclamo.demo.craftech.io/login";

function localeOf(event: CustomMessageTriggerEvent): SignupLocale {
  return event.request.clientMetadata?.locale === "en" ? "en" : "es";
}

/** The email of a trigger source, or `undefined` when Cognito's own (SMS) text must stay. */
export function messageFor(event: CustomMessageTriggerEvent): AuthMail | undefined {
  const locale = localeOf(event);
  switch (event.triggerSource) {
    case "CustomMessage_SignUp":
    case "CustomMessage_ResendCode":
      return signupCodeMail(locale);
    case "CustomMessage_ForgotPassword":
      return recoveryCodeMail(locale);
    case "CustomMessage_AdminCreateUser":
      return staffInvitationMail(LOGIN_URL);
    default:
      return fallbackCodeMail(locale);
  }
}

/** Lambda entry (infra/auth.ts `TRIGGER_HANDLERS.customMessage`). */
export async function handler(event: CustomMessageTriggerEvent): Promise<CustomMessageTriggerEvent> {
  const mail = messageFor(event);
  if (!mail) return event;
  return { ...event, response: { ...event.response, emailSubject: mail.subject, emailMessage: mail.html } };
}
