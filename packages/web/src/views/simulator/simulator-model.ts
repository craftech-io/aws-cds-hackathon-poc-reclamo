// The phone simulator's rules, without React: the English gloss of what the phone shows (every fixed
// text, consent question and template of packages/bff/src/copy matched line by line; the agent's free
// text has none), the next message of a persona's script, the checks of an image before its presigned
// upload (JPG or PNG, 1 byte to 3.75 MB, the BFF's own limits), the ticks of an outbound message and the
// filter of the persona list.
import { IMAGE_CONTENT_TYPES, type ImageContentType, MAX_MEDIA_BYTES } from "@reclamo/bff/channels/whatsapp/config";
import { BUTTON_TITLES } from "@reclamo/bff/copy/buttons";
import { CURRENT_EMAIL_CONSENT } from "@reclamo/bff/copy/consent";
import { BUTTON_GLOSS, COMPLAINT_TYPE_GLOSS, CONSENT_GLOSS, STATUS_PHRASE_GLOSS, TEMPLATE_GLOSS, WHATSAPP_GLOSS } from "@reclamo/bff/copy/en-gloss";
import { COMPLAINT_TYPE_LABEL, WHATSAPP_TEXT, type WhatsAppTextKey } from "@reclamo/bff/copy/es-AR";
import { TEMPLATE_STATUS_PHRASES } from "@reclamo/bff/copy/template-status";
import { WHATSAPP_TEMPLATES } from "@reclamo/bff/copy/templates";
import type { SimMessage, SimPersona } from "./simulator-api";

interface FixedText {
  readonly pattern: RegExp;
  readonly names: readonly string[];
  readonly en: string;
}

const PLACEHOLDER = /\\\{\\\{([A-Za-z0-9]+)\\\}\\\}/g;

function compile(es: string, en: string): FixedText {
  const escaped = es.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names: string[] = [];
  const source = escaped.replace(PLACEHOLDER, (_match, name: string) => {
    names.push(name);
    return "(.+?)";
  });
  return { pattern: new RegExp(`^${source}$`), names, en };
}

const FIXED_TEXTS: readonly FixedText[] = [
  ...(Object.keys(WHATSAPP_TEXT) as WhatsAppTextKey[]).map((key) => compile(WHATSAPP_TEXT[key], WHATSAPP_GLOSS[key])),
  compile(CURRENT_EMAIL_CONSENT.question, CONSENT_GLOSS["email-answer-v1"]),
  ...Object.values(WHATSAPP_TEMPLATES).map((template) => compile(template.body, TEMPLATE_GLOSS[template.name])),
];

const TYPE_GLOSS: ReadonlyMap<string, string> = new Map(Object.entries(COMPLAINT_TYPE_LABEL).map(([type, label]) => [label, COMPLAINT_TYPE_GLOSS[type as keyof typeof COMPLAINT_TYPE_GLOSS]]));
const PHRASE_GLOSS: ReadonlyMap<string, string> = new Map(Object.entries(TEMPLATE_STATUS_PHRASES).map(([id, phrase]) => [phrase, STATUS_PHRASE_GLOSS[id as keyof typeof STATUS_PHRASE_GLOSS]]));

/** A value inside a fixed text, in English when it is a fixed label too ("pago no reflejado"). */
function glossValue(value: string): string {
  return TYPE_GLOSS.get(value) ?? PHRASE_GLOSS.get(value) ?? value;
}

/** The gloss of one line of a message, or `undefined` for free text. */
export function glossLine(line: string): string | undefined {
  for (const fixed of FIXED_TEXTS) {
    const match = fixed.pattern.exec(line);
    if (match === null) continue;
    const values = new Map(fixed.names.map((name, index) => [name, glossValue(match[index + 1] ?? "")]));
    return fixed.en.replace(/\{\{([A-Za-z0-9]+)\}\}/g, (whole, name: string) => values.get(name) ?? whole);
  }
  return undefined;
}

export interface Gloss {
  /** One entry per line of the message: its gloss, or `undefined` for the agent's free text. */
  readonly lines: readonly (string | undefined)[];
  readonly buttons: readonly string[];
}

/** The English of a message: fixed lines and button titles glossed, an inbound script line by its script. */
export function glossOf(message: Pick<SimMessage, "body" | "direction" | "buttons">, scriptGloss: ReadonlyMap<string, string> = new Map()): Gloss {
  const body = message.body ?? "";
  if (message.direction === "IN") return { lines: body === "" ? [] : [scriptGloss.get(body)], buttons: [] };
  const lines = body === "" ? [] : body.split("\n").map(glossLine);
  return { lines, buttons: message.buttons.map((button) => buttonGlossOf(button.action, button.title)) };
}

/** The English of a button title, from the form whose Spanish title it is. */
export function buttonGlossOf(action: string, title: string): string {
  const titles = BUTTON_TITLES[action as keyof typeof BUTTON_TITLES] as Readonly<Record<string, string | undefined>> | undefined;
  const glosses = BUTTON_GLOSS[action as keyof typeof BUTTON_GLOSS] as Readonly<Record<string, string | undefined>> | undefined;
  const form = Object.entries(titles ?? {}).find(([, candidate]) => candidate === title)?.[0];
  return (form === undefined ? undefined : glosses?.[form]) ?? title;
}

/** Spanish script text → its English, for every message of every persona. */
export function scriptGlossOf(personas: readonly SimPersona[], unlinked: { readonly text: string; readonly en: string }): ReadonlyMap<string, string> {
  return new Map([...personas.flatMap((persona) => persona.script.map((line) => [line.text, line.en] as const)), [unlinked.text, unlinked.en] as const]);
}

/** Index of the first script message the persona has not sent yet; undefined when all were sent. */
export function nextScriptIndex(persona: Pick<SimPersona, "script">, messages: readonly Pick<SimMessage, "direction" | "body">[]): number | undefined {
  const sent = new Set(messages.filter((message) => message.direction === "IN").map((message) => message.body));
  const index = persona.script.findIndex((line) => !sent.has(line.text));
  return index === -1 ? undefined : index;
}

export type ImageProblem = "EMPTY" | "TOO_LARGE" | "UNSUPPORTED";

/** Why an image cannot be uploaded (the presigned POST would refuse it), or `undefined`. */
export function imageProblem(file: { readonly size: number; readonly type: string }): ImageProblem | undefined {
  if (!(IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type)) return "UNSUPPORTED";
  if (file.size <= 0) return "EMPTY";
  if (file.size > MAX_MEDIA_BYTES) return "TOO_LARGE";
  return undefined;
}

export function imageType(file: { readonly type: string }): ImageContentType | undefined {
  return (IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type) ? (file.type as ImageContentType) : undefined;
}

/**
 * The thread in the order the phone shows it. With the clock paused every message shares its simulated
 * minute: then the real instant it was stored decides; without it, the order in which this page first
 * saw each message (`firstSeen`); and among messages first seen together, the persona's own come before
 * the answers they caused.
 */
export function chronological(messages: readonly SimMessage[], firstSeen: ReadonlyMap<string, number> = new Map()): SimMessage[] {
  return [...messages].sort((a, b) => {
    const bySim = Date.parse(a.atSim) - Date.parse(b.atSim);
    if (bySim !== 0) return bySim;
    if (a.createdAt !== undefined && b.createdAt !== undefined && a.createdAt !== b.createdAt) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    const seen = (firstSeen.get(a.messageId) ?? Number.MAX_SAFE_INTEGER) - (firstSeen.get(b.messageId) ?? Number.MAX_SAFE_INTEGER);
    if (seen !== 0) return seen;
    if (a.direction !== b.direction) return a.direction === "IN" ? -1 : 1;
    return a.messageId.localeCompare(b.messageId);
  });
}

/** Gives every message not seen before the next arrival number (the messages of one answer share it). */
export function noteArrivals(firstSeen: Map<string, number>, messages: readonly Pick<SimMessage, "messageId">[]): void {
  const batch = firstSeen.size === 0 ? 0 : Math.max(...firstSeen.values()) + 1;
  for (const message of messages) if (!firstSeen.has(message.messageId)) firstSeen.set(message.messageId, batch);
}

export interface Ticks {
  readonly symbol: string;
  readonly read: boolean;
}

/** WhatsApp's ticks of an outbound message: ✓ sent, ✓✓ delivered, blue ✓✓ read, ! failed. */
export function ticksOf(message: Pick<SimMessage, "direction" | "status">): Ticks | undefined {
  if (message.direction !== "OUT") return undefined;
  if (message.status === "SENT" || message.status === "PENDING") return { symbol: "✓", read: false };
  if (message.status === "DELIVERED") return { symbol: "✓✓", read: false };
  if (message.status === "READ") return { symbol: "✓✓", read: true };
  if (message.status === "FAILED" || message.status === "UNKNOWN_DELIVERY") return { symbol: "!", read: false };
  return undefined;
}

/** Personas whose id, name or scenario (in Spanish or English) contains the query, accents ignored. */
export function filterPersonas(personas: readonly SimPersona[], query: string): readonly SimPersona[] {
  const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const wanted = fold(query.trim());
  if (wanted === "") return personas;
  return personas.filter((persona) => [persona.persona, persona.name, persona.scenario, persona.scenarioEn].some((text) => fold(text).includes(wanted)));
}
