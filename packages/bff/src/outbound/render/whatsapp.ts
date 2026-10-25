// Step 2 of the gate for WhatsApp (docs/architecture-integrations.md §3.3, §4): what the customer will
// read and tap, before the nonces exist.
//
//   template   one of the four `UTILITY` templates, its parameters validated by copy/templates.ts
//              (`{{3}}` of `reclamo_novedad` a phrase id of the closed list) and its own `quick_reply`
//              buttons, each bound to the complaint
//   text       the sender's text (the disclosure line first when it is the first outbound of the
//              conversation and epoch), with the buttons asked for and, for the agent and the system,
//              "Hablar con alguien" added by code; `CHOOSE_LOAN` makes a list whose rows are the
//              customer's loans as the core names them (never a label the caller wrote)
//
// Titles come from copy/buttons.ts by form; a shape Meta would refuse (four buttons, a title that
// does not exist in that form, a body over the limit, a loan the customer does not have) throws
// `ToolError INVALID` here, before anything is written.
import { type WaButtonAction, ToolError } from "@reclamo/shared";
import { ButtonFormError, WHATSAPP_TEMPLATES, buttonTitle, charCount, renderTemplateBody } from "../../copy";
import type { TemplateName } from "../../copy/types";
import type { SenderClass } from "../../channel-policy/kinds";
import { INTERACTIVE_BODY_MAX_CHARS, MAX_LIST_ROWS, MAX_REPLY_BUTTONS, TEXT_BODY_MAX_CHARS, type WaOutbound } from "../../channels/whatsapp/meta-message";
import type { ButtonToIssue } from "../../channels/whatsapp/nonces";
import { GATE_REASON, type OutboundRequest } from "../types";
import { withDisclosure } from "./disclosure";

const LIST_ROW_TITLE_MAX = 24;

export interface WhatsAppRenderInput {
  readonly request: Pick<OutboundRequest, "text" | "template" | "buttons" | "complaintId">;
  readonly senderClass: SenderClass;
  readonly disclose: boolean;
  /** The customer's loans as the core shows them (the rows of a `CHOOSE_LOAN` list). */
  readonly loans: readonly { readonly loanId: string; readonly label: string }[];
}

interface Titled extends ButtonToIssue {
  readonly title: string;
}

export type WhatsAppDraft =
  | { readonly shape: "template"; readonly name: TemplateName; readonly values: readonly string[]; readonly buttons: readonly ButtonToIssue[]; readonly text: string; readonly disclosure: false }
  | { readonly shape: "text"; readonly text: string; readonly buttons: readonly []; readonly disclosure: boolean }
  | { readonly shape: "buttons"; readonly text: string; readonly buttons: readonly Titled[]; readonly disclosure: boolean }
  | { readonly shape: "list"; readonly text: string; readonly menu: string; readonly buttons: readonly Titled[]; readonly disclosure: boolean };

function invalid(message: string): ToolError {
  return new ToolError("INVALID", message, GATE_REASON.CONTENT_INVALID);
}

function titleOf(action: WaButtonAction, form: "INTERACTIVE" | "LIST_ROW"): string {
  try {
    return buttonTitle(action, form);
  } catch (error) {
    if (error instanceof ButtonFormError) throw invalid(`${action} is never an ${form === "INTERACTIVE" ? "interactive reply button" : "list row"}`);
    throw error;
  }
}

function clip(text: string, max: number): string {
  const chars = [...text.normalize("NFC")];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function renderTemplate(request: WhatsAppRenderInput["request"], name: TemplateName, params: readonly string[]): WhatsAppDraft {
  if ((request.buttons?.length ?? 0) > 0) throw invalid("a template carries its own buttons");
  const buttons = WHATSAPP_TEMPLATES[name].buttons.map((action) => ({ action, ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }) }));
  return { shape: "template", name, values: [...params], buttons, text: renderTemplateBody(name, params), disclosure: false };
}

/** The buttons asked for, plus "Hablar con alguien" for the agent and the system (once, last). */
function askedButtons(input: WhatsAppRenderInput): ButtonToIssue[] {
  const ref = input.request.complaintId === undefined ? {} : { complaintId: input.request.complaintId };
  const buttons: ButtonToIssue[] = (input.request.buttons ?? []).map((button) =>
    button.action === "CHOOSE_LOAN" ? { action: button.action, ...(button.ref === undefined ? {} : { loanId: button.ref }) } : { action: button.action, ...(button.ref === undefined ? ref : { complaintId: button.ref }) },
  );
  const human = buttons.some((button) => button.action === "TALK_TO_HUMAN");
  if (!human && input.senderClass !== "OPERATOR") buttons.push({ action: "TALK_TO_HUMAN", ...ref });
  return buttons;
}

function renderList(body: string, buttons: readonly ButtonToIssue[], loans: WhatsAppRenderInput["loans"], disclosure: boolean): WhatsAppDraft {
  const rows: Titled[] = buttons.map((button) => {
    if (button.action !== "CHOOSE_LOAN") return { ...button, title: titleOf(button.action, "LIST_ROW") };
    const loan = loans.find((candidate) => candidate.loanId === button.loanId);
    if (loan === undefined) throw invalid("a loan row names a loan the customer does not have");
    return { ...button, title: clip(loan.label, LIST_ROW_TITLE_MAX) };
  });
  if (rows.length > MAX_LIST_ROWS) throw invalid(`a list has at most ${MAX_LIST_ROWS} rows`);
  if (charCount(body) > INTERACTIVE_BODY_MAX_CHARS) throw invalid(`a message with buttons has at most ${INTERACTIVE_BODY_MAX_CHARS} characters`);
  return { shape: "list", text: body, menu: buttonTitle("CHOOSE_LOAN", "LIST_MENU"), buttons: rows, disclosure };
}

/** What the customer reads and taps (nonces are issued afterwards, with the message). */
export function renderWhatsApp(input: WhatsAppRenderInput): WhatsAppDraft {
  const { request } = input;
  if (request.template !== undefined) {
    if (request.text !== undefined && request.text.trim() !== "") throw invalid("a message is a text or a template, not both");
    return renderTemplate(request, request.template.name, request.template.params);
  }
  const text = request.text?.trim() ?? "";
  if (text === "") throw invalid("a WhatsApp message needs a text or a template");
  const body = input.disclose ? withDisclosure(text) : text;
  const buttons = askedButtons(input);
  if (buttons.some((button) => button.action === "CHOOSE_LOAN")) return renderList(body, buttons, input.loans, input.disclose);
  if (buttons.length === 0) {
    if (charCount(body) > TEXT_BODY_MAX_CHARS) throw invalid(`a text has at most ${TEXT_BODY_MAX_CHARS} characters`);
    return { shape: "text", text: body, buttons: [], disclosure: input.disclose };
  }
  if (buttons.length > MAX_REPLY_BUTTONS) throw invalid(`a message has at most ${MAX_REPLY_BUTTONS} reply buttons, "Hablar con alguien" included`);
  if (charCount(body) > INTERACTIVE_BODY_MAX_CHARS) throw invalid(`a message with buttons has at most ${INTERACTIVE_BODY_MAX_CHARS} characters`);
  return { shape: "buttons", text: body, buttons: buttons.map((button) => ({ ...button, title: titleOf(button.action, "INTERACTIVE") })), disclosure: input.disclose };
}

/** The transport's message, once the nonces of the draft's buttons exist (one per button, in order). */
export function toWaOutbound(draft: WhatsAppDraft, nonces: readonly string[]): WaOutbound {
  if (nonces.length !== draft.buttons.length) throw new RangeError(`the draft has ${draft.buttons.length} buttons, got ${nonces.length} nonces`);
  switch (draft.shape) {
    case "template":
      return { kind: "template", name: draft.name, values: draft.values, nonces };
    case "text":
      return { kind: "text", body: draft.text };
    case "buttons":
      return { kind: "buttons", body: draft.text, buttons: draft.buttons.map((button, index) => ({ id: nonces[index] ?? "", title: button.title })) };
    case "list":
      return { kind: "list", body: draft.text, buttonTitle: draft.menu, rows: draft.buttons.map((button, index) => ({ id: nonces[index] ?? "", title: button.title })) };
  }
}
