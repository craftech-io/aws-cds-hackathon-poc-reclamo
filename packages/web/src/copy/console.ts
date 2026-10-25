// Every string of the console shell. Rioplatense Spanish (voseo) with an English gloss on the
// navigation, headings and key buttons (docs/design-brief.md §9): guests read both. Customer-facing
// texts live in packages/bff/src/copy/es-AR.ts. From wave 5 on, each view keeps its own texts in
// views/<view>/copy.ts; this file keeps the shell and the shared keys. Texts that are also the
// BFF's (the reset screen) come from packages/bff/src/copy, their single source.
import { STAFF_TEXT } from "@reclamo/bff/copy/es-AR";
import { STAFF_GLOSS } from "@reclamo/bff/copy/en-gloss";

export const PRODUCT_NAME = "Reclamo en regla";

export const copy = {
  app: {
    tagline: "Consola de reclamos · Complaints console",
    loading: "Cargando la consola…",
    signOut: "Cerrar sesión · Sign out",
    roleLabel: "Rol",
    worldLabel: "Mundo",
    /** What a self-signup guest reads instead of its world's technical id. */
    ownWorld: "Tu entorno de prueba",
    skipToContent: "Ir al contenido",
    syntheticData: "Prestamista ficticio · datos 100 % sintéticos",
    notLegalAdvice: "Nuestra lectura de las reglas, no asesoramiento legal",
  },
  roles: {
    OPERATOR: "Operador",
    SUPERVISOR: "Supervisor",
    COMPLIANCE: "Cumplimiento",
    GUEST: "Invitado",
  },
  login: {
    unconfiguredTitle: "Consola sin configurar",
    unconfiguredLead: "Faltan variables de build del stage (infra/auth.ts). Sin ellas no hay login.",
    noAccessTitle: "Tu usuario no tiene un mundo asignado",
    noAccessLead: "Ingresaste correctamente, pero tu usuario no tiene una fila de personal en ningún mundo. Pedile al equipo de la demo que lo revise.",
  },
  errors: {
    notFoundTitle: "Esta página no existe · Not found",
    notFoundLead: "Revisá el enlace o volvé a la bandeja.",
    forbiddenTitle: "Tu rol no tiene acceso a esta vista · Forbidden",
    forbiddenLead: "Cada rol ve lo que le corresponde; cumplimiento es solo lectura.",
    backHome: "Volver a la bandeja",
  },
  nav: {
    groups: {
      complaints: "Reclamos · Complaints",
      compliance: "Cumplimiento · Compliance",
      demo: "Demo",
    },
    menu: "Menú · Menu",
    menuTitle: "Navegación · Navigation",
    close: "Cerrar · Close",
  },
  views: {
    inbox: {
      title: "Bandeja · Inbox",
      description: "Cada reclamo con su número, tipo, plazo restante en días hábiles, estado del SLA, control y quién lo bloquea.",
    },
    complaint: {
      title: "Reclamo · Complaint",
      description: "Línea de tiempo unificada, evidencia, acciones, respuesta escrita y el próximo hito.",
    },
    customer: {
      title: "Cliente · Customer",
      description: "Cuenta, billetera, préstamos y movimientos del core simulado, y el redactor que pasa por la compuerta.",
    },
    approvals: {
      title: "Aprobaciones · Approvals",
      description: "Acciones del agente por encima de su tope: el agente nunca aprueba su propia acción.",
    },
    tape: {
      title: "Cinta de cumplimiento · Compliance tape",
      description: "Cada decisión de la política de canal: permitido, bloqueado o reencaminado, con su regla.",
    },
    register: {
      title: "Registro de reclamos · Register",
      description: "Registro append-only con su cadena de hash y sus anclas, exportable.",
    },
    emails: {
      title: "Emails · Emails",
      description: "Cada email enviado tal como salió, con sus adjuntos, eventos de SES y constancia de entrega.",
    },
    policy: {
      title: "Política de canal · Channel policy",
      description: "Reglas CH-* con su versión y los modos de canal del mundo.",
    },
    metrics: {
      title: "Métricas · Metrics",
      description: "Tiempo al número, resueltos sin persona, respuestas a tiempo, violaciones de política y costo por reclamo.",
    },
    simulator: {
      title: "Simulador de teléfono · Phone simulator",
      description: "WhatsApp (simulado): las personas sintéticas y sus hilos.",
    },
    clock: {
      title: "Reloj de demo · Demo clock",
      description: "Hora simulada del mundo, compresión y próximos hitos.",
    },
    tour: {
      title: "Recorrido guiado · Guided tour",
      description: "Los pasos para ver el producto en unos minutos.",
    },
  },
  shell: {
    readOnlyClock: "Cumplimiento mira el reloj; no lo mueve.",
    resettingTitle: "Reiniciando el mundo · Resetting the world",
    resettingLead: `${STAFF_TEXT.WORLD_RESETTING} · ${STAFF_GLOSS.WORLD_RESETTING}`,
    resettingPhase: "Fase",
    tourTitle: "Recorrido guiado · Guided tour",
    tourEstimate: (minutes: number) => `Tu recorrido: ~${minutes} min · Your tour: ~${minutes} min`,
    tourOpen: "Ver el recorrido · Open the tour",
  },
  placeholder: {
    title: "Vista en construcción",
    lead: "Esta vista llega en una próxima ola del plan de construcción.",
  },
} as const;
