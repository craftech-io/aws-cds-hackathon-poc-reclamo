// What one send is decided with (docs/architecture-integrations.md §4 step 1): the world (epoch,
// `SETTINGS`, holidays, the effective WhatsApp mode), the customer as the core shows it, the
// conversation (control, window, disclosure), the complaint, the customer's thread, the sender's
// credentials as the gate verified them (an open turn of this customer for the agent, a current staff
// row of the world for an operator; never what the caller says), the recipient the transport would
// use, and the turn's tool results that ground the text. Everything is read here, once; the policy
// (channel-policy/engine.ts) and the later steps only read this object.
import { type ChannelMode, ToolError, type TurnTrigger } from "@reclamo/shared";
import { staffIdOf } from "../channel-policy/kinds";
import type { PolicyInput } from "../channel-policy/types";
import { worldWhatsAppMode } from "../channels/whatsapp/registry";
import { loadHolidays } from "../complaints/sla";
import { realNowOf } from "../complaints/deps";
import type { Complaint } from "../domain/complaint";
import type { ConversationMeta, Message } from "../domain/conversation";
import type { Staff, WorldSettings } from "../domain/world";
import { caseFactsOf } from "./case-facts";
import type { CustomerFacts, DebtDetail, OutboundDeps } from "./deps";
import type { OutboundCall, OutboundRequest } from "./types";

export interface SendContext {
  readonly worldId: string;
  readonly epoch: number;
  /** The simulated instant being decided (the world's now, or the due time of a deferred send). */
  readonly simNow: Date;
  readonly realNow: Date;
  readonly settings: WorldSettings;
  readonly holidays: readonly string[];
  /** The world's effective WhatsApp mode. */
  readonly mode: ChannelMode;
  readonly meta: ConversationMeta | undefined;
  readonly customer: CustomerFacts | undefined;
  readonly complaint: Complaint | undefined;
  /** The customer's thread, oldest first. */
  readonly history: readonly Message[];
  readonly staff: Staff | undefined;
  /** `AGENT` only: the turn is open and belongs to this customer. */
  readonly agentSessionValid: boolean | undefined;
  /** The trigger of the open turn of this customer the message belongs to (agent or a tool's fixed message). */
  readonly trigger: TurnTrigger | undefined;
  /** The address (email) or the live number (WhatsApp `live`) the transport would use. */
  readonly to: string | undefined;
  /** The turn's tool results (`Runtime/TURN#…/RESULT#`). */
  readonly turnResults: readonly unknown[];
  /** `AGENT` with a complaint: what its case file already proved (outbound/case-facts.ts). */
  readonly caseFacts?: readonly unknown[];
}

async function agentTurn(deps: OutboundDeps, request: OutboundRequest): Promise<{ readonly valid: boolean; readonly trigger?: TurnTrigger }> {
  if (request.turnId === undefined) return { valid: false };
  const sessions = deps.chains.connector.sessions;
  const turn = await sessions.getTurn(request.worldId, request.turnId);
  if (turn === undefined || turn.status !== "OPEN") return { valid: false };
  const session = await sessions.getSession(request.worldId, turn.sessionId);
  if (session === undefined || session.customerId !== request.customerId) return { valid: false };
  return { valid: true, trigger: session.trigger };
}

async function complaintOf(deps: OutboundDeps, request: OutboundRequest): Promise<Complaint | undefined> {
  if (request.complaintId === undefined) return undefined;
  const complaint = await deps.chains.connector.complaints.get(request.worldId, request.complaintId, { consistent: true });
  if (complaint === undefined) throw new ToolError("NOT_FOUND", "the complaint does not exist in this world");
  // A complaint id never moves a message to another customer's case.
  if (complaint.customerId !== request.customerId) throw new ToolError("FORBIDDEN", "the complaint is not this customer's");
  return complaint;
}

/** The facts an agent's text about a complaint may also quote: what its case file proved in earlier turns. */
async function caseFactsFor(deps: OutboundDeps, request: OutboundRequest): Promise<readonly unknown[]> {
  if (request.sender !== "AGENT" || request.complaintId === undefined) return [];
  return caseFactsOf(await deps.chains.connector.caseItems.caseFile(request.worldId, request.complaintId));
}

async function recipientOf(deps: OutboundDeps, request: OutboundRequest, mode: ChannelMode, customer: CustomerFacts | undefined): Promise<string | undefined> {
  if (request.channel === "EMAIL") return customer === undefined ? undefined : deps.emails.addressOf(request.worldId, customer);
  return mode === "live" ? deps.recipients.whatsAppNumber(request.worldId, request.customerId, "live") : undefined;
}

/** Reads everything one decision needs; `atSim` replaces the world's now (a deferred send's due time). */
export async function loadContext(deps: OutboundDeps, request: OutboundRequest, call: Pick<OutboundCall, "correlationId">, atSim?: string): Promise<SendContext> {
  const { connector } = deps.chains;
  const { worldId, customerId } = request;
  const [settings, epoch, simNow] = await Promise.all([connector.worlds.getSettings(worldId), connector.counters.getEpoch(worldId), atSim === undefined ? deps.simNow(worldId) : Promise.resolve(new Date(atSim))]);
  if (settings === undefined) throw new ToolError("UNAVAILABLE", "the world has no settings");
  const mode = worldWhatsAppMode(worldId, settings, deps.stageModes);
  const staffId = staffIdOf(request.sender);
  const [holidays, meta, customer, complaint, history, staff, agent, results, caseFacts] = await Promise.all([
    loadHolidays(connector),
    connector.conversations.getMeta(worldId, customerId, { consistent: true }),
    deps.customers.get(worldId, customerId, simNow, call.correlationId),
    complaintOf(deps, request),
    connector.conversations.listMessages(worldId, customerId),
    staffId === undefined ? Promise.resolve(undefined) : connector.worlds.getStaff(worldId, staffId),
    request.sender === "AGENT" || request.sender === "SYSTEM" ? agentTurn(deps, request) : Promise.resolve(undefined),
    request.turnId === undefined ? Promise.resolve([]) : connector.sessions.listTurnResults(worldId, request.turnId),
    caseFactsFor(deps, request),
  ]);
  const to = await recipientOf(deps, request, mode, customer);
  return {
    worldId,
    epoch,
    simNow,
    realNow: realNowOf(deps.chains),
    settings,
    holidays,
    mode,
    meta,
    customer,
    complaint,
    history,
    staff,
    agentSessionValid: request.sender === "AGENT" ? agent?.valid : undefined,
    // A fixed message a tool of the turn sends (a handoff notice) answers what opened the turn too.
    trigger: agent?.trigger,
    to,
    turnResults: results.map((result) => result.result),
    caseFacts,
  };
}

/** The customer's last WhatsApp message at or before the instant (masked as stored): what a reply answers. */
export function lastCustomerText(ctx: Pick<SendContext, "history" | "simNow">): string | undefined {
  const inbound = ctx.history.filter((message) => message.direction === "IN" && message.channel === "WHATSAPP" && Date.parse(message.atSim) <= ctx.simNow.getTime());
  return inbound.at(-1)?.body;
}

function consentOf(customer: CustomerFacts): NonNullable<PolicyInput["customer"]> {
  const { whatsapp } = customer;
  const history: NonNullable<PolicyInput["customer"]>["consentHistory"] = [];
  if (whatsapp.optedInAtSim !== undefined) history.push({ action: "OPT_IN", atSim: whatsapp.optedInAtSim, ...(whatsapp.optInMedium === undefined ? {} : { medium: whatsapp.optInMedium }), ...(whatsapp.optInTextVersion === undefined ? {} : { textVersion: whatsapp.optInTextVersion }) });
  if (whatsapp.optedOutAtSim !== undefined) history.push({ action: "OPT_OUT", atSim: whatsapp.optedOutAtSim });
  return { customerId: customer.customerId, consentHistory: history, optedIn: whatsapp.optedIn, optedOut: whatsapp.optedOut };
}

export interface PolicyExtras {
  readonly messageId: string;
  readonly debt?: DebtDetail;
  readonly demoRecipients: { readonly emails: readonly string[]; readonly phones: readonly string[] };
}

/**
 * The resolution `CH-FORMAL-CONTENT` checks: the complaint's recorded outcome, else the one the written
 * answer is sent with (a human case or an executed approval resolve the complaint without one; the
 * letter records it when it is sent, complaints/answer.ts `completeAnswer`).
 */
function formalOf(request: OutboundRequest, complaint: Complaint | undefined): Pick<PolicyInput["request"], "formal"> {
  const outcome = complaint?.outcome ?? (request.kind === "FORMAL_ANSWER" ? request.formal?.outcome : undefined);
  return outcome === undefined ? {} : { formal: { outcome } };
}

/** The engine's input: ids from the request and the stores, facts from the context, never from the model. */
export function policyInputOf(request: OutboundRequest, ctx: SendContext, extras: PolicyExtras): PolicyInput {
  const { meta, customer, complaint, staff } = ctx;
  return {
    request: {
      messageId: extras.messageId,
      worldId: request.worldId,
      customerId: request.customerId,
      ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }),
      sender: request.sender,
      channel: request.channel,
      kind: request.kind,
      ...(request.text === undefined ? {} : { text: request.text }),
      ...(request.template === undefined ? {} : { template: { name: request.template.name, params: [...request.template.params] } }),
      ...(request.attachments === undefined ? {} : { attachments: request.attachments.map((file) => file.docKind) }),
      ...(ctx.to === undefined ? {} : { to: ctx.to }),
      ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
      ...(request.answers === undefined ? {} : { answers: request.answers }),
      ...(request.rerouteOf === undefined ? {} : { rerouteOf: request.rerouteOf }),
      auth: {
        ...(ctx.agentSessionValid === undefined ? {} : { agentSessionValid: ctx.agentSessionValid }),
        ...(staff === undefined ? {} : { staff: { worldId: staff.worldId, staffId: staff.staffId, role: staff.role, active: staff.active } }),
      },
      ...formalOf(request, complaint),
      ...(extras.debt === undefined ? {} : { debtNotice: { source: "CORE" as const, loanId: extras.debt.loanId, overdue: [...extras.debt.overdue], totalCents: extras.debt.totalCents } }),
    },
    ...(customer === undefined ? {} : { customer: consentOf(customer) }),
    conversation: meta === undefined ? { control: "AGENT", controlHistory: [] } : { control: meta.control, ...(meta.controlledBy === undefined ? {} : { controlledBy: meta.controlledBy }), controlHistory: [...meta.controlHistory] },
    ...(complaint === undefined
      ? {}
      : {
          complaint: {
            complaintId: complaint.complaintId,
            customerId: complaint.customerId,
            complaintNumber: complaint.complaintNumber,
            type: complaint.type,
            status: complaint.status,
            filedAtSim: complaint.filedAtSim,
            statusHistory: complaint.statusHistory.map((change) => ({ from: change.from, to: change.to, atSim: change.atSim })),
          },
        }),
    history: ctx.history.map((message) => ({
      messageId: message.messageId,
      direction: message.direction,
      channel: message.channel,
      ...(message.kind === undefined ? {} : { kind: message.kind }),
      status: message.status,
      ...(message.templateName === undefined ? {} : { templateName: message.templateName }),
      atSim: message.atSim,
      ...(message.createdAt === undefined ? {} : { atReal: message.createdAt }),
    })),
    clock: { simNow: ctx.simNow, realNow: ctx.realNow },
    modes: { whatsapp: ctx.mode, email: "live" },
    settings: {
      contactHours: ctx.settings.contactHours,
      maxProactivePerDay: ctx.settings.maxProactivePerDay,
      holidays: [...ctx.holidays],
      demoRecipients: { emails: [...extras.demoRecipients.emails], phones: [...extras.demoRecipients.phones] },
    },
  };
}
