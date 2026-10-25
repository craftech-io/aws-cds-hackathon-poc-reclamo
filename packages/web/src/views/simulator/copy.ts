// Texts of the phone simulator (`/app/simulator`, docs/design-brief.md §9): Rioplatense Spanish with the
// English gloss on headings and key buttons. The label "WhatsApp (simulado)", the upload notice and the
// buttons shared with the console come from packages/bff/src/copy, their single source.
import { CONSOLE_EN, STAFF_GLOSS } from "@reclamo/bff/copy/en-gloss";
import { CONSOLE_ES, STAFF_TEXT } from "@reclamo/bff/copy/es-AR";
import { mediaCopy, scanText } from "../../copy/media";

export const simulatorCopy = {
  frameLabel: STAFF_TEXT.SIMULATOR_LABEL,
  frameLabelEn: STAFF_GLOSS.SIMULATOR_LABEL,
  lead: "El teléfono de las 41 personas sintéticas de Jarilla (ficticio). Cada mensaje entra por el mismo camino que uno real de WhatsApp: identidad, topes, clasificador, agente y la compuerta de salida.",
  gloss: {
    toggle: "EN",
    toggleLabel: "Mostrar la glosa en inglés · Show the English gloss",
    agentText: "Free text written by the agent: it has no fixed gloss.",
  },
  personas: {
    title: "Personas · Personas",
    filter: "Buscar persona o escenario",
    empty: "Ninguna persona coincide con la búsqueda.",
    unlinked: "Número no vinculado",
    unlinkedScenario: "Un teléfono que no es de ningún cliente de Jarilla",
    open: (name: string) => `Abrir el teléfono de ${name}`,
  },
  phone: {
    title: (name: string) => `Teléfono de ${name}`,
    empty: "Todavía no hay mensajes. Mandá el mensaje del guion para empezar.",
    typing: "El agente está escribiendo… · The agent is typing…",
    template: "Plantilla",
    image: mediaCopy.image,
    scan: scanText,
    tap: (title: string) => `Tocar “${title}”`,
    markRead: "Marcar leído · Mark as read",
    status: {
      SENT: "Enviado",
      DELIVERED: "Entregado",
      READ: "Leído",
      FAILED: "No entregado",
      PENDING: "Pendiente",
      DEFERRED: "Diferido",
      BLOCKED: "Bloqueado",
      UNKNOWN_DELIVERY: "Entrega sin confirmar",
      RECEIVED: "Recibido",
    } as Readonly<Record<string, string>>,
  },
  script: {
    title: "Guion de la persona · Persona script",
    send: `${CONSOLE_ES.BUTTON_SEND_SCRIPT} · ${CONSOLE_EN.BUTTON_SEND_SCRIPT}`,
    sendWithReceipt: "Mandar mensaje y comprobante del guion · Send the script message and receipt",
    allSent: "Ya mandaste todos los mensajes del guion de esta persona.",
    receipt: "con comprobante sintético",
    next: "Próximo",
    sent: "Enviado",
  },
  composer: {
    label: "Mensaje como la persona",
    placeholder: "Escribí como la persona…",
    send: `${CONSOLE_ES.BUTTON_SEND} · ${CONSOLE_EN.BUTTON_SEND}`,
    attach: `${CONSOLE_ES.BUTTON_ATTACH_RECEIPT} · ${CONSOLE_EN.BUTTON_ATTACH_RECEIPT}`,
    closeAttach: "Cerrar adjuntos",
  },
  attach: {
    title: "Adjuntar un comprobante",
    synthetic: "Comprobante sintético de la persona",
    sendSynthetic: "Mandar el comprobante sintético",
    noSynthetic: "Esta persona no tiene un comprobante sintético en su guion.",
    own: "Imagen de prueba (JPG o PNG, hasta 3,75 MB)",
    notice: STAFF_TEXT.SIMULATOR_UPLOAD_NOTICE,
    noticeEn: STAFF_GLOSS.SIMULATOR_UPLOAD_NOTICE,
    sendOwn: "Subir y mandar la imagen",
    scanning: "La imagen se escanea antes de que el agente la lea.",
    TOO_LARGE: "La imagen pesa más de 3,75 MB.",
    EMPTY: "El archivo está vacío.",
    UNSUPPORTED: "Solo imágenes JPG o PNG.",
  },
  done: {
    sent: "Mensaje enviado desde el teléfono de la persona.",
    tapped: "Botón tocado.",
    attached: "Comprobante enviado.",
    read: "Mensajes marcados como leídos.",
    rejected: "El mensaje no entró: ",
  },
  liveMode: "El simulador está apagado: en este mundo WhatsApp funciona en vivo con un número real.",
  unlinkedNote: "Un número no vinculado no tiene hilo en tu mundo: la respuesta fija queda registrada en la cinta de cumplimiento.",
  /** Why `InboundWhatsApp` did not take a message, in words. */
  rejections: {
    RATE_LIMITED: "demasiados mensajes seguidos de este teléfono",
    WORLD_RESETTING: "el mundo se está reiniciando",
  } as Readonly<Record<string, string>>,
  rejectedOther: "el canal no lo aceptó",
  refusals: {
    WHATSAPP_LIVE: "El simulador está apagado mientras WhatsApp funciona en vivo en este mundo.",
    SIM_BUTTON_NOT_FOUND: "Ese botón ya no está disponible.",
    SIM_NO_RECEIPT: "Esta persona no tiene un comprobante sintético.",
    SIM_MEDIA_KEY: "La imagen no se subió desde este simulador; volvé a subirla.",
    SIM_UNLINKED: "El número no vinculado no tiene hilo en este mundo.",
  } as Readonly<Record<string, string>>,
} as const;
