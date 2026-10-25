// The Lambda fences of docs/design-brief.md §8.6 as middlewares, run in this order after the strict
// parse (`LAM-STRICT`, handler.ts) and before the implementation:
//
//   LAM-SCOPE               every id of the input belongs to the session (scope.ts)       → FORBIDDEN
//   LAM-CONTROL             the conversation is not in an operator's hands                → CONTROL_OPERATOR
//   LAM-COMPLAINT-REQUIRED  an open complaint of the session (**Rc**)                     → COMPLAINT_REQUIRED
//   LAM-IDENTIFIED          the customer passed the challenge in the last 30 real minutes → NOT_IDENTIFIED
//   LAM-ONCE-PER-EVENT      one claim per event that opened the turn                      → CONFLICT
//
// The complaint is required before the identification on purpose: the number is given before the
// challenge (ADR-0015), so an investigation asked for before registering says "register first" (FL-012).
// Identification is read from `Conversations/META.identifiedUntilReal` against the real clock, never
// from the world clock and never from the session row (a challenge passed in this turn counts).
import { ERROR_REASON, type ErrorCode, fail, type ToolFailure } from "@reclamo/shared";
import type { Connector } from "../../connector/port";
import { type Complaint, inboxStateOf } from "../../domain/complaint";
import type { ConversationMeta } from "../../domain/conversation";
import type { JsonObject } from "../../domain/common";
import type { ToolDefinition } from "./define";
import type { ToolSession } from "./principal";
import { type ScopeFindings, type ScopeLookups, checkScope } from "./scope";
import { LAM_RULE, type LamRule } from "./targets";

export interface Refusal {
  readonly failure: ToolFailure;
  readonly ruleIds: readonly LamRule[];
  readonly detail?: JsonObject;
}

export interface FenceCall {
  readonly definition: ToolDefinition;
  readonly input: Readonly<Record<string, unknown>>;
  readonly session: ToolSession;
  readonly connector: Connector;
  readonly lookups: ScopeLookups;
  readonly wallClock: () => Date;
}

/** What the fences resolved, handed to the implementation. */
export interface FenceState {
  findings: ScopeFindings;
  complaint?: Complaint;
  conversation?: ConversationMeta;
}

export type Fence = (call: FenceCall, state: FenceState) => Promise<Refusal | undefined>;

function refusal(code: ErrorCode, message: string, rule: LamRule, reason?: string, detail?: JsonObject): Refusal {
  return { failure: fail(code, message, reason), ruleIds: [rule], ...(detail === undefined ? {} : { detail }) };
}

async function conversationOf(call: FenceCall, state: FenceState): Promise<ConversationMeta | undefined> {
  state.conversation ??= await call.connector.conversations.getMeta(call.session.worldId, call.session.customerId, { consistent: true });
  return state.conversation;
}

export const scopeFence: Fence = async (call, state) => {
  const checked = await checkScope(call.session, call.input, call.definition.scoped, call.lookups);
  if (checked.ok) {
    state.findings = checked.findings;
    return undefined;
  }
  const { ref, why } = checked;
  return refusal("FORBIDDEN", `${ref.path} ${why}`, LAM_RULE.SCOPE, ERROR_REASON.NOT_IN_SESSION, { path: ref.path, kind: ref.kind, targetId: ref.value });
};

export const controlFence: Fence = async (call, state) => {
  if (call.definition.fences.control !== true) return undefined;
  const conversation = await conversationOf(call, state);
  if (conversation?.control !== "OPERATOR") return undefined;
  return refusal("CONTROL_OPERATOR", "an operator has taken over this conversation; do not act or send", LAM_RULE.CONTROL);
};

/** Open complaints of the session, oldest first, as the session lists them. */
export async function openComplaints(call: Pick<FenceCall, "session" | "connector">): Promise<Complaint[]> {
  const { worldId, customerId, complaintIds } = call.session;
  const loaded = await Promise.all(complaintIds.map((id) => call.connector.complaints.get(worldId, id, { consistent: true })));
  return loaded.filter((complaint): complaint is Complaint => complaint !== undefined && complaint.customerId === customerId && inboxStateOf(complaint.status) === "OPEN");
}

/** No complaint to act on: never an instruction to register one (REGISTER decides that), and no note is owed. */
export const NO_OPEN_COMPLAINT =
  "there is no open complaint to act on: a question answered on the spot from get_terms or the reads of the envelope needs none and leaves no note; register a complaint only for a matter that needs follow-up (REGISTER), then investigate or act on it";

/**
 * Why an investigation tool does not apply to the open complaints. An operation the customer did not make
 * (`UNKNOWN_OPERATION`) is never investigated by the agent: it is frozen and handed to a person as FRAUD.
 */
function wrongTypeMessage(tool: string, types: readonly string[], open: readonly Pick<Complaint, "type">[]): string {
  const head = `${tool} investigates ${types.join(" or ")} complaints and none is open`;
  if (open.some((complaint) => complaint.type === "UNKNOWN_OPERATION")) {
    return `${head}: the open complaint is an operation the customer did not make (UNKNOWN_OPERATION), which you do not investigate: call freeze_outgoing with reason UNKNOWN_OPERATION and, in the same turn, escalate_to_human with reason FRAUD`;
  }
  return `${head}: register one with register_complaint only if the customer complains about that`;
}

/**
 * The complaint of an **Rc** call: the one the input names (directly or through its evidence), else the
 * only open one; with several open and none named, a tool that takes `complaintId` must name it, and a
 * tool that does not acts on the last one the session lists (the complaint of this turn). An
 * investigation tool that names none (`check_charge`, `get_transfer_status`…) acts only on the newest
 * open complaint of the types it investigates: its evidence never lands on another type's complaint
 * (complaints/foundation.ts).
 */
export const complaintFence: Fence = async (call, state) => {
  if (call.definition.fences.complaint !== true) return undefined;
  const open = await openComplaints(call);
  const named = state.findings.complaintIds;
  if (named.length > 1) return refusal("INVALID", "the input names more than one complaint", LAM_RULE.COMPLAINT_REQUIRED, "AMBIGUOUS_COMPLAINT");
  if (named.length === 1) {
    const complaint = open.find((item) => item.complaintId === named[0]);
    if (complaint === undefined) return refusal("COMPLAINT_REQUIRED", "that complaint is no longer open; register a new one if the customer complains again", LAM_RULE.COMPLAINT_REQUIRED, undefined, { complaintId: named[0] ?? "" });
    state.complaint = complaint;
    return undefined;
  }
  if (open.length === 0) return refusal("COMPLAINT_REQUIRED", NO_OPEN_COMPLAINT, LAM_RULE.COMPLAINT_REQUIRED);
  const types = call.definition.fences.complaintTypes;
  if (types !== undefined) {
    const investigated = open.filter((complaint) => types.includes(complaint.type));
    if (investigated.length === 0) {
      return refusal("COMPLAINT_REQUIRED", wrongTypeMessage(call.definition.name, types, open), LAM_RULE.COMPLAINT_REQUIRED, "COMPLAINT_TYPE", { types: [...types] });
    }
    state.complaint = investigated[investigated.length - 1];
    return undefined;
  }
  if (open.length > 1 && "complaintId" in call.definition.fields) {
    return refusal("INVALID", `complaintId is required: this session has ${open.length} open complaints`, LAM_RULE.COMPLAINT_REQUIRED, "AMBIGUOUS_COMPLAINT");
  }
  state.complaint = open[open.length - 1];
  return undefined;
};

/** The customer passed the challenge and its 30 real minutes have not run out. */
export function isIdentified(conversation: Pick<ConversationMeta, "identifiedUntilReal"> | undefined, now: Date): boolean {
  const until = conversation?.identifiedUntilReal;
  return until !== undefined && Date.parse(until) > now.getTime();
}

export const identifiedFence: Fence = async (call, state) => {
  if (call.definition.fences.identified !== true) return undefined;
  if (isIdentified(await conversationOf(call, state), call.wallClock())) return undefined;
  return refusal("NOT_IDENTIFIED", "the customer is not identified: ask the identity challenge (identify_customer) first", LAM_RULE.IDENTIFIED);
};

/** `IDEMP#ONCE-<name>#<triggerEventId>`: the source of the once-per-event claim. */
export function oncePerEventSource(name: string): string {
  return `ONCE-${name}`;
}

export const oncePerEventFence: Fence = async (call) => {
  const name = call.definition.fences.oncePerEvent?.(call.input);
  if (name === undefined) return undefined;
  const taken = await call.connector.claims.getIdempotency(call.session.worldId, oncePerEventSource(name), call.session.triggerEventId);
  if (taken === undefined) return undefined;
  return refusal("CONFLICT", `only one ${name} per event; it was already sent in this turn`, LAM_RULE.ONCE_PER_EVENT, undefined, { claim: name });
};

/** The fences in the order they run. */
export const FENCES: readonly Fence[] = [scopeFence, controlFence, complaintFence, identifiedFence, oncePerEventFence];

/** Runs every fence in order; the first refusal stops the call. */
export async function runFences(call: FenceCall): Promise<{ readonly ok: true; readonly state: FenceState } | { readonly ok: false; readonly refusal: Refusal; readonly state: FenceState }> {
  const state: FenceState = { findings: { complaintIds: [], evidence: [] } };
  for (const fence of FENCES) {
    const refused = await fence(call, state);
    if (refused !== undefined) return { ok: false, refusal: refused, state };
  }
  return { ok: true, state };
}

/**
 * After a successful call that took a once-per-event claim, records it; the Harness runs the tools of a
 * response one after another, so the read in `oncePerEventFence` and this write do not race.
 */
export async function recordOncePerEvent(call: FenceCall): Promise<void> {
  const name = call.definition.fences.oncePerEvent?.(call.input);
  if (name === undefined) return;
  await call.connector.claims.claimOnce(call.session.worldId, oncePerEventSource(name), call.session.triggerEventId, { turnId: call.session.turnId });
}
