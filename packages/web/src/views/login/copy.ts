// Texts of the sign-in machine: the credentials (the Spanish of the login page, views/login/auth-copy-es.ts)
// and the staff-only steps and the recent-login step-up, in Rioplatense Spanish with an English gloss
// on the headings and key buttons, like the console (docs/design-brief.md §9). Error texts never say
// whether a username has an account (lib/auth/errors.ts).
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import type { PasswordRule } from "../../lib/auth/credentials";

export const loginCopy = {
  credentials: {
    title: "Ingresá a la consola",
    lead: "Usá tu email si creaste tu cuenta, o el usuario que te dieron (por ejemplo, operator-01).",
    username: "Usuario o email",
    password: "Contraseña",
    submit: "Ingresar",
    sessionExpired: "La sesión venció. Ingresá de nuevo.",
  },
  password: {
    show: "Mostrar",
    hide: "Ocultar",
    rulesTitle: "La contraseña necesita:",
    rules: {
      length: "12 caracteres o más",
      lower: "una minúscula",
      upper: "una mayúscula",
      number: "un número",
    } satisfies Record<PasswordRule, string>,
    confirm: "Repetí la contraseña",
    mismatch: "Las dos contraseñas no coinciden.",
    outerSpaces: "La contraseña no puede empezar ni terminar con un espacio.",
  },
  newPassword: {
    title: "Elegí tu contraseña · Choose your password",
    lead: "Es tu primer ingreso: reemplazá la contraseña temporal por una propia.",
    field: "Contraseña nueva",
    submit: "Guardar y seguir · Save",
  },
  mfaSetup: {
    title: "Activá el código de verificación · Set up TOTP",
    lead: "Tu usuario pide un código de verificación (TOTP). Se configura una sola vez, acá mismo.",
    steps: [
      "Abrí tu app de autenticación: Google Authenticator, Microsoft Authenticator, 1Password o similar.",
      "Escaneá el código QR, o cargá la clave a mano.",
      "Escribí el código de 6 dígitos que te muestra la app.",
    ],
    qrLabel: "Código QR para tu app de autenticación",
    manualKey: "Clave para cargar a mano",
    code: "Código de 6 dígitos",
    submit: "Activar · Enable",
  },
  totp: {
    title: "Código de verificación · Verification code",
    lead: "Escribí el código de 6 dígitos que muestra tu app de autenticación.",
    code: "Código",
    submit: "Verificar · Verify",
  },
  back: "Volver al ingreso",
  otherUser: "Ingresar con otro usuario",
  working: "Un momento…",
  errors: {
    INVALID_CREDENTIALS: "El usuario o la contraseña no son correctos.",
    INVALID_CODE: "El código no es válido o ya venció. Probá con el que muestra ahora.",
    WEAK_PASSWORD: "La contraseña no cumple los requisitos.",
    SESSION_EXPIRED: "Pasó demasiado tiempo. Empezá de nuevo con tu usuario y tu contraseña.",
    TOO_MANY_ATTEMPTS: "Demasiados intentos. Esperá unos minutos y volvé a probar.",
    UNAVAILABLE: "No pudimos comunicarnos con el servicio de ingreso. Revisá tu conexión y reintentá.",
    UNSUPPORTED: "Tu usuario pide un método de verificación que la consola no admite. Pedile ayuda al equipo de la demo.",
    DIFFERENT_USER: "Ese no es el usuario de esta sesión. Confirmá con el tuyo.",
  } satisfies Record<AuthFlowErrorCode, string>,
  stepUp: {
    title: "Aprobar dinero exige un login reciente · Approving money requires a recent sign-in",
    lead: "Aprobar una acción, responder por escrito o reiniciar el mundo pide haber ingresado en los últimos 15 minutos. Confirmá con tu contraseña.",
    done: "Listo. Ya podés volver a intentar la acción.",
  },
  close: "Cerrar",
  legal: { privacy: "Privacidad", terms: "Términos" },
} as const;
