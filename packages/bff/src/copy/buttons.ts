// WhatsApp button titles, one per action and per form (docs/architecture-integrations.md §3.3).
// The derivation to a person is in every message of the agent and of the system inside the window:
// "Hablar con alguien" fits an interactive reply button (Meta's cap is 20 characters); templates
// and list rows keep "Hablar con una persona" (22). The right is the same (CONTEXT.md, "Agente").
// Row titles of the loan list are built from the loan label by the WhatsApp adapter.
import type { WaButtonAction } from "@reclamo/shared";
import { BUTTON_GLOSS } from "./en-gloss";
import type { ButtonForm, Glossed } from "./types";

export const BUTTON_TITLES: Readonly<Record<WaButtonAction, Partial<Record<ButtonForm, string>>>> = {
  TALK_TO_HUMAN: { INTERACTIVE: "Hablar con alguien", LIST_ROW: "Hablar con una persona", QUICK_REPLY: "Hablar con una persona" },
  ACCEPT_EMAIL: { INTERACTIVE: "Sí, a ese email" },
  DECLINE_EMAIL: { INTERACTIVE: "Prefiero otro medio" },
  CHOOSE_LOAN: { LIST_MENU: "Elegir préstamo" },
  OPT_OUT: { INTERACTIVE: "No recibir mensajes" },
  CONFIRM_CLOSURE: { INTERACTIVE: "Baja de mi cuenta" },
  WITHDRAW: { INTERACTIVE: "Desistir del reclamo" },
  SEE_DETAIL: { QUICK_REPLY: "Ver detalle" },
  HAVE_A_QUESTION: { QUICK_REPLY: "Tengo una duda" },
};

export class ButtonFormError extends Error {
  override readonly name = "ButtonFormError";

  constructor(
    readonly action: WaButtonAction,
    readonly form: ButtonForm,
  ) {
    super(`${action} has no ${form} title`);
  }
}

/** Title of `action` rendered as `form`; throws when that action is never rendered that way. */
export function buttonTitle(action: WaButtonAction, form: ButtonForm): string {
  const title = BUTTON_TITLES[action][form];
  if (title === undefined) throw new ButtonFormError(action, form);
  return title;
}

export function buttonGloss(action: WaButtonAction, form: ButtonForm): Glossed {
  const en = BUTTON_GLOSS[action][form];
  if (en === undefined) throw new ButtonFormError(action, form);
  return { es: buttonTitle(action, form), en };
}
