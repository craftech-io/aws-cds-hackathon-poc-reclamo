// The guided tour of a guest (docs/design-brief.md §15): ONE source for the console's "Recorrido
// guiado" panel (views/tour), the "Guided tour" section of the README and the steps of the scenario
// that walks it in the stage (`SC-21`). `npm run tour:check` (scripts/tour/check.ts) fails when the
// README or the scenario follow another list, and replays these steps over the `guest` template in a
// local world (scripts/tour/timeline.ts) to prove that every promised state and hour is real.
//
// A step has buttons ("moves"): `run` moves go through `tour.run`, so each passes the gates of the same
// click elsewhere; `open` moves take the guest to the view where the step happens (the composer, the
// approvals, the written answer), where the step's own button lives. "Qué mirar" (`look`) names its
// facts as `{placeholders}`: the panel fills them from the world (`tour.steps`, the clock) and falls
// back to the expected value, which the replay checks. Budgets are the design's until the first measured
// run of `SC-21` replaces them (packages/bff/src/routers/tour.ts keeps the same numbers).

import { REROUTE_LABEL } from "@reclamo/bff/copy/block-reasons";
import { BUTTON_TITLES } from "@reclamo/bff/copy/buttons";
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";
import { CONSOLE_ES, MESSAGE_KIND_LABEL } from "@reclamo/bff/copy/es-AR";

export const TOUR_STEP_IDS = ["1", "2", "2b", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];

export type TourBlock = "QUICK" | "DEEP";
export type TourLang = "es" | "en";

export interface Bilingual {
  readonly es: string;
  readonly en: string;
}

/** The personas of the tour (packages/bff/src/copy/persona-scripts.ts). */
export type TourPersona = "C01" | "C02" | "C03" | "C07" | "C09";

/** What a `run` move asks `tour.run` to do; a persona's complaint is resolved by the panel. */
export type TourAction =
  | { readonly kind: "sendScript"; readonly persona: TourPersona }
  | { readonly kind: "sendText"; readonly persona: TourPersona; readonly text: string }
  | { readonly kind: "tapButton"; readonly persona: TourPersona; readonly action: "ACCEPT_EMAIL" }
  /** "Avanzar al próximo evento" without a persona; "… hito de este reclamo" with one. */
  | { readonly kind: "advanceToNext"; readonly persona?: TourPersona }
  | { readonly kind: "setRunning" }
  | { readonly kind: "exportRegister" };

export type TourTarget =
  | { readonly view: "simulator" | "emails" | "metrics" | "approvals" | "register" | "clock" }
  | { readonly view: "customer"; readonly persona: TourPersona }
  | { readonly view: "complaint"; readonly persona: TourPersona };

export type TourMove =
  | { readonly kind: "run"; readonly label: Bilingual; readonly action: TourAction; readonly needsQuietWorld?: boolean }
  | { readonly kind: "open"; readonly label: Bilingual; readonly target: TourTarget };

/** Where the panel reads a fact of "Qué mirar"; every fact also has the value the replay proves. */
export type TourFactSource =
  | { readonly kind: "WORLD_START" }
  | { readonly kind: "WORLD_NOW" }
  | { readonly kind: "MAIN_STORY_NUMBER" }
  | { readonly kind: "MAIN_STORY_DEADLINE" }
  | { readonly kind: "TIMER"; readonly timer: "SETTLEMENT_PUBLISH"; readonly ownerKey: string }
  /** Computed by code from business days; the panel shows the expected value. */
  | { readonly kind: "EXPECTED" };

export interface TourFact {
  /** `day` → "jue 22/10"; `time` → "mié 07/10 10:10"; `text` → as is. */
  readonly format: "day" | "time" | "text";
  readonly expected: string;
  readonly source: TourFactSource;
}

export interface TourStep {
  readonly id: TourStepId;
  readonly block: TourBlock;
  readonly title: Bilingual;
  readonly moves: readonly TourMove[];
  readonly look: Bilingual;
  readonly facts: Readonly<Record<string, TourFact>>;
  readonly budgetSeconds: number;
  readonly optional?: boolean;
}

/** Where every guest world starts (template `guest`, docs/seed-spec.md). */
export const TOUR_START_SIM = "2026-10-07T10:10:00-03:00";
/** The main story: Valeria's complaint, the first one a guest files. */
export const MAIN_STORY = { persona: "C01", number: "R-2026-000123", deadlineSim: "2026-10-22T23:59:59-03:00" } as const;
/** The settlement the main story waits for. */
export const NORTE_PUBLISH = { ownerKey: "BATCH#NORTE#2026-10-07", dueAtSim: "2026-10-08T08:30:00-03:00" } as const;
/** The human case of step 9 and its milestones (business days from Thu 08/10, Mon 12/10 a holiday). */
export const HUMAN_CASE = {
  persona: "C07",
  filedSim: "2026-10-08T08:30:00-03:00",
  reminderSim: "2026-10-16T10:00:00-03:00",
  escalationSim: "2026-10-21T10:00:00-03:00",
  deadlineSim: "2026-10-23T23:59:59-03:00",
} as const;

/** The collection text the operator tries in step 8 (the collection lexicon blocks it). */
export const OPERATOR_COLLECTION_TEXT = "pagala hoy para evitar recargos";

/** The answer each persona gives to the identity challenge: the due date of its last instalment due. */
export const CHALLENGE_ANSWERS: Readonly<Record<Exclude<TourPersona, "C09">, string>> = { C01: "5/10", C02: "10/9", C03: "2/10", C07: "3/10" };

/** First names of the tour's personas, as the buttons and "Qué mirar" call them. */
export const PERSONA_NAMES: Readonly<Record<TourPersona, string>> = { C01: "Valeria", C02: "Diego", C03: "Rocío", C07: "Florencia", C09: "Martín" };

/** The phone's and the console's own words the tour quotes (one source: packages/bff/src/copy). */
const UI = {
  acceptEmail: BUTTON_TITLES.ACCEPT_EMAIL.INTERACTIVE ?? "",
  talkToSomeone: BUTTON_TITLES.TALK_TO_HUMAN.INTERACTIVE ?? "",
  overdueReminder: MESSAGE_KIND_LABEL.COLLECTION_REMINDER,
  formalEmail: REROUTE_LABEL.FORMAL_EMAIL,
  takeOver: CONSOLE_ES.BUTTON_TAKE_OVER,
  send: CONSOLE_ES.BUTTON_SEND,
  answer: CONSOLE_ES.BUTTON_ANSWER_IN_WRITING,
} as const;

const at = (expected: string, format: TourFact["format"], source: TourFactSource): TourFact => ({ format, expected, source });

function sendScript(persona: TourPersona, withReceipt = false): TourMove {
  const name = PERSONA_NAMES[persona];
  return withReceipt
    ? { kind: "run", label: { es: `Mandar mensaje y comprobante del guion (${name})`, en: `Send the script message and receipt (${name})` }, action: { kind: "sendScript", persona } }
    : { kind: "run", label: { es: `${CONSOLE_ES.BUTTON_SEND_SCRIPT} (${name})`, en: `${CONSOLE_EN.BUTTON_SEND_SCRIPT} (${name})` }, action: { kind: "sendScript", persona } };
}

function acceptEmail(persona: TourPersona): TourMove {
  return { kind: "run", label: { es: `Tocar “${UI.acceptEmail}” (${PERSONA_NAMES[persona]})`, en: `Tap “${UI.acceptEmail}” (${PERSONA_NAMES[persona]})` }, action: { kind: "tapButton", persona, action: "ACCEPT_EMAIL" } };
}

function answerChallenge(persona: Exclude<TourPersona, "C09">): TourMove {
  const text = CHALLENGE_ANSWERS[persona];
  return { kind: "run", label: { es: `Responder “${text}” al desafío`, en: `Answer “${text}” to the challenge` }, action: { kind: "sendText", persona, text } };
}

function open(target: TourTarget, es: string, en: string): TourMove {
  return { kind: "open", label: { es, en }, target };
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "1",
    block: "QUICK",
    title: { es: "Ingresar", en: "Sign in" },
    moves: [open({ view: "clock" }, "Ver el reloj de mi mundo", "See my world's clock")],
    look: { es: "Tu mundo propio, con el reloj en pausa el {start}.", en: "Your own world, with the clock paused on {start}." },
    facts: { start: at(TOUR_START_SIM, "time", { kind: "WORLD_START" }) },
    budgetSeconds: 10,
  },
  {
    id: "2",
    block: "QUICK",
    title: { es: "Reclamar", en: "File a complaint" },
    moves: [sendScript("C01", true), open({ view: "simulator" }, "Abrir el simulador", "Open the simulator")],
    look: {
      es: `Número {number} y plazo {deadline} en menos de 5 s, con la línea de asistente automatizado y los botones “${UI.acceptEmail}” · “${UI.talkToSomeone}”. El turno del agente sigue solo.`,
      en: `Number {number} and deadline {deadline} in under 5 s, with the automated-assistant line and the buttons “${UI.acceptEmail}” · “${UI.talkToSomeone}”. The agent's turn goes on by itself.`,
    },
    facts: { number: at(MAIN_STORY.number, "text", { kind: "MAIN_STORY_NUMBER" }), deadline: at(MAIN_STORY.deadlineSim, "day", { kind: "MAIN_STORY_DEADLINE" }) },
    budgetSeconds: 10,
  },
  {
    id: "2b",
    block: "QUICK",
    title: { es: "Cobranza bloqueada", en: "Collection blocked" },
    moves: [open({ view: "customer", persona: "C09" }, "Abrir la ficha de Martín (C09)", "Open Martín's file (C09)")],
    look: {
      es: `En el redactor, “${UI.overdueReminder}” por WhatsApp → ${UI.send}: la cinta lo marca en rojo BLOQUEADO · BLOCKED. Después “${UI.formalEmail}”: REROUTED → ALLOWED, con el reloj en {now}, dentro del horario del aviso formal.`,
      en: `In the composer, “${UI.overdueReminder}” by WhatsApp → ${UI.send}: the tape marks it in red BLOQUEADO · BLOCKED. Then “${UI.formalEmail}”: REROUTED → ALLOWED, with the clock at {now}, inside the formal-notice hours.`,
    },
    facts: { now: at(TOUR_START_SIM, "time", { kind: "WORLD_NOW" }) },
    budgetSeconds: 30,
  },
  {
    id: "3",
    block: "QUICK",
    title: { es: "Identificarse", en: "Verify identity" },
    moves: [acceptEmail("C01"), answerChallenge("C01"), open({ view: "emails" }, "Abrir Emails", "Open Emails")],
    look: {
      es: "En Emails, el aviso formal de Martín y el acuse de Valeria, reales, con PDF, eventos de SES y constancia DELIVERED. En el reclamo de Valeria, la lectura del comprobante y el lote pendiente: la red rinde el {publish}.",
      en: "In Emails, Martín's formal notice and Valeria's acknowledgement, real, with PDF, SES events and DELIVERED proof. In Valeria's complaint, the receipt reading and the pending batch: the network settles on {publish}.",
    },
    facts: { publish: at(NORTE_PUBLISH.dueAtSim, "time", { kind: "TIMER", timer: "SETTLEMENT_PUBLISH", ownerKey: NORTE_PUBLISH.ownerKey }) },
    budgetSeconds: 90,
  },
  {
    id: "4",
    block: "QUICK",
    title: { es: "Rendición", en: "Settlement" },
    moves: [{ kind: "run", label: { es: `${CONSOLE_ES.BUTTON_ADVANCE_NEXT_EVENT} (una vez)`, en: `${CONSOLE_EN.BUTTON_ADVANCE_NEXT_EVENT} (once)` }, action: { kind: "advanceToNext" }, needsQuietWorld: true }],
    look: {
      es: "El reloj llega al {publish}: rendición publicada, coincidencia con la línea del préstamo de Valeria, imputación, WhatsApp “ya figura” y respuesta escrita con constancia DELIVERED.",
      en: "The clock reaches {publish}: settlement published, match with the line of Valeria's loan, payment applied, a WhatsApp update and the written answer with DELIVERED proof.",
    },
    facts: { publish: at(NORTE_PUBLISH.dueAtSim, "time", { kind: "TIMER", timer: "SETTLEMENT_PUBLISH", ownerKey: NORTE_PUBLISH.ownerKey }) },
    budgetSeconds: 90,
  },
  {
    id: "5",
    block: "QUICK",
    title: { es: "Métricas", en: "Metrics" },
    moves: [open({ view: "metrics" }, "Abrir Métricas", "Open Metrics")],
    look: { es: "“Este mundo” con tus reclamos (medido) y el lote real (N = 30).", en: "“This world” with your complaints (measured) and the real batch (N = 30)." },
    facts: {},
    budgetSeconds: 20,
  },
  {
    id: "6",
    block: "DEEP",
    title: { es: "Cargo", en: "Wrong charge" },
    moves: [sendScript("C02"), acceptEmail("C02"), answerChallenge("C02")],
    look: { es: "Reversión del cargo con nota de crédito, y la respuesta escrita por email.", en: "Charge reversed with a credit note, and the written answer by email." },
    facts: {},
    budgetSeconds: 90,
  },
  {
    id: "7",
    block: "DEEP",
    title: { es: "Aprobación", en: "Approval" },
    moves: [sendScript("C03"), acceptEmail("C03"), answerChallenge("C03"), open({ view: "approvals" }, "Abrir Aprobaciones", "Open Approvals")],
    look: {
      es: "El agente pidió aprobación: el reintegro está por encima de su tope. Al aprobar, el código ejecuta el reintegro una sola vez. Si pasaron más de 15 minutos desde tu ingreso, se abre el pedido de contraseña: aprobar dinero exige un login reciente; es una función, no un error.",
      en: "The agent asked for approval: the refund is above its cap. On approval, the code executes the refund exactly once. If more than 15 minutes passed since you signed in, the password prompt opens: approving money requires a recent sign-in; it is a feature, not an error.",
    },
    facts: {},
    budgetSeconds: 120,
  },
  {
    id: "8",
    block: "DEEP",
    title: { es: "El operador también", en: "The operator too" },
    moves: [open({ view: "customer", persona: "C09" }, "Abrir la ficha de Martín (C09)", "Open Martín's file (C09)")],
    look: {
      es: `“${UI.takeOver}”, escribir “${OPERATOR_COLLECTION_TEXT}” y ${UI.send}: queda bloqueado por el léxico de cobranza, con las categorías en la cinta.`,
      en: `“${UI.takeOver}”, write “${OPERATOR_COLLECTION_TEXT}” and ${UI.send}: it is blocked by the collection lexicon, with its categories on the tape.`,
    },
    facts: {},
    budgetSeconds: 20,
  },
  {
    id: "9",
    block: "DEEP",
    title: { es: "Plazo", en: "Deadline" },
    moves: [
      sendScript("C07", true),
      acceptEmail("C07"),
      answerChallenge("C07"),
      { kind: "run", label: { es: `${CONSOLE_ES.BUTTON_ADVANCE_COMPLAINT_MILESTONE} (recordatorio)`, en: `${CONSOLE_EN.BUTTON_ADVANCE_COMPLAINT_MILESTONE} (reminder)` }, action: { kind: "advanceToNext", persona: "C07" }, needsQuietWorld: true },
      { kind: "run", label: { es: `${CONSOLE_ES.BUTTON_ADVANCE_COMPLAINT_MILESTONE} (escalamiento)`, en: `${CONSOLE_EN.BUTTON_ADVANCE_COMPLAINT_MILESTONE} (escalation)` }, action: { kind: "advanceToNext", persona: "C07" }, needsQuietWorld: true },
      open({ view: "complaint", persona: "C07" }, `Abrir el reclamo y “${UI.answer}”`, `Open the complaint and “${UI.answer}”`),
    ],
    look: {
      es: "Caso humano registrado el {filed} con vencimiento el {deadline}; recordatorio del {reminder} y escalamiento al supervisor del {escalation} (en riesgo). Al responder por escrito, los hitos que quedan se cancelan.",
      en: "Human case filed on {filed}, due on {deadline}; reminder on {reminder} and escalation to the supervisor on {escalation} (at risk). Once answered in writing, the remaining milestones are cancelled.",
    },
    facts: {
      filed: at(HUMAN_CASE.filedSim, "day", { kind: "EXPECTED" }),
      deadline: at(HUMAN_CASE.deadlineSim, "day", { kind: "EXPECTED" }),
      reminder: at(HUMAN_CASE.reminderSim, "time", { kind: "EXPECTED" }),
      escalation: at(HUMAN_CASE.escalationSim, "time", { kind: "EXPECTED" }),
    },
    budgetSeconds: 180,
  },
  {
    id: "10",
    block: "DEEP",
    title: { es: "Registro", en: "Register" },
    moves: [{ kind: "run", label: { es: `${CONSOLE_ES.BUTTON_EXPORT} el registro`, en: `${CONSOLE_EN.BUTTON_EXPORT} the register` }, action: { kind: "exportRegister" } }, open({ view: "register" }, "Abrir el Registro", "Open the Register")],
    look: { es: "Cadena de hash y anclas verificadas.", en: "Hash chain and anchors verified." },
    facts: {},
    budgetSeconds: 10,
  },
  {
    id: "11",
    block: "DEEP",
    title: { es: "Reloj en vivo (opcional)", en: "Live clock (optional)" },
    moves: [{ kind: "run", label: { es: CONSOLE_ES.BUTTON_LIVE_CLOCK, en: CONSOLE_EN.BUTTON_LIVE_CLOCK }, action: { kind: "setRunning" }, needsQuietWorld: true }, open({ view: "clock" }, "Abrir el Reloj", "Open the Clock")],
    look: { es: "Schedules reales del Scheduler disparando los hitos; el reloj vuelve solo a pausa a los 30 minutos.", en: "Real Scheduler schedules firing the milestones; the clock pauses by itself after 30 minutes." },
    facts: {},
    budgetSeconds: 120,
    optional: true,
  },
  {
    id: "12",
    block: "DEEP",
    title: { es: "Métricas", en: "Metrics" },
    moves: [open({ view: "metrics" }, "Abrir Métricas", "Open Metrics")],
    look: { es: "Cada KPI con su N, su fuente y su rótulo.", en: "Every KPI with its N, its source and its label." },
    facts: {},
    budgetSeconds: 0,
  },
];

export const TOUR_BLOCKS: Readonly<Record<TourBlock, Bilingual & { readonly budgetSeconds: number }>> = {
  QUICK: { es: "Recorrido de 5 minutos", en: "5-minute tour", budgetSeconds: 300 },
  DEEP: { es: "Recorrido profundo de 15 minutos", en: "Deep tour (15 minutes)", budgetSeconds: 900 },
};

const PLACEHOLDER = /\{([a-z][a-zA-Z]*)\}/g;

/** Placeholder names of a text of "Qué mirar", in order of appearance. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

const AR_OFFSET_MS = -3 * 60 * 60_000;
const WEEKDAYS: Readonly<Record<TourLang, readonly string[]>> = {
  es: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");

/** An instant in Argentina time (UTC−3 all year): "mié 07/10 10:10" / "Wed Oct 7 10:10"; `day` drops the hour. */
export function formatTourInstant(instant: string, lang: TourLang, format: "day" | "time"): string {
  const local = new Date(Date.parse(instant) + AR_OFFSET_MS);
  const weekday = WEEKDAYS[lang][local.getUTCDay()] ?? "";
  const hour = format === "time" ? ` ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}` : "";
  if (lang === "es") return `${weekday} ${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}${hour}`;
  return `${weekday} ${MONTHS_EN[local.getUTCMonth()] ?? ""} ${local.getUTCDate()}${hour}`;
}

export function formatFact(fact: TourFact, value: string, lang: TourLang): string {
  return fact.format === "text" ? value : formatTourInstant(value, lang, fact.format);
}

/** "Qué mirar" with each fact filled from `values` (by name) or its expected value. */
export function lookText(step: TourStep, lang: TourLang, values: Readonly<Record<string, string | undefined>> = {}): string {
  return step.look[lang].replace(PLACEHOLDER, (whole, name: string) => {
    const fact = step.facts[name];
    return fact === undefined ? whole : formatFact(fact, values[name] ?? fact.expected, lang);
  });
}

/** A step's budget as the panel and the README show it: "~10 s", "~1,5 min" / "~1.5 min", "—" for none. */
export function formatBudget(seconds: number, lang: TourLang): string {
  if (seconds <= 0) return "—";
  if (seconds < 60) return `~${seconds} s`;
  const minutes = String(Math.round((seconds / 60) * 10) / 10);
  return `~${lang === "es" ? minutes.replace(".", ",") : minutes} min`;
}

export function stepById(id: TourStepId): TourStep {
  const step = TOUR_STEPS.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`no tour step ${id}`);
  return step;
}
