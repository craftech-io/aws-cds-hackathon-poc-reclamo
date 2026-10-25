// The WhatsApp 24-hour window (`CH-WA-24H`, CONTEXT.md "Ventana de 24 h") and the notion of a reply
// the rest of the policy shares (docs/design-brief.md §7):
//
//   - Only a WhatsApp message of the customer opens the window (a text, a button reply or an image).
//   - The window is measured on the world's clock while WhatsApp is `simulated` and on real time when
//     it is `live`, because Meta measures real time (ADR-0002).
//   - A send is a reply when it answers one message of the customer (named by `answers`, or the last
//     one when the send comes from a turn that message opened, or is a kind that only exists inside a
//     conversation) and goes out inside the window that message opened. A reply needs no opt-in
//     (`CH-OPTIN`), no open complaint (`CH-WA-CUSTOMER-INITIATED`) and is exempt from the contact hours
//     and the daily cap. Everything else by WhatsApp is a proactive contact.
//   - Outside the window only an approved `UTILITY` template goes out, with its parameters validated
//     (`{{3}}` of `reclamo_novedad` only from the closed list of status phrases).
import { CopyParamError } from "../copy/helpers";
import { TemplateParamNotAllowedError, templateParameters } from "../copy/templates";
import { block, missing, pass, skip, toArIso } from "./checks";
import type { PolicyContext, TimeBase, WindowView } from "./context";
import { ANSWER_KINDS, REPLY_TRIGGERS } from "./kinds";
import type { HistoryMessage, RuleCheck, WindowState } from "./types";

export const WINDOW_MS = 24 * 3_600_000;

function instantOf(entry: HistoryMessage, base: TimeBase): number | undefined {
  if (base === "SIM") return Date.parse(entry.atSim);
  return entry.atReal === undefined ? undefined : Date.parse(entry.atReal);
}

function nowOf(view: WindowView): number {
  return (view.windowBase === "REAL" ? view.realNow : view.simNow).getTime();
}

function formatInstant(ms: number, base: TimeBase): string {
  return base === "REAL" ? new Date(ms).toISOString() : toArIso(new Date(ms));
}

interface Inbound {
  readonly entry: HistoryMessage;
  readonly at: number;
}

/** WhatsApp messages of the customer received at or before the instant, oldest first. */
function customerInbound(view: WindowView): Inbound[] {
  const now = nowOf(view);
  const inbound: Inbound[] = [];
  for (const entry of view.history ?? []) {
    if (entry.direction !== "IN" || entry.channel !== "WHATSAPP") continue;
    const at = instantOf(entry, view.windowBase);
    if (at !== undefined && at <= now) inbound.push({ entry, at });
  }
  return inbound.sort((a, b) => a.at - b.at);
}

/** The window at the instant: open while less than 24 hours passed since the customer's last message. */
export function windowAt(view: WindowView): WindowState {
  const last = customerInbound(view).at(-1);
  if (last === undefined) return { state: "CLOSED" };
  const closesAt = last.at + WINDOW_MS;
  return { state: nowOf(view) < closesAt ? "OPEN" : "CLOSED", lastInboundAt: formatInstant(last.at, view.windowBase), closesAt: formatInstant(closesAt, view.windowBase) };
}

/** Whether the request presents itself as an answer to the customer. */
function answersTheCustomer(view: WindowView): boolean {
  const { answers, trigger, kind, template } = view.request;
  if (answers !== undefined) return true;
  if (trigger !== undefined && REPLY_TRIGGERS.includes(trigger)) return true;
  return template === undefined && ANSWER_KINDS.has(kind);
}

/** Whether the send is a reply; `undefined` when it claims to answer but there is no history to check. */
export function replyOf(view: WindowView): boolean | undefined {
  if (!view.byWhatsApp || !answersTheCustomer(view)) return false;
  if (view.history === undefined) return undefined;
  const inbound = customerInbound(view);
  const { answers } = view.request;
  const answered = answers === undefined ? inbound.at(-1) : inbound.find((item) => item.entry.messageId === answers);
  return answered !== undefined && nowOf(view) - answered.at < WINDOW_MS;
}

/** The template's parameters, validated by copy/templates.ts; the block when they are not valid. */
function checkTemplate(ctx: PolicyContext): RuleCheck | undefined {
  const { template } = ctx.request;
  if (template === undefined || ctx.mode === "AS_OF") return undefined;
  try {
    templateParameters(template.name, template.params);
    return undefined;
  } catch (error) {
    if (error instanceof TemplateParamNotAllowedError) return block(`${template.name} {{${error.position}}} is outside the closed list of status phrases`, "TEMPLATE_PARAM_NOT_ALLOWED");
    if (error instanceof CopyParamError) return block(`${template.name} parameters are not valid (${error.code})`, "TEMPLATE_PARAM_NOT_ALLOWED");
    throw error;
  }
}

/** `CH-WA-24H`: outside the window only an approved template, with validated parameters. */
export function checkWindow(ctx: PolicyContext): RuleCheck {
  if (!ctx.byWhatsApp) return skip("the 24-hour window only applies to WhatsApp");
  const invalid = checkTemplate(ctx);
  if (invalid !== undefined) return invalid;
  const { template } = ctx.request;
  if (template !== undefined) return pass(`approved UTILITY template ${template.name}: allowed inside and outside the window`);
  if (ctx.history === undefined) return missing(ctx.mode, "the customer's message history");
  const window = windowAt(ctx);
  if (window.state === "OPEN") return pass(`free text inside the 24-hour window, open until ${window.closesAt ?? "?"}`);
  const since = window.lastInboundAt === undefined ? "the customer never wrote" : `the customer last wrote at ${window.lastInboundAt}`;
  return block(`free text outside the 24-hour window (${since}): only an approved template may go out`, "TEMPLATE_REQUIRED");
}
