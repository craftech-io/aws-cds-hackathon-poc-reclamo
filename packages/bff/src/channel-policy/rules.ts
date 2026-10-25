// The rules about who sends what to whom (docs/design-brief.md §7): the sender, who holds the
// conversation, the kind → channel matrix, the opt-in and the opt-out, the customer-initiated
// complaint behind a proactive WhatsApp, and the formal content of the written answer and of the
// formal debt notice. Every dated fact is read from its history at the decided instant; a send
// decided now also honours the current value when it is the stricter one, so a history that lags the
// row can never let a send through.
import type { ComplaintStatus } from "@reclamo/shared";
import { block, inForceAt, lastInForce, missing, pass, skip } from "./checks";
import type { PolicyContext } from "./context";
import { KIND_ROUTES, OPERATOR_FREE_TEXT_KINDS, OPT_OUT_CONFIRMATION, SENDING_ROLES, SYSTEM_KINDS, staffIdOf } from "./kinds";
import type { ConsentEvent, RuleCheck } from "./types";

function sending(ctx: PolicyContext): boolean {
  return ctx.mode === "SEND";
}

/** `CH-SENDER`: an agent with a valid session, an operator with a current role in the world, or `SYSTEM` with a deterministic kind. */
export function checkSender(ctx: PolicyContext): RuleCheck {
  const { sender, kind, auth, worldId } = ctx.request;
  if (ctx.senderClass === "SYSTEM") return SYSTEM_KINDS.has(kind) ? pass(`SYSTEM sends the deterministic ${kind}`) : block(`${kind} is not a deterministic SYSTEM message`);
  if (ctx.senderClass === "AGENT") {
    if (auth?.agentSessionValid === undefined) return missing(ctx.mode, "the agent's session check");
    return auth.agentSessionValid ? pass("the agent's session token is valid") : block("the agent's session token is not valid");
  }
  const staff = auth?.staff;
  if (staff === undefined) return missing(ctx.mode, "the sender's staff row");
  if (staff.staffId !== staffIdOf(sender)) return block("the staff row is not the sender's");
  if (staff.worldId !== worldId) return block("the sender is staff of another world");
  if (!staff.active) return block("the sender's staff row is inactive");
  if (!(SENDING_ROLES as readonly string[]).includes(staff.role)) return block(`${staff.role} is read-only: it never writes to a customer`);
  return pass(`${staff.role} with a current row in the world`);
}

/** The holder of the conversation at the instant, and who took it. */
function controlAt(ctx: PolicyContext): { control: "AGENT" | "OPERATOR"; by?: string } | undefined {
  const conversation = ctx.input.conversation;
  if (conversation === undefined) return undefined;
  const last = lastInForce(conversation.controlHistory, ctx.simNow, ctx.realNow, ctx.mode);
  if (sending(ctx) && conversation.control === "OPERATOR") return { control: "OPERATOR", ...(conversation.controlledBy === undefined ? {} : { by: `OPERATOR:${conversation.controlledBy}` }) };
  if (last === undefined) return { control: "AGENT" };
  return { control: last.to, by: last.by };
}

/** `CH-CONTROL`: with the conversation taken the agent does not send; an operator writes free text only with it taken. */
export function checkControl(ctx: PolicyContext): RuleCheck {
  const { kind, sender, template } = ctx.request;
  const freeText = ctx.byWhatsApp && OPERATOR_FREE_TEXT_KINDS.has(kind) && template === undefined;
  if (ctx.senderClass === "SYSTEM") return skip("SYSTEM's deterministic messages go out whoever holds the conversation");
  if (ctx.senderClass === "OPERATOR" && !freeText) return skip(`${kind} is not operator free text by WhatsApp`);
  const control = controlAt(ctx);
  if (control === undefined) return missing(ctx.mode, "the conversation's control");
  if (ctx.senderClass === "AGENT") return control.control === "OPERATOR" ? block("a person took the conversation: the agent does not send", "CONTROL_OPERATOR") : pass("the agent holds the conversation");
  if (control.control !== "OPERATOR") return block("an operator writes free text by WhatsApp only with the conversation taken");
  if (control.by !== undefined && control.by.startsWith("OPERATOR:") && control.by !== sender) return block("another person holds the conversation");
  return pass("the operator holds the conversation");
}

/** `CH-KIND-CHANNEL`: the matrix of docs/design-brief.md §3 (kind → channel and senders). */
export function checkKindChannel(ctx: PolicyContext): RuleCheck {
  const { kind, channel, rerouteOf, attachments, worldId } = ctx.request;
  const route = KIND_ROUTES[kind];
  if (!route.channels.includes(channel)) return block(`${kind} never goes by ${channel}`);
  if (!route.senders.includes(ctx.senderClass)) return block(`${kind} is never sent by ${ctx.senderClass}`);
  if (route.rerouteOnly?.includes(channel) === true && rerouteOf === undefined) return block(`${kind} by ${channel} only exists as a reroute of a blocked message`);
  if (route.demoOnly === true && worldId !== "demo") return block(`${kind} by ${channel} only goes out from the demo world`);
  if (channel === "WHATSAPP" && (attachments?.length ?? 0) > 0) return block("documents and certificates go only by email");
  return pass(`${kind} goes by ${channel} from ${ctx.senderClass}`);
}

/** The consent step in force at the instant (`OPT_IN` or `OPT_OUT`). */
function consentAt(ctx: PolicyContext): ConsentEvent | undefined {
  const customer = ctx.input.customer;
  return customer === undefined ? undefined : lastInForce(customer.consentHistory, ctx.simNow, ctx.realNow, ctx.mode);
}

function everOptedIn(ctx: PolicyContext): boolean {
  const customer = ctx.input.customer;
  if (customer === undefined) return false;
  const dated = customer.consentHistory.some((step) => step.action === "OPT_IN" && inForceAt(step, ctx.simNow, ctx.realNow, ctx.mode));
  return dated && !(sending(ctx) && customer.optedIn === false);
}

/** `CH-OPTIN`: a WhatsApp the lender starts needs an opt-in registered by the instant (its revocation is `CH-OPTOUT`'s). */
export function checkOptIn(ctx: PolicyContext): RuleCheck {
  if (!ctx.byWhatsApp) return skip("the WhatsApp opt-in only applies to WhatsApp");
  if (ctx.reply === undefined) return missing(ctx.mode, "the customer's message history");
  if (ctx.reply) return skip("a reply inside the window the customer opened needs no opt-in");
  if (ctx.input.customer === undefined) return missing(ctx.mode, "the customer's consent");
  return everOptedIn(ctx) ? pass("WhatsApp opt-in registered") : block("the customer has no WhatsApp opt-in: a message the lender starts does not go out");
}

/** The inbound WhatsApp messages of the customer after an instant, up to the decided one. */
function wroteAfter(ctx: PolicyContext, atSim: string): boolean {
  const since = Date.parse(atSim);
  return (ctx.history ?? []).some((entry) => entry.direction === "IN" && entry.channel === "WHATSAPP" && Date.parse(entry.atSim) > since && Date.parse(entry.atSim) <= ctx.simNow.getTime());
}

/**
 * `CH-OPTOUT`: after an opt-out only the opt-out confirmation goes out. A customer who writes again
 * after opting out starts a conversation of their own: replies to it go out (our reading).
 */
export function checkOptOut(ctx: PolicyContext): RuleCheck {
  if (!ctx.byWhatsApp) return skip("the opt-out only applies to WhatsApp");
  const customer = ctx.input.customer;
  if (customer === undefined) return missing(ctx.mode, "the customer's consent");
  const step = consentAt(ctx);
  const dated = step?.action === "OPT_OUT";
  const optedOut = dated || (sending(ctx) && customer.optedOut === true);
  if (!optedOut) return pass("no opt-out in force");
  if (ctx.request.kind === OPT_OUT_CONFIRMATION) return pass("the opt-out confirmation is the one WhatsApp that follows an opt-out");
  if (ctx.reply === true && step !== undefined && dated && wroteAfter(ctx, step.atSim)) return pass("a reply to a message the customer wrote after opting out");
  return block("the customer opted out of WhatsApp messages");
}

const CLOSED: ReadonlySet<ComplaintStatus> = new Set(["CLOSED"]);

/** The complaint's status at the instant. */
function complaintStatusAt(ctx: PolicyContext): ComplaintStatus | undefined {
  const complaint = ctx.input.complaint;
  if (complaint === undefined) return undefined;
  if (sending(ctx)) return complaint.status;
  return lastInForce(complaint.statusHistory, ctx.simNow, ctx.realNow, ctx.mode)?.to;
}

/** `CH-WA-CUSTOMER-INITIATED`: a proactive WhatsApp is only news of an open complaint the customer started. */
export function checkCustomerInitiated(ctx: PolicyContext): RuleCheck {
  if (!ctx.byWhatsApp) return skip("only applies to WhatsApp");
  if (ctx.reply === undefined) return missing(ctx.mode, "the customer's message history");
  if (ctx.reply) return skip("a reply inside the window the customer opened");
  const { complaint } = ctx.input;
  if (ctx.request.complaintId === undefined || complaint === undefined) return block("a proactive WhatsApp needs an open complaint of the customer");
  if (complaint.complaintId !== ctx.request.complaintId || complaint.customerId !== ctx.request.customerId) return block("the complaint is not this customer's");
  const status = complaintStatusAt(ctx);
  if (status === undefined) return block("the complaint was not filed yet at this instant");
  if (CLOSED.has(status)) return block(`the complaint is ${status}: no proactive WhatsApp about it`);
  return pass(`news of ${complaint.complaintNumber}, ${status}`);
}

function checkFormalAnswer(ctx: PolicyContext): RuleCheck {
  const { complaint } = ctx.input;
  const { formal, text, complaintId, customerId } = ctx.request;
  if (complaint === undefined || complaintId === undefined) return missing(ctx.mode, "the complaint the written answer resolves");
  if (complaint.complaintId !== complaintId || complaint.customerId !== customerId) return block("the complaint is not this customer's");
  if (formal === undefined) return missing(ctx.mode, "the resolution of the written answer");
  if (text === undefined || text.trim() === "") return missing(ctx.mode, "the body of the written answer");
  return pass(`number ${complaint.complaintNumber}, type, filing date and ${formal.outcome}; the footer with the right to go to the BCRA is rendered by code`);
}

function checkFormalNotice(ctx: PolicyContext): RuleCheck {
  const { debtNotice, text } = ctx.request;
  if (text !== undefined && text.trim() !== "") return block("the formal debt notice carries no free text: the code renders it");
  if (debtNotice === undefined) return missing(ctx.mode, "the debt detail from the core");
  const total = debtNotice.overdue.reduce((sum, item) => sum + item.amountCents, 0);
  if (total !== debtNotice.totalCents) return block("the debt total does not add up the overdue instalments of the core");
  return pass(`creditor identification and ${debtNotice.overdue.length} overdue instalments from the core, rendered by code`);
}

/** `CH-FORMAL-CONTENT`: what the written answer and the formal debt notice must carry. */
export function checkFormalContent(ctx: PolicyContext): RuleCheck {
  if (ctx.request.kind === "FORMAL_ANSWER") return checkFormalAnswer(ctx);
  if (ctx.request.kind === "COLLECTION_NOTICE_EMAIL") return checkFormalNotice(ctx);
  return skip("only the written answer and the formal debt notice have a formal content");
}
