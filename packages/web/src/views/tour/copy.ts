// Texts of the guided tour's panel (`/app/tour`, docs/design-brief.md §15), in both languages: the guest
// picks one with the panel's switch. The steps themselves (titles, buttons, "Qué mirar") live in
// steps.ts, the single source the README and the stage's scenario also read.
import type { TourLang } from "./steps";

interface TourTexts {
  readonly lead: string;
  readonly langLabel: string;
  readonly yourTour: (minutes: number) => string;
  readonly finished: string;
  readonly pristineOk: (start: string) => string;
  readonly pristineTitle: string;
  readonly pristineClock: (now: string) => string;
  readonly pristineFiled: (number: string) => string;
  readonly pristineWays: string;
  readonly resetAsk: string;
  readonly resetConfirm: string;
  readonly cancel: string;
  readonly step: (id: string) => string;
  readonly now: string;
  readonly done: string;
  readonly optional: string;
  readonly look: string;
  readonly budget: string;
  readonly markDone: string;
  readonly startOver: string;
  readonly moveDone: string;
  readonly busy: (reason: string) => string;
  readonly missingComplaint: (persona: string) => string;
  /** The tour's own refusals of the BFF, in words; the rest go to the clock's or the console's texts. */
  readonly refusals: Readonly<Record<string, string>>;
}

export const TOUR_TEXTS: Readonly<Record<TourLang, TourTexts>> = {
  es: {
    lead: "Seguí los pasos en orden: cada botón hace lo mismo que el botón de su vista, con los mismos controles. Tu mundo es tuyo; nadie más lo ve.",
    langLabel: "Idioma del recorrido",
    yourTour: (minutes) => `Tu recorrido: ~${minutes} min`,
    finished: "Terminaste el recorrido. Podés seguir probando libremente.",
    pristineOk: (start) => `Tu mundo está en el punto de partida: reloj en pausa el ${start}, sin reclamos tuyos todavía.`,
    pristineTitle: "Tu mundo ya no está en el punto de partida",
    pristineClock: (now) => `El reloj está en ${now}.`,
    pristineFiled: (number) => `El reclamo de Valeria ya está registrado (${number}).`,
    pristineWays: "Para ver el recorrido como está escrito, reiniciá tu mundo o usá otra cuenta de invitado. También podés seguir desde donde estás.",
    resetAsk: "Reiniciar mi mundo",
    resetConfirm: "Sí, reiniciar",
    cancel: "Cancelar",
    step: (id) => `Paso ${id}`,
    now: "Ahora",
    done: "Hecho",
    optional: "Opcional",
    look: "Qué mirar",
    budget: "Tiempo",
    markDone: "Marcar como hecho",
    startOver: "Empezar el recorrido de nuevo",
    moveDone: "Listo",
    busy: (reason) => `El mundo está ocupado (${reason}): este botón se habilita cuando termina.`,
    missingComplaint: (persona) => `Primero mandá el mensaje del guion de ${persona}: todavía no tiene un reclamo.`,
    refusals: {
      TOUR_BUTTON_NOT_FOUND: "Ese botón todavía no llegó al teléfono: esperá la respuesta del agente y volvé a tocarlo.",
      COMPLAINT_NOT_FOUND: "Ese reclamo no está en tu mundo.",
      WHATSAPP_LIVE: "El simulador está apagado mientras WhatsApp funciona en vivo en este mundo.",
      WORLD_BUSY: "El mundo está ocupado: esperá a que termine lo que está en curso y volvé a intentar.",
    },
  },
  en: {
    lead: "Follow the steps in order: each button does the same as the button of its view, under the same controls. Your world is yours; nobody else sees it.",
    langLabel: "Tour language",
    yourTour: (minutes) => `Your tour: ~${minutes} min`,
    finished: "You finished the tour. Feel free to keep exploring.",
    pristineOk: (start) => `Your world is at its starting point: clock paused on ${start}, no complaints of yours yet.`,
    pristineTitle: "Your world is no longer at its starting point",
    pristineClock: (now) => `The clock is at ${now}.`,
    pristineFiled: (number) => `Valeria's complaint is already filed (${number}).`,
    pristineWays: "To see the tour as written, reset your world or use another guest account. You can also go on from where you are.",
    resetAsk: "Reset my world",
    resetConfirm: "Yes, reset",
    cancel: "Cancel",
    step: (id) => `Step ${id}`,
    now: "Now",
    done: "Done",
    optional: "Optional",
    look: "What to look at",
    budget: "Time",
    markDone: "Mark as done",
    startOver: "Start the tour again",
    moveDone: "Done",
    busy: (reason) => `The world is busy (${reason}): this button turns on when it finishes.`,
    missingComplaint: (persona) => `First send ${persona}'s script message: there is no complaint yet.`,
    refusals: {
      TOUR_BUTTON_NOT_FOUND: "That button has not reached the phone yet: wait for the agent's answer and tap it again.",
      COMPLAINT_NOT_FOUND: "That complaint is not in your world.",
      WHATSAPP_LIVE: "The simulator is off while WhatsApp runs live in this world.",
      WORLD_BUSY: "The world is busy: wait until what is in progress finishes and try again.",
    },
  },
};

/** Where the panel remembers the guest's language (a per-viewer convenience). */
export const TOUR_LANG_KEY = "reclamo.tour.lang";
