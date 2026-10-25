// Texts shared by the data-driven views: loading and error states and the refusal of each BFF
// `reason` (packages/bff/src/auth/errors.ts and the routers). The server messages are English and
// technical; what the operator reads comes from here.
import { STAFF_TEXT } from "@reclamo/bff/copy/es-AR";

export const dataCopy = {
  loading: "Cargando…",
  retry: "Reintentar",
  reference: "Código de referencia",
  recentLogin: {
    confirm: "Confirmar con mi contraseña · Confirm",
  },
  unauthorized: {
    signIn: "Ingresar de nuevo",
  },
  byKind: {
    recentLogin: "Aprobar dinero, responder por escrito o reiniciar el mundo pide haber ingresado con tu contraseña en los últimos 15 minutos.",
    unauthorized: "La sesión venció. Ingresá de nuevo.",
    forbidden: "Tu rol no tiene acceso a esta información o acción.",
    notFound: "No encontramos lo que buscabas.",
    conflict: "Alguien ya resolvió esto o cambió mientras lo mirabas. Actualizá y volvé a intentar.",
    invalid: "Los datos no pasaron la validación.",
    precondition: "La acción no se puede hacer en el estado actual.",
    unavailable: "El servicio no respondió. Probá de nuevo en unos segundos.",
    network: "No pudimos comunicarnos con la consola. Revisá tu conexión y reintentá.",
    unknown: "Algo salió mal. Si se repite, pasale el código de referencia al equipo técnico.",
  },
  byReason: {
    LOGIN_NOT_RECENT: "Pasaron más de 15 minutos desde que ingresaste. Confirmá tu contraseña para seguir.",
    ROLE_NOT_ALLOWED: "Tu rol no puede hacer esta acción.",
    READ_ONLY_ROLE: "Cumplimiento es un rol de solo lectura.",
    CROSS_WORLD: "Ese dato no pertenece a tu mundo.",
    STAFF_INACTIVE: "Tu usuario ya no está activo en este mundo.",
    WORLD_RESETTING: STAFF_TEXT.WORLD_RESETTING,
  } as Readonly<Record<string, string>>,
} as const;
