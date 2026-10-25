// Reroutes of a blocked message (docs/architecture-integrations.md §4, CONTEXT.md "Reencaminamiento",
// FL-065, FL-066): a block of `CH-WA-NO-COLLECTION`, `CH-OPTIN`, `CH-OPTOUT` or `CH-KIND-CHANNEL`
// offers permitted paths, and picking one (the console's `conversation.reroute`, or automatically for
// the system's own blocked message) is decided here, from the tape, never from what the caller says:
//
//   HUMAN_QUEUE   a human task on the complaint (`NOTE#` `HUMAN_TASK`) or on the conversation; nothing
//                 is sent; the tape adds `REROUTED`
//   FORMAL_EMAIL  a NEW request with `rerouteOf = tapeId` that goes through the gate again: the formal
//                 debt notice (`COLLECTION_NOTICE_EMAIL`, rendered by code from the core, only when a
//                 person tried the collection message) or the complaint update by email; the tape adds
//                 `REROUTED` with the child's entry
//
// A block is rerouted once: a second pick answers the first one. A child is never rerouted again.
import { type Reroute, type Sender, ToolError } from "@reclamo/shared";
import { senderClassOf } from "../channel-policy/kinds";
import type { PolicyContext } from "../channel-policy/context";
import { reroutesFor } from "../channel-policy/reroutes";
import { EMAIL_TEXT, BLOCK_SOURCE_REASON, REROUTE_LABEL, fill, statusPhrase } from "../copy";
import { BlockSource, type ChannelRuleId } from "../copy/types";
import { newIdOf, realNowOf } from "../complaints/deps";
import type { TapeEntry } from "../domain/ledger";
import type { Message } from "../domain/conversation";
import type { OutboundDeps } from "./deps";
import { withoutDisclosure } from "./render/disclosure";
import { appendTape, customerRefOf } from "./tape";
import { GATE_AUDIT, type GateOutcome, type GateRerouted, type OutboundCall, type OutboundGate, type OutboundRequest } from "./types";

/** How far back the tape is searched for the blocked entry (newest first). */
const TAPE_WINDOW = 200;

export interface RerouteRequest {
  readonly worldId: string;
  readonly customerId: string;
  /** The `BLOCKED` entry of the tape. */
  readonly tapeId: string;
  readonly route: Reroute;
  /** The operator who picks the path in the console, or `SYSTEM` for its own blocked message. */
  readonly by: Sender;
  /** A derived id for the child message (the console's request id): a retry never sends twice. */
  readonly messageId?: string;
}

function invalid(message: string): ToolError {
  return new ToolError("INVALID", message);
}

/** The paths the block offered, from the stored entry (the policy's own table, channel-policy/reroutes.ts). */
export function offeredReroutes(entry: Pick<TapeEntry, "ruleIds" | "kind" | "complaintId" | "rerouteOf" | "sender">) {
  const ruleId = entry.ruleIds[0];
  if (ruleId === undefined) return [];
  const view = { request: { kind: entry.kind, complaintId: entry.complaintId, rerouteOf: entry.rerouteOf }, senderClass: senderClassOf(entry.sender) } as unknown as PolicyContext;
  return reroutesFor(ruleId as ChannelRuleId, view) ?? [];
}

async function blockedEntry(deps: OutboundDeps, input: RerouteRequest): Promise<TapeEntry> {
  const { chains } = deps.chains.connector;
  const entry = (await chains.listTapeByDecision(input.worldId, "BLOCKED", TAPE_WINDOW)).find((candidate) => candidate.tapeId === input.tapeId);
  if (entry === undefined) throw new ToolError("NOT_FOUND", "no blocked message with that id in this world");
  if (entry.customerRef !== customerRefOf(deps.chains.chainKey, input.worldId, input.customerId)) throw new ToolError("FORBIDDEN", "the blocked message is not this customer's");
  if (input.by === "SYSTEM" && entry.sender !== "SYSTEM") throw new ToolError("FORBIDDEN", "the system reroutes only its own messages");
  return entry;
}

function reroutedOf(entry: TapeEntry): GateRerouted {
  return { ok: true, decision: "REROUTED", reroutedTo: entry.reroute?.route ?? "HUMAN_QUEUE", messageId: entry.messageId ?? "", tapeId: entry.tapeId, ruleIds: [...entry.ruleIds], ...(entry.reroute?.childTapeId === undefined ? {} : { childTapeId: entry.reroute.childTapeId }) };
}

async function writeRerouted(deps: OutboundDeps, blocked: TapeEntry, input: RerouteRequest, call: OutboundCall, childTapeId?: string): Promise<TapeEntry> {
  const { connector } = deps.chains;
  const [epoch, simNow] = await Promise.all([connector.counters.getEpoch(input.worldId), deps.simNow(input.worldId)]);
  return appendTape(
    deps,
    {
      worldId: input.worldId,
      epoch,
      atSim: simNow.toISOString(),
      decision: "REROUTED",
      ruleIds: blocked.ruleIds,
      ruleSetVersion: blocked.ruleSetVersion,
      sender: input.by,
      channel: blocked.channel,
      kind: blocked.kind,
      customerId: input.customerId,
      reroute: { route: input.route, ...(childTapeId === undefined ? {} : { childTapeId }) },
      rerouteOf: blocked.tapeId,
      ...(blocked.messageId === undefined ? {} : { messageId: blocked.messageId }),
      ...(blocked.complaintId === undefined ? {} : { complaintId: blocked.complaintId }),
    },
    call.log,
  );
}

/** The human task: on the complaint when there is one, on the conversation otherwise. Nothing is sent. */
async function toHumanQueue(deps: OutboundDeps, blocked: TapeEntry, input: RerouteRequest, call: OutboundCall): Promise<GateRerouted> {
  const { connector } = deps.chains;
  const [epoch, simNow] = await Promise.all([connector.counters.getEpoch(input.worldId), deps.simNow(input.worldId)]);
  const source = BlockSource.safeParse(blocked.ruleIds[0]);
  const text = source.success ? `${REROUTE_LABEL.HUMAN_QUEUE} · ${BLOCK_SOURCE_REASON[source.data].short}` : REROUTE_LABEL.HUMAN_QUEUE;
  const atSim = simNow.toISOString();
  const author = input.by;
  const task = { status: "OPEN" as const, route: "HUMAN_QUEUE" as const, tapeId: blocked.tapeId };
  const taskOp =
    blocked.complaintId === undefined
      ? connector.conversations.putTaskOp({ worldId: input.worldId, customerId: input.customerId, taskId: newIdOf(deps.chains, "task"), atSim, author, text, task })
      : connector.caseItems.putNoteOp({ worldId: input.worldId, complaintId: blocked.complaintId, noteId: newIdOf(deps.chains, "note"), kind: "HUMAN_TASK", atSim, author, text, task });
  await connector.transact([
    taskOp,
    connector.audit.appendOp({
      worldId: input.worldId,
      epoch,
      auditId: newIdOf(deps.chains, "aud"),
      ts: realNowOf(deps.chains).toISOString(),
      atSim,
      action: GATE_AUDIT.HUMAN_QUEUE,
      actor: call.actor,
      ruleIds: [...blocked.ruleIds],
      refs: { tapeId: blocked.tapeId, ...(blocked.messageId === undefined ? {} : { messageId: blocked.messageId }) },
      primaryRef: blocked.complaintId === undefined ? `CUS#${input.customerId}` : `CMP#${blocked.complaintId}`,
      outcome: "HUMAN_TASK",
    }),
  ]);
  return reroutedOf(await writeRerouted(deps, blocked, input, call));
}

/** The complaint update by email: the phrase of the blocked template, or the text the person wrote. */
function updateText(attempt: Message | undefined, complaintNumber: string): string {
  const phrase = attempt?.templateName === "reclamo_novedad" ? statusPhrase(attempt.templateParams?.[2] ?? "") : undefined;
  if (phrase !== undefined) return fill(EMAIL_TEXT.UPDATE_BODY, { complaintNumber, statusPhrase: phrase });
  const text = attempt === undefined ? "" : withoutDisclosure(attempt).trim();
  if (text === "") throw invalid("the blocked update has no text to send by email");
  return text;
}

async function childRequest(deps: OutboundDeps, blocked: TapeEntry, input: RerouteRequest, previewKind: "COLLECTION_NOTICE_EMAIL" | "COMPLAINT_UPDATE_EMAIL"): Promise<OutboundRequest> {
  const { connector } = deps.chains;
  const base = {
    worldId: input.worldId,
    customerId: input.customerId,
    sender: input.by,
    channel: "EMAIL" as const,
    rerouteOf: blocked.tapeId,
    refs: { rerouteOf: blocked.tapeId },
    messageId: input.messageId ?? `rr-${blocked.tapeId}`,
    ...(blocked.complaintId === undefined ? {} : { complaintId: blocked.complaintId }),
  };
  if (previewKind === "COLLECTION_NOTICE_EMAIL") return { ...base, kind: "COLLECTION_NOTICE_EMAIL" };
  if (blocked.complaintId === undefined) throw invalid("an update by email belongs to a complaint");
  const [complaint, attempt] = await Promise.all([
    connector.complaints.get(input.worldId, blocked.complaintId),
    blocked.messageId === undefined ? Promise.resolve(undefined) : connector.conversations.findMessage(input.worldId, input.customerId, blocked.messageId),
  ]);
  if (complaint === undefined) throw new ToolError("NOT_FOUND", "the complaint of the blocked update does not exist");
  return { ...base, kind: "COMPLAINT_UPDATE", text: updateText(attempt, complaint.complaintNumber) };
}

/** Picks a permitted path for a blocked message. */
export async function rerouteBlocked(deps: OutboundDeps, gate: OutboundGate, input: RerouteRequest, call: OutboundCall): Promise<GateOutcome> {
  const blocked = await blockedEntry(deps, input);
  const earlier = (await deps.chains.connector.chains.listTapeByDecision(input.worldId, "REROUTED", TAPE_WINDOW)).find((entry) => entry.rerouteOf === blocked.tapeId);
  if (earlier !== undefined) return reroutedOf(earlier);
  const option = offeredReroutes(blocked).find((candidate) => candidate.route === input.route);
  if (option === undefined) throw invalid(`${input.route} is not a permitted path for this block`);
  if (option.route === "HUMAN_QUEUE") return toHumanQueue(deps, blocked, input, call);
  const child = await childRequest(deps, blocked, input, option.previewKind);
  const outcome = await gate(child, call);
  const rerouted = await writeRerouted(deps, blocked, input, call, outcome.tapeId);
  if (!outcome.ok) return outcome;
  return { ok: true, decision: "REROUTED", reroutedTo: "FORMAL_EMAIL", messageId: outcome.messageId, tapeId: rerouted.tapeId, ruleIds: [...outcome.ruleIds], ...(outcome.tapeId === undefined ? {} : { childTapeId: outcome.tapeId }) };
}

/** The path the system takes for its own blocked message: the update by email when offered, else a person. */
export function systemRoute(options: readonly { readonly route: Reroute; readonly previewKind?: string }[]): Reroute | undefined {
  if (options.some((option) => option.route === "FORMAL_EMAIL" && option.previewKind === "COMPLAINT_UPDATE_EMAIL")) return "FORMAL_EMAIL";
  return options.some((option) => option.route === "HUMAN_QUEUE") ? "HUMAN_QUEUE" : undefined;
}
