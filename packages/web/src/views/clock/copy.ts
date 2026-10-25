// Texts of the demo clock (`/app/clock`, docs/design-brief.md §9): Rioplatense Spanish with the English
// gloss on headings and key buttons. Button names shared with the rest of the console come from
// packages/bff/src/copy (`CONSOLE_ES` / `CONSOLE_EN`) and the shell's clock bar (ClockBanner).
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";
import { CONSOLE_ES, type ConsoleKey } from "@reclamo/bff/copy/es-AR";
import { CLOCK_TEXT } from "../../components/ClockBanner";
import { NETWORK_LABEL, TIMER_KIND_LABEL } from "../../copy/console-labels";
import { AUTH_COPY } from "../login/auth-copy";

const bi = (key: ConsoleKey) => `${CONSOLE_ES[key]} · ${CONSOLE_EN[key]}`;

export const clockCopy = {
  lead: "La hora del mundo es simulada y es tuya: la movés con estos botones y cada hito se evalúa a su propia hora simulada. Los topes contra abuso usan el reloj real.",
  now: {
    title: "Hora del mundo · World time",
    paused: "En pausa · Paused",
    running: (rate: number) => `En vivo ×${rate} · Live ×${rate}`,
    pace: (text: string) => `Compresión: ${text}`,
    liveFor: (minutes: number) => `Vuelve solo a pausa en ${minutes} min reales.`,
    liveEnding: "Vuelve a pausa en menos de un minuto real.",
  },
  busy: {
    title: "El mundo está ocupado · The world is busy",
    lead: "Mover el reloj espera a que el mundo esté quieto, así ningún hito se evalúa con un turno a medio camino.",
    pending: (count: number) => (count === 1 ? "1 cosa pendiente" : `${count} cosas pendientes`),
    forceAt: (time: string) => `Si sigue así, podés avanzar igual desde las ${time}.`,
    force: "Avanzar igual · Advance anyway",
    reasons: {
      EVENT_IN_FLIGHT: "un turno del agente o un evento en cola",
      EMAIL_PENDING: "un email esperando su evento de entrega de SES",
      SCAN_PENDING: "una imagen esperando su escaneo",
      TIMER_DUE: "un hito vencido que todavía no se despachó",
    } as Readonly<Record<string, string>>,
    unknownReason: "un trabajo del mundo en curso",
    reasonsEn: {
      EVENT_IN_FLIGHT: "an agent turn or a queued event",
      EMAIL_PENDING: "an email waiting for its SES delivery event",
      SCAN_PENDING: "an image waiting for its scan",
      TIMER_DUE: "a due milestone not dispatched yet",
    } as Readonly<Record<string, string>>,
    unknownReasonEn: "work of the world in progress",
    pendingKinds: { EVENT: "Evento en cola", MAIL: "Email sin evento de SES", SCAN: "Imagen en escaneo", TIMER: "Hito por despachar" } as Readonly<Record<string, string>>,
  },
  move: {
    title: "Mover el reloj · Move the clock",
    lead: "En pausa, cada salto despacha en orden todo lo que vence hasta la hora nueva. El reloj nunca vuelve atrás.",
    next: CLOCK_TEXT.next,
    hour: CLOCK_TEXT.hour,
    businessDay: CLOCK_TEXT.businessDay,
    moved: (from: string, to: string, fired: number) => `El reloj pasó de ${from} a ${to}${fired === 0 ? "." : fired === 1 ? "; se disparó 1 hito." : `; se dispararon ${fired} hitos.`}`,
  },
  live: {
    title: "Reloj en vivo · Live clock",
    lead: "El reloj corre comprimido durante 30 minutos reales y los hitos los disparan schedules reales de EventBridge Scheduler.",
    live: bi("BUTTON_LIVE_CLOCK"),
    liveHint: "1 día simulado por minuto real",
    slow: bi("BUTTON_SLOW_LIVE_CLOCK"),
    slowHint: "1 día simulado cada 5 minutos reales",
    custom: "Factor de compresión",
    customHint: (min: number, max: number) => `Segundos simulados por segundo real, de ${min} a ${max}.`,
    customInvalid: (min: number, max: number) => `Elegí un número entero de ${min} a ${max}.`,
    apply: "Usar este factor · Use this rate",
    pause: "Pausar · Pause",
    started: (rate: number) => `Reloj en vivo ×${rate} por 30 minutos.`,
    paused: "Reloj en pausa.",
  },
  upcoming: {
    title: "Próximos eventos · Upcoming events",
    lead: "Hitos de plazo, publicaciones de rendición y envíos diferidos que el reloj va a despachar.",
    empty: "No hay eventos pendientes en este mundo.",
    when: "Cuándo (hora simulada)",
    what: "Qué",
    complaint: "Reclamo",
    fire: bi("BUTTON_FIRE_TIMER_NOW"),
    fireLabel: (what: string) => `Disparar ahora: ${what}`,
    openComplaint: "Ver el reclamo",
    kinds: TIMER_KIND_LABEL,
    milestones: {
      OPERATOR_REMINDER: "recordatorio al operador (día hábil 5)",
      SUPERVISOR_ESCALATION: "escalamiento al supervisor (día hábil 8)",
      DEADLINE: "vencimiento (día hábil 10)",
    } as Readonly<Record<string, string>>,
    networks: NETWORK_LABEL,
  },
  /** The BFF's refusals of the clock, in words (any other refusal uses the console's generic texts). */
  refusals: {
    WORLD_BUSY: "El mundo está ocupado: esperá a que termine lo que está en curso y volvé a intentar.",
    CLOCK_NOTHING_PENDING: "No hay ningún evento pendiente para avanzar.",
    CLOCK_MOVE_TOO_LONG: "Un salto avanza como mucho 20 días simulados.",
    CLOCK_INVALID_RATE: "El factor de compresión va de 1 a 2.880.",
    CLOCK_MOVED: "El reloj cambió mientras mirabas. Actualizamos la vista: volvé a intentar.",
    TIMER_NOT_SCHEDULED: "Ese evento ya no está pendiente.",
    RATE_LIMITED: "Ya pediste un reinicio hace menos de 10 minutos. Esperá un poco y volvé a intentar.",
    // A self-signup world past its resets of the real day: the console's fixed usage-limit notice.
    RESET_DAILY_CAP: `${AUTH_COPY.es.provisioning.usageLimit} · ${AUTH_COPY.en.provisioning.usageLimit}`,
    WORLD_NOT_READY: "Tu mundo todavía no está listo; probá de nuevo en un minuto.",
  } as Readonly<Record<string, string>>,
  reset: {
    title: "Reiniciar este mundo · Reset this world",
    lead: "Vuelve tu mundo al punto de partida: el reloj en pausa el mié 07/10 10:10 y las personas sin reclamos tuyos. El registro, la cinta y la bitácora no se borran (son append-only). Tarda unos minutos y se puede pedir una vez cada 10 minutos.",
    ask: bi("BUTTON_RESET_WORLD"),
    confirm: "Sí, reiniciar · Yes, reset",
    cancel: "Cancelar · Cancel",
    confirmLead: "¿Seguro? Lo que hiciste en este mundo deja de verse en la consola.",
  },
} as const;
