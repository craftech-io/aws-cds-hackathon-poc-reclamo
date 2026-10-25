// `conversation` router (docs/tool-catalog.md `take_over`, `hand_back`, `operator_send`,
// `operator_reroute`; docs/architecture-integrations.md §4; FL-084, FL-085, FL-086). The console never
// sends and never runs the Harness: it moves the conversation's control and ENQUEUES the operator's
// messages for the worker, which runs them through the gate (`sender OPERATOR:<staffId>`).
//
//   take (W)     `control AGENT → OPERATOR` on the version read, the complaints' mirror and
//                `AuditLog TAKEOVER` in one transaction: while it lasts no turn of the Harness runs
//   release (W)  `control OPERATOR → AGENT` the same way (`AuditLog RELEASE`), then `OPERATOR_RELEASED`
//                with the ids of what the operator wrote since the take-over
//   send (W)     `OPERATOR_SEND` by WhatsApp: free text, or a template; the gate decides (`CH-CONTROL`,
//                `CH-WA-24H`, G2…), and the decision lands on the tape
//   reroute (W)  a permitted path for a `BLOCKED` entry, read from the tape, never from the caller:
//                `HUMAN_QUEUE` writes the human task and `REROUTED` here (nothing leaves); `FORMAL_EMAIL`
//                is a send, so it is ENQUEUED as `OPERATOR_SEND` with `route` and the worker runs the
//                reroute through the gate (worker/dispatch.ts); a second pick answers the first one
import { z } from "zod";
import { type Channel, CustomerId, Id, type MessageKind, Reroute, Sender, ToolError } from "@reclamo/shared";
import type { ComplaintsDeps } from "../complaints/deps";
import { TemplateName } from "../copy/types";
import type { Control } from "../domain/complaint";
import { INBOX_CLOSED_STATUSES } from "../domain/complaint";
import type { ConversationMeta, Message } from "../domain/conversation";
import type { TapeEntry } from "../domain/ledger";
import { worldClock } from "../lib/clock";
import type { OutboundDeps } from "../outbound/deps";
import { offeredReroutes, rerouteBlocked } from "../outbound/reroute";
import type { GateOutcome } from "../outbound/types";
import { type OperationsServices, WorldScoped, actorOfCtx, auditOp, checkWorld, complaintOf, enqueueAs, operationsOf, worldTime } from "./inbox";
import { accessProcedure } from "./roles";
import { type WorldContext, router } from "./trpc";

const CONTROL_ACTIONS = { take: "TAKEOVER", release: "RELEASE" } as const;

/** What the operator wrote that the customer may have read: a blocked or failed message never reached them. */
const UNSEEN: ReadonlySet<Message["status"]> = new Set(["BLOCKED", "FAILED"]);

/** At most this many messages travel in an `OPERATOR_RELEASED` (worker/events.ts). */
const MAX_RELEASED_MESSAGES = 50;

function senderOf(ctx: WorldContext): Sender {
  return Sender.parse(`OPERATOR:${ctx.principal.staffId}`);
}

async function conversationOf(ctx: WorldContext, services: OperationsServices, customerId: string): Promise<ConversationMeta> {
  const meta = await services.data.conversations.getMeta(ctx.principal.worldId, customerId, { consistent: true });
  if (meta === undefined) throw new ToolError("NOT_FOUND", "this customer has no conversation in this world");
  return meta;
}

/** The control change, the complaints' mirror and its audit entry: all or nothing. */
async function moveControl(ctx: WorldContext, services: OperationsServices, meta: ConversationMeta, to: Control, simNow: Date): Promise<void> {
  const worldId = ctx.principal.worldId;
  const open = (await services.data.complaints.listByCustomer(worldId, meta.customerId)).filter((complaint) => !INBOX_CLOSED_STATUSES.has(complaint.status) && complaint.control !== to);
  const from: Control = to === "OPERATOR" ? "AGENT" : "OPERATOR";
  await services.data.transact([
    services.data.conversations.setControlOp({ worldId, customerId: meta.customerId, version: meta.version, from, to, by: actorOfCtx(ctx), atSim: simNow.toISOString(), staffId: ctx.principal.staffId }),
    ...open.map((complaint) => services.data.complaints.patchOp(worldId, complaint.complaintId, complaint.version, { control: to })),
    auditOp(ctx, services, { action: to === "OPERATOR" ? CONTROL_ACTIONS.take : CONTROL_ACTIONS.release, atSim: simNow, ruleIds: ["CH-CONTROL"], refs: { customerId: meta.customerId } }),
  ]);
}

/** Ids of the operator's messages since the conversation was last taken (FL-086). */
async function writtenSinceTake(ctx: WorldContext, services: OperationsServices, meta: ConversationMeta): Promise<string[]> {
  const taken = meta.controlHistory.filter((change) => change.to === "OPERATOR").at(-1);
  const since = taken === undefined ? 0 : Date.parse(taken.atSim);
  const messages = await services.data.conversations.listMessages(ctx.principal.worldId, meta.customerId);
  return messages
    .filter((message) => message.direction === "OUT" && message.sender?.startsWith("OPERATOR:") === true && !UNSEEN.has(message.status) && Date.parse(message.atSim) >= since)
    .map((message) => message.messageId)
    .slice(-MAX_RELEASED_MESSAGES);
}

export const OutboundTemplate = z.object({ name: TemplateName, params: z.array(z.string().trim().min(1).max(300)).max(5) }).strict();

export interface OperatorMessage {
  readonly customerId: string;
  readonly channel: Channel;
  readonly kind: MessageKind;
  readonly text?: string | undefined;
  readonly template?: z.infer<typeof OutboundTemplate> | undefined;
  readonly subject?: string | undefined;
  readonly complaintId?: string | undefined;
}

/** `OPERATOR_SEND` for the worker (the gate decides there); the complaint, if named, must be this customer's. */
export async function enqueueOperatorSend(ctx: WorldContext, services: OperationsServices, message: OperatorMessage) {
  if (message.complaintId !== undefined) {
    const complaint = await complaintOf(ctx, services, message.complaintId);
    if (complaint.customerId !== message.customerId) throw new ToolError("FORBIDDEN", "that complaint is not this customer's", "COMPLAINT_OF_ANOTHER_CUSTOMER");
  }
  const { simNow } = await worldTime(ctx, services);
  const messageId = services.newId("opm");
  const eventId = await enqueueAs(ctx, services, {
    type: "OPERATOR_SEND",
    eventId: `evt-${messageId}`,
    customerId: message.customerId,
    eventAtSim: simNow.toISOString(),
    payload: {
      staffId: ctx.principal.staffId,
      messageId,
      channel: message.channel,
      kind: message.kind,
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.template === undefined ? {} : { template: message.template }),
      ...(message.subject === undefined ? {} : { subject: message.subject }),
      ...(message.complaintId === undefined ? {} : { complaintId: message.complaintId }),
    },
  });
  return { status: "QUEUED" as const, messageId, eventId };
}

/** Text or template, exactly one (the event refuses both or neither). */
export function oneBody(input: { readonly text?: string | undefined; readonly template?: unknown }): boolean {
  return (input.text === undefined) !== (input.template === undefined);
}

function refuse(): never {
  throw new ToolError("UNAVAILABLE", "the console never sends: the worker runs the sends", "CONSOLE_DOES_NOT_SEND");
}

/**
 * The gate's ports for a reroute run by the console: the chains and the world's clock, and every port
 * that could reach a customer refusing. A `HUMAN_QUEUE` reroute only writes; anything that would send
 * fails here instead of leaving the system from the console.
 */
export function consoleRerouteDeps(chains: ComplaintsDeps): OutboundDeps {
  const transport = { mode: "simulated" as const, send: refuse };
  return {
    chains,
    simNow: (worldId) => worldClock(worldId, chains.connector.runtime.clockState).now(),
    customers: { get: refuse },
    emails: { addressOf: refuse },
    recipients: { whatsAppNumber: refuse },
    phoneHash: refuse,
    debts: { overdue: refuse },
    documents: { read: refuse, collectionNotice: refuse },
    guardrail: { check: refuse },
    email: { send: refuse, checkRecipient: refuse },
    whatsapp: { simulated: transport },
    stageModes: { email: "live", whatsapp: { liveWorlds: [] } },
    demoRecipients: () => ({ emails: [], phones: [] }),
  };
}

const RerouteInput = z.object({ ...WorldScoped, tapeId: Id, route: Reroute, customerId: CustomerId.optional() }).strict();

/** How far back the tape is searched for the blocked entry (outbound/reroute.ts searches the same window). */
const TAPE_WINDOW = 200;

async function reroute(ctx: WorldContext, services: OperationsServices, input: z.infer<typeof RerouteInput>) {
  const worldId = ctx.principal.worldId;
  const blocked = (await services.data.chains.listTapeByDecision(worldId, "BLOCKED", TAPE_WINDOW)).find((entry) => entry.tapeId === input.tapeId);
  if (blocked === undefined) throw new ToolError("NOT_FOUND", "no blocked message with that id in this world");
  const owner = blocked.complaintId === undefined ? undefined : (await complaintOf(ctx, services, blocked.complaintId)).customerId;
  if (owner !== undefined && input.customerId !== undefined && owner !== input.customerId) throw new ToolError("FORBIDDEN", "the blocked message is not this customer's");
  const customerId = owner ?? input.customerId;
  if (customerId === undefined) throw new ToolError("INVALID", "name the customer of a blocked message without a complaint", "CUSTOMER_REQUIRED");
  const option = offeredReroutes(blocked).find((candidate) => candidate.route === input.route);
  if (option === undefined) throw new ToolError("INVALID", `${input.route} is not a permitted path for this block`, "ROUTE_NOT_OFFERED");
  if (input.route === "FORMAL_EMAIL") return enqueueFormalEmail(ctx, services, blocked, customerId, "previewKind" in option ? option.previewKind : undefined);
  const deps = consoleRerouteDeps(services.chains());
  const call = { actor: actorOfCtx(ctx), correlationId: ctx.correlationId, log: ctx.log };
  const outcome: GateOutcome = await rerouteBlocked(deps, refuse, { worldId, customerId, tapeId: blocked.tapeId, route: input.route, by: senderOf(ctx) }, call);
  if (!outcome.ok) throw new ToolError(outcome.failure.error.code, outcome.failure.error.message, "REROUTE_REFUSED");
  return { decision: outcome.decision, tapeId: outcome.tapeId ?? null, reroutedTo: outcome.decision === "REROUTED" ? outcome.reroutedTo : input.route, ruleIds: [...outcome.ruleIds] };
}

/**
 * The formal email of a blocked message, for the worker: an earlier pick answers as it was; otherwise
 * `OPERATOR_SEND` with `route` and ids derived from the blocked entry, so a retry or a second operator
 * is deduplicated by the queue and by the gate.
 */
async function enqueueFormalEmail(ctx: WorldContext, services: OperationsServices, blocked: TapeEntry, customerId: string, previewKind: string | undefined) {
  const worldId = ctx.principal.worldId;
  const earlier = (await services.data.chains.listTapeByDecision(worldId, "REROUTED", TAPE_WINDOW)).find((entry) => entry.rerouteOf === blocked.tapeId);
  if (earlier !== undefined) return { decision: "REROUTED" as const, tapeId: earlier.tapeId, reroutedTo: earlier.reroute?.route ?? "FORMAL_EMAIL", ruleIds: [...earlier.ruleIds] };
  const { simNow } = await worldTime(ctx, services);
  const messageId = `rr-op-${blocked.tapeId}`;
  const kind: MessageKind = previewKind === "COLLECTION_NOTICE_EMAIL" ? "COLLECTION_NOTICE_EMAIL" : "COMPLAINT_UPDATE";
  const eventId = await enqueueAs(ctx, services, {
    type: "OPERATOR_SEND",
    eventId: `evt-${messageId}`,
    customerId,
    eventAtSim: simNow.toISOString(),
    payload: {
      staffId: ctx.principal.staffId,
      messageId,
      channel: "EMAIL",
      kind,
      rerouteOf: blocked.tapeId,
      route: "FORMAL_EMAIL",
      ...(blocked.complaintId === undefined ? {} : { complaintId: blocked.complaintId }),
    },
  });
  return { decision: "QUEUED" as const, tapeId: null, reroutedTo: "FORMAL_EMAIL" as const, ruleIds: [] as string[], messageId, eventId };
}

const CustomerRef = z.object({ ...WorldScoped, customerId: CustomerId }).strict();

const SendInput = CustomerRef.extend({
  text: z.string().trim().min(1).max(900).optional(),
  template: OutboundTemplate.optional(),
  complaintId: Id.optional(),
})
  .strict()
  .refine(oneBody, { message: "text or template, exactly one", path: ["text"] });

export const conversationRouter = router({
  take: accessProcedure("conversation.take")
    .input(CustomerRef)
    .mutation(async ({ ctx, input, path }) => {
      await checkWorld(ctx, path, input);
      const services = operationsOf(ctx.deps);
      const meta = await conversationOf(ctx, services, input.customerId);
      if (meta.control === "OPERATOR") {
        if (meta.controlledBy === ctx.principal.staffId) return { control: meta.control, already: true };
        throw new ToolError("CONFLICT", "another person has this conversation", "CONTROL_TAKEN");
      }
      const { simNow } = await worldTime(ctx, services);
      await moveControl(ctx, services, meta, "OPERATOR", simNow);
      return { control: "OPERATOR" as const, already: false };
    }),

  release: accessProcedure("conversation.release")
    .input(CustomerRef)
    .mutation(async ({ ctx, input, path }) => {
      await checkWorld(ctx, path, input);
      const services = operationsOf(ctx.deps);
      const meta = await conversationOf(ctx, services, input.customerId);
      if (meta.control !== "OPERATOR") throw new ToolError("CONFLICT", "the agent already holds this conversation", "NOT_TAKEN");
      const { simNow } = await worldTime(ctx, services);
      const messageIds = await writtenSinceTake(ctx, services, meta);
      await moveControl(ctx, services, meta, "AGENT", simNow);
      // Fixed by the version the release left: a retried enqueue of the same release is deduplicated.
      const eventId = await enqueueAs(ctx, services, {
        type: "OPERATOR_RELEASED",
        eventId: `evt-rel-${meta.customerId}-v${meta.version + 1}`,
        customerId: meta.customerId,
        eventAtSim: simNow.toISOString(),
        payload: { staffId: ctx.principal.staffId, messageIds },
      });
      return { control: "AGENT" as const, eventId, messageIds };
    }),

  send: accessProcedure("conversation.send")
    .input(SendInput)
    .mutation(async ({ ctx, input, path }) => {
      await checkWorld(ctx, path, input);
      const kind: MessageKind = input.template === undefined ? "OPERATOR_MESSAGE" : "COMPLAINT_UPDATE";
      return enqueueOperatorSend(ctx, operationsOf(ctx.deps), { ...input, channel: "WHATSAPP", kind });
    }),

  reroute: accessProcedure("conversation.reroute")
    .input(RerouteInput)
    .mutation(async ({ ctx, input, path }) => {
      await checkWorld(ctx, path, input);
      return reroute(ctx, operationsOf(ctx.deps), input);
    }),
});
