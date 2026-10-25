// Read-only probes of the QaDriver (docs/tool-catalog.md):
//
//   memory.inspect  the customer's actor of one epoch (`w-<world>-<customer>-e<epoch>`): its sessions and
//                   events (ListSessions, ListEvents) and the records of its three namespaces, compared by
//                   `{memoryRecordId, createdAt, contentSha256}`; with `sentinel`, whether the extraction
//                   already produced the record that carries it
//   snapshot        what a scenario asserts on: the conversation, the complaints (status history, evidence,
//                   actions, approvals), pending timers, emails with their proof, the tape and the register
//                   of each complaint, the turns spent today and the conversation's `processError`; per
//                   message its disclosure mark and the actions of its buttons (never their nonces), and
//                   per inbound image its scan registry (result, resolution `RESULT_FIRST`/`BIND_FIRST`)
// Neither ever returns a phone, an email address or a record's content.
import { ToolError } from "@reclamo/shared";
import { readClock } from "../clock/state";
import { sha256Hex } from "../lib/crypto";
import { actorIdOf } from "../turns/identity";
import { actorNamespace } from "../worlds/memory-admin";
import type { Message } from "../domain/conversation";
import type { QaInput } from "./inputs";
import type { ActionContext } from "./ports";

function worldOf(ctx: ActionContext): string {
  if (ctx.worldId === undefined) throw new ToolError("INVALID", "this action needs its world");
  return ctx.worldId;
}

export async function memoryInspect(input: QaInput<"memory.inspect">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const epoch = input.epoch ?? (await readClock(ctx.ports.data, worldId)).worldEpoch;
  const actorId = actorIdOf(worldId, input.customerId, epoch);
  const memory = ctx.ports.memory();
  const sessions = await memory.sessionIds(actorId);
  let events = 0;
  for (const sessionId of sessions) events += await memory.eventCount(actorId, sessionId);
  const records = await memory.records(actorNamespace(actorId));
  return {
    actorId,
    sessions: sessions.length,
    events,
    records: records.map((record) => ({ memoryRecordId: record.memoryRecordId, createdAt: record.createdAt, contentSha256: sha256Hex(record.content) })),
    sentinelSeen: input.sentinel === undefined ? null : records.some((record) => record.content.includes(input.sentinel ?? "")),
  };
}

async function complaintView(ctx: ActionContext, worldId: string, epoch: number, complaintId: string) {
  const { data } = ctx.ports;
  const file = await data.caseItems.caseFile(worldId, complaintId);
  const complaint = file.complaint;
  const [register, tape] = await Promise.all([
    complaint === undefined ? Promise.resolve([]) : data.chains.listRegisterByComplaint(worldId, epoch, complaint.complaintNumber),
    data.chains.listTapeByComplaint(worldId, complaintId),
  ]);
  return {
    complaint: complaint ?? null,
    evidence: file.evidence.map((item) => ({ evidenceId: item.evidenceId, kind: item.kind, actor: item.actor })),
    actions: file.actions,
    approvals: file.approvals,
    register: register.map((entry) => ({ seq: entry.seq, eventType: entry.eventType, atSim: entry.atSim })),
    tape: tape.map((entry) => ({ tapeId: entry.tapeId, decision: entry.decision, ruleIds: entry.ruleIds ?? [], kind: entry.kind ?? null, channel: entry.channel })),
  };
}

/** The buttons of an outbound message: action and title only (a nonce never leaves the thread). */
function buttonsOf(message: Message): { readonly action: string; readonly title: string | null }[] {
  const buttons = (message.interactive as { readonly buttons?: unknown } | undefined)?.buttons;
  if (!Array.isArray(buttons)) return [];
  return buttons.flatMap((button: unknown) => {
    const { action, title } = (button ?? {}) as { readonly action?: unknown; readonly title?: unknown };
    return typeof action === "string" ? [{ action, title: typeof title === "string" ? title : null }] : [];
  });
}

/** The scan registry of an inbound image, while it lives (its TTL is one hour past its last change). */
async function scanOf(ctx: ActionContext, worldId: string, message: Message) {
  const announceKey = message.media?.announceKey;
  if (message.direction !== "IN" || announceKey === undefined) return null;
  const scan = await ctx.ports.data.scans.get(worldId, announceKey);
  return {
    status: message.media?.scan ?? null,
    result: scan?.result ?? null,
    resolution: scan?.resolution ?? null,
    resultAtReal: scan?.resultAtReal ?? null,
    boundAtReal: scan?.boundAtReal ?? null,
    resolvedAtReal: scan?.resolvedAtReal ?? null,
  };
}

export async function snapshot(input: QaInput<"snapshot">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const { data } = ctx.ports;
  const clock = await readClock(data, worldId);
  const epoch = clock.worldEpoch;
  const complaints = input.customerId === undefined ? await data.complaints.listOpen(worldId) : await data.complaints.listByCustomer(worldId, input.customerId);
  const conversation = input.customerId === undefined ? undefined : await data.conversations.getMeta(worldId, input.customerId);
  const messages = input.customerId === undefined ? [] : await data.conversations.listMessages(worldId, input.customerId);
  const [timers, emails, state] = await Promise.all([data.timers.listDue(worldId, {}), data.emails.listWorld(worldId, { limit: 50 }), data.runtime.getWorldState(worldId)]);
  const turnsToday = await data.caps.peek({ kind: "TURNCAP", worldId, window: "DAY", at: ctx.ports.now() });
  return {
    worldId,
    epoch,
    clock: { mode: clock.mode, pausedSimNow: clock.pausedSimNow ?? null },
    conversation: conversation ?? null,
    processError: conversation?.processError ?? null,
    messages: await Promise.all(
      messages.map(async (message) => ({
        messageId: message.messageId,
        direction: message.direction,
        channel: message.channel,
        kind: message.kind ?? null,
        status: message.status,
        body: message.body,
        templateName: message.templateName ?? null,
        atSim: message.atSim,
        turnId: message.turnId ?? null,
        disclosure: message.flags.disclosure === true,
        buttons: buttonsOf(message),
        scan: await scanOf(ctx, worldId, message),
      })),
    ),
    complaints: await Promise.all(complaints.map((complaint) => complaintView(ctx, worldId, epoch, complaint.complaintId))),
    timers: timers.map((timer) => ({ kind: timer.kind, timerId: timer.timerId, dueAtSim: timer.dueAtSim, status: timer.status, ownerKey: timer.ownerKey ?? null })),
    emails: emails.emails.map((mail) => ({ mailId: mail.mailId, kind: mail.kind, customerId: mail.customerId, events: mail.events.map((event) => event.type), deliveryProof: mail.deliveryProof !== undefined })),
    inFlight: state.inFlight.length,
    turnsToday,
  };
}
