// Texts of the customer file (docs/design-brief.md §9 "Cliente"; FL-064, FL-065, FL-066) and of the
// trail of the outbound gate that the case reuses. Rioplatense Spanish with the English gloss on the
// headings and the key buttons; rule reasons, reroutes and message kinds come from
// packages/bff/src/copy (single source).
import type { Channel, TapeEntryKind } from "@reclamo/shared";
import { CONSOLE_ES } from "@reclamo/bff/copy/es-AR";
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";

export const customerCopy = {
  notFound: "No encontramos ese cliente en tu mundo.",
  backToInbox: "Volver a la bandeja",
  lead: "Cuenta, billetera, préstamos y movimientos tal como los informa el core simulado (solo lectura), y el redactor: todo lo que una persona manda pasa por la misma compuerta que el agente.",
  synthetic: "Persona sintética de un prestamista ficticio.",
  sections: {
    profile: "Cliente · Customer",
    wallet: "Billetera · Wallet",
    loans: "Préstamos y cuotas · Loans and instalments",
    operations: "Movimientos · Operations",
    complaints: "Reclamos de este cliente · Complaints",
    challenge: "Desafío de identidad · Identity challenge",
    composer: `${CONSOLE_ES.HEADING_COMPOSER} · ${CONSOLE_EN.HEADING_COMPOSER}`,
  },
  profile: {
    document: "Documento",
    phone: "Teléfono",
    email: "Email",
    whatsapp: "WhatsApp",
    account: "Cuenta",
    conversation: "Conversación",
  },
  status: {
    account: { ACTIVE: "Activa", BLOCKED: "Bloqueada", CLOSING: "En baja", CLOSED: "Cerrada" },
    loan: { ACTIVE: "Al día", IN_ARREARS: "Con cuotas vencidas", CANCELLED: "Cancelado", EARLY_CANCELLED: "Cancelado anticipadamente" },
    operation: { COMPLETED: "Acreditado", PENDING: "Pendiente", REJECTED: "Rechazado", REVERSED: "Revertido" },
  },
  whatsapp: { optedOut: "Pidió no recibir mensajes (opt-out)", optedIn: "Con opt-in", none: "Sin opt-in" },
  wallet: { balance: "Saldo", cvu: "CVU", frozen: "Salidas congeladas", notFrozen: "Salidas habilitadas" },
  loans: {
    outstanding: "Saldo adeudado",
    instalments: (paid: number, total: number) => `${paid} de ${total} cuotas pagas`,
    number: "Cuota",
    due: "Vence",
    amount: "Importe",
    left: "Pendiente",
    status: "Estado",
    caption: (label: string) => `Cuotas de ${label}`,
    none: "Sin préstamos.",
  },
  operations: { caption: "Movimientos de los últimos 60 días", at: "Fecha", description: "Detalle", amount: "Importe", status: "Estado", none: "Sin movimientos en los últimos 60 días.", truncated: "Se muestran los más recientes." },
  complaints: { none: "Este cliente no tiene reclamos en tu mundo.", open: "Abierto", closed: "Cerrado" },
  challenge: {
    locked: "Bloqueado: dos respuestas fallidas en las últimas 24 horas reales.",
    counted: (failures: number, left: number) => `${failures} ${failures === 1 ? "fallo" : "fallos"} en 24 horas · quedan ${left} ${left === 1 ? "intento" : "intentos"}.`,
    clear: "Sin fallos en las últimas 24 horas.",
    unlock: `${CONSOLE_ES.BUTTON_UNLOCK_CHALLENGE} · ${CONSOLE_EN.BUTTON_UNLOCK_CHALLENGE}`,
    unlocked: "Bloqueo levantado y registrado en la auditoría.",
    nothing: "No había un bloqueo que levantar.",
    audited: "Levantar un bloqueo queda auditado con tu usuario.",
  },
  control: { AGENT: "La tiene el agente", OPERATOR: "La tiene una persona" },
  composer: {
    lead: "Elegí el tipo de mensaje y el canal. La política de canal decide en la compuerta, como para el agente: si lo bloquea, la cinta lo muestra en rojo y te ofrece el camino permitido.",
    kind: "Tipo de mensaje",
    channel: "Canal",
    complaint: "Reclamo (opcional)",
    noComplaint: "Sin reclamo",
    subject: "Asunto del email",
    text: "Mensaje",
    send: `${CONSOLE_ES.BUTTON_SEND} · ${CONSOLE_EN.BUTTON_SEND}`,
    queued: "En cola: la compuerta lo evalúa ahora.",
    drafts: {
      COLLECTION_REMINDER: "Te recordamos que tenés una cuota vencida de tu préstamo.",
    } as Readonly<Partial<Record<string, string>>>,
  },
  channel: { WHATSAPP: "WhatsApp", EMAIL: "Email" } satisfies Readonly<Record<Channel, string>>,
  trail: {
    title: "Lo que decidió la compuerta · Gate decision",
    waiting: "Esperando la decisión de la compuerta…",
    slow: "La decisión todavía no está en la cinta. Puede que el mundo esté ocupado: mirá la cinta de cumplimiento en un momento.",
    gloss: "EN",
    offered: "Camino permitido · Allowed path",
    humanQueued: "Tarea creada en la cola humana: aparece en la bandeja. No se envió nada.",
    caption: "Entradas de la cinta de este mensaje",
    sender: "Emisor",
    result: { SENT: "enviado", FAILED: "falló", UNKNOWN_DELIVERY: "entrega incierta" },
    decision: {
      ALLOWED: "Permitido",
      BLOCKED: "Bloqueado",
      REROUTED: "Reencaminado",
      DEFERRED: "Diferido",
      DISPATCH: "Envío",
    } satisfies Readonly<Record<TapeEntryKind, string>>,
    deferredUntil: (when: string) => `Sale a la próxima hora permitida: ${when}.`,
  },
  senders: { AGENT: "El agente", SYSTEM: "El sistema", OPERATOR: "Una persona del equipo" },
} as const;
