// Texts of every email Cognito sends (docs/architecture-guests.md §9): the sign-up code (also on a
// resend), the password-recovery code and the staff invitation. The custom-message trigger
// (auth-triggers/custom-message.ts) picks one by trigger source and by the language of the sign-up;
// infra/auth-email.ts puts the invitation in the pool's own template too. Plain words, no links (the
// code is typed on the screen that asked for it), no demo data, nothing about how the product was
// built. Cognito replaces `{####}` with the code (and `{username}` in the invitation); both
// placeholders must stay in the message.
import type { SignupLocale } from "./signup-consent";

export interface AuthMail {
  readonly subject: string;
  /** HTML body (Cognito sends one body); short, no link, no image. */
  readonly html: string;
}

export const CODE_PLACEHOLDER = "{####}";
export const USERNAME_PLACEHOLDER = "{username}";

const SIGNATURE = "Reclamo en regla · Powered by Craftech";

function body(paragraphs: readonly string[]): string {
  return [...paragraphs.map((paragraph) => `<p>${paragraph}</p>`), `<p>— ${SIGNATURE}</p>`].join("\n");
}

const SIGNUP_CODE: Readonly<Record<SignupLocale, AuthMail>> = {
  es: {
    subject: "Tu código para Reclamo en regla",
    html: body([
      "Hola.",
      `Tu código para confirmar tu email es <strong>${CODE_PLACEHOLDER}</strong>. Vence en 24 horas.`,
      "Si no creaste una cuenta en Reclamo en regla, ignorá este mensaje: sin el código no se activa nada.",
    ]),
  },
  en: {
    subject: "Your Reclamo en regla code",
    html: body([
      "Hi.",
      `Your code to confirm your email is <strong>${CODE_PLACEHOLDER}</strong>. It expires in 24 hours.`,
      "If you didn't create a Reclamo en regla account, ignore this message: nothing is activated without the code.",
    ]),
  },
};

const RECOVERY_CODE: Readonly<Record<SignupLocale, AuthMail>> = {
  es: {
    subject: "Tu código para elegir una nueva contraseña",
    html: body([`Tu código para elegir una nueva contraseña es <strong>${CODE_PLACEHOLDER}</strong>. Vence en 1 hora.`, "Si no lo pediste, ignorá este mensaje: tu contraseña no cambia."]),
  },
  en: {
    subject: "Your code to choose a new password",
    html: body([`Your code to choose a new password is <strong>${CODE_PLACEHOLDER}</strong>. It expires in 1 hour.`, "If you didn't ask for it, ignore this message: your password stays the same."]),
  },
};

/** Code of a sign-up or of a resend, in the language of the sign-up. */
export function signupCodeMail(locale: SignupLocale): AuthMail {
  return SIGNUP_CODE[locale];
}

/** Code of a password recovery. */
export function recoveryCodeMail(locale: SignupLocale): AuthMail {
  return RECOVERY_CODE[locale];
}

/** Invitation of a staff account (`console:invite`), es-AR with an English gloss. */
export function staffInvitationMail(loginUrl: string): AuthMail & { readonly sms: string } {
  return {
    subject: "Tu cuenta de Reclamo en regla · Your Reclamo en regla account",
    html: [
      "<p>Hola:</p>",
      "<p>Te dieron una cuenta en la consola de <strong>Reclamo en regla</strong>, el agente de reclamos de Jarilla, un prestamista ficticio.</p>",
      `<p>Usuario: <strong>${USERNAME_PLACEHOLDER}</strong><br>Contraseña temporal: <strong>${CODE_PLACEHOLDER}</strong></p>`,
      `<p>Entrá en <a href="${loginUrl}">${loginUrl}</a>. Al ingresar te vamos a pedir una contraseña nueva; la temporal vence en 7 días.</p>`,
      "<p>You have an account on the Reclamo en regla console. Sign in with the username and temporary password above; you will be asked to choose a new password.</p>",
      "<p>Reclamo en regla · Powered by Craftech. Datos 100 % sintéticos · 100 % synthetic data.</p>",
    ].join("\n"),
    sms: `Reclamo en regla: usuario ${USERNAME_PLACEHOLDER}, contraseña temporal ${CODE_PLACEHOLDER}.`,
  };
}

/** Any other message Cognito may send: neutral, with the code and nothing else. */
export function fallbackCodeMail(locale: SignupLocale): AuthMail {
  return locale === "en"
    ? { subject: "Your Reclamo en regla code", html: body([`Your code is <strong>${CODE_PLACEHOLDER}</strong>.`]) }
    : { subject: "Tu código de Reclamo en regla", html: body([`Tu código es <strong>${CODE_PLACEHOLDER}</strong>.`]) };
}
