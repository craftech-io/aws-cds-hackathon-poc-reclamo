// The four WhatsApp `UTILITY` templates (`es_AR`) of docs/architecture-integrations.md §3.3, the
// only messages that may go out of the 24-hour window. Same text in `Reference/TEMPLATE#WHATSAPP`
// (loaded by the seed) and in the registration with Meta (scripts/channels/whatsapp-templates.ts).
// No template starts or ends with a parameter, none talks about payments, debts or offers (that
// would be collection or marketing), and every `quick_reply` title comes from buttons.ts.
import type { WaButtonAction } from "@reclamo/shared";
import { buttonTitle } from "./buttons";
import { CopyParamError } from "./helpers";
import { statusPhrase, TEMPLATE_STATUS_PHRASES } from "./template-status";
import type { TemplateName, TemplateParamKind } from "./types";

export interface WhatsAppTemplate {
  readonly name: TemplateName;
  readonly category: "UTILITY";
  readonly language: "es_AR";
  /** Body with Meta's positional placeholders `{{1}}`, `{{2}}`, … */
  readonly body: string;
  /** What `{{n}}` carries, in order. */
  readonly params: readonly TemplateParamKind[];
  /** `quick_reply` buttons, in order; the payload of each is a nonce. */
  readonly buttons: readonly WaButtonAction[];
  /** Sample values Meta asks for when the template is registered. */
  readonly examples: readonly string[];
}

export const WHATSAPP_TEMPLATES: Readonly<Record<TemplateName, WhatsAppTemplate>> = {
  reclamo_novedad: {
    name: "reclamo_novedad",
    category: "UTILITY",
    language: "es_AR",
    body: "Hola {{1}}, hay una novedad en tu reclamo {{2}}: {{3}}. Podés responder por acá.",
    params: ["FIRST_NAME", "COMPLAINT_NUMBER", "STATUS_PHRASE"],
    buttons: ["SEE_DETAIL", "TALK_TO_HUMAN"],
    examples: ["Valeria", "R-2026-000123", TEMPLATE_STATUS_PHRASES.SETTLEMENT_PUBLISHED],
  },
  reclamo_resuelto: {
    name: "reclamo_resuelto",
    category: "UTILITY",
    language: "es_AR",
    body: "Tu reclamo {{1}} fue resuelto. Te mandamos la respuesta escrita por email a {{2}}.",
    params: ["COMPLAINT_NUMBER", "EMAIL_MASKED"],
    buttons: ["HAVE_A_QUESTION", "TALK_TO_HUMAN"],
    examples: ["R-2026-000123", "v•••@…"],
  },
  reclamo_derivado: {
    name: "reclamo_derivado",
    category: "UTILITY",
    language: "es_AR",
    body: "Tu reclamo {{1}} lo sigue una persona del equipo de atención. El plazo de respuesta vence el {{2}}.",
    params: ["COMPLAINT_NUMBER", "DEADLINE_TEXT"],
    buttons: [],
    examples: ["R-2026-000123", "jueves 22/10"],
  },
  reclamo_respuesta_no_entregada: {
    name: "reclamo_respuesta_no_entregada",
    category: "UTILITY",
    language: "es_AR",
    body: "No pudimos entregar la respuesta escrita de tu reclamo {{1}} en tu email. Una persona se va a contactar por este medio.",
    params: ["COMPLAINT_NUMBER"],
    buttons: ["TALK_TO_HUMAN"],
    examples: ["R-2026-000123"],
  },
};

/** Titles of the `quick_reply` buttons of a template, in order. */
export function templateButtonTitles(name: TemplateName): string[] {
  return WHATSAPP_TEMPLATES[name].buttons.map((action) => buttonTitle(action, "QUICK_REPLY"));
}

export class TemplateParamNotAllowedError extends Error {
  override readonly name = "TemplateParamNotAllowedError";
  readonly code = "TEMPLATE_PARAM_NOT_ALLOWED";

  constructor(
    readonly template: TemplateName,
    readonly position: number,
  ) {
    super(`${template} {{${position}}} is outside the closed list of status phrases`);
  }
}

// Meta refuses a parameter with a new line, a tab or more than four consecutive spaces.
const PARAM_FORBIDDEN = /[\n\r\t]| {5,}/;

/**
 * The body parameters of a template, validated: one value per parameter, never empty, no line
 * breaks or tabs, and `STATUS_PHRASE` given as a phrase id of template-status.ts (rendered here).
 * An id outside the closed list throws `TEMPLATE_PARAM_NOT_ALLOWED`.
 */
export function templateParameters(name: TemplateName, values: readonly string[]): string[] {
  const template = WHATSAPP_TEMPLATES[name];
  if (values.length !== template.params.length) throw new CopyParamError(values.length < template.params.length ? "MISSING_PARAM" : "UNUSED_PARAM", `${name}:${values.length}`);
  return template.params.map((kind, index) => {
    const raw = values[index] ?? "";
    const value = kind === "STATUS_PHRASE" ? statusPhrase(raw) : raw;
    if (value === undefined) throw new TemplateParamNotAllowedError(name, index + 1);
    if (value.trim() === "" || PARAM_FORBIDDEN.test(value)) throw new CopyParamError("INVALID_VALUE", `${name}:{{${index + 1}}}`);
    return value;
  });
}

/** The body as the customer reads it (the simulated transport and the tape hash). */
export function renderTemplateBody(name: TemplateName, values: readonly string[]): string {
  const params = templateParameters(name, values);
  return WHATSAPP_TEMPLATES[name].body.replace(/\{\{(\d+)\}\}/g, (_, position: string) => params[Number(position) - 1] ?? "");
}
