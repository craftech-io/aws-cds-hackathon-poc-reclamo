// Checks (a) and (b) of `PolicyAudit` for one outbound message (docs/architecture.md §12):
//
//   (a) the tape has an `ALLOWED` with this `messageId` (of this world), carrying a `payloadHash`, the
//       same hash on every `ALLOWED` of the message (a deferred send decided again renders the same
//       body), and every `DISPATCH` of the message comes after an `ALLOWED` of its epoch in the chain
//       (`seq` order, never the client's clock). A message fabricated outside the gate has no `ALLOWED`.
//   (b) the channel policy at the instant it went out, rebuilt from the dated histories
//       (channel-policy/as-of.ts, exhaustive so every breached rule is named), allows it.
import { evaluateAsOf } from "../channel-policy/as-of";
import type { Message } from "../domain/conversation";
import type { TapeEntry } from "../domain/ledger";
import { type ConversationFacts, type WorldFacts, asOfFactsOf } from "./facts";
import type { Finding } from "./record";

export type TapeReason = "NO_ALLOWED" | "NO_PAYLOAD_HASH" | "PAYLOAD_MISMATCH" | "DISPATCH_BEFORE_ALLOWED";

/** What (a) finds wrong in the tape entries of one message, or `undefined` when it is clean. */
export function tapeReason(entries: readonly TapeEntry[]): TapeReason | undefined {
  const allowed = entries.filter((entry) => entry.decision === "ALLOWED");
  if (allowed.length === 0) return "NO_ALLOWED";
  if (allowed.some((entry) => entry.payloadHash === undefined)) return "NO_PAYLOAD_HASH";
  if (new Set(allowed.map((entry) => entry.payloadHash)).size > 1) return "PAYLOAD_MISMATCH";
  const dispatches = entries.filter((entry) => entry.decision === "DISPATCH");
  const preceded = (dispatch: TapeEntry) => allowed.some((entry) => entry.epoch === dispatch.epoch && entry.seq < dispatch.seq);
  return dispatches.every(preceded) ? undefined : "DISPATCH_BEFORE_ALLOWED";
}

function refsOf(message: Message): Record<string, string> {
  return { messageId: message.messageId, customerId: message.customerId, ...(message.complaintId === undefined ? {} : { complaintId: message.complaintId }), channel: message.channel, ...(message.kind === undefined ? {} : { kind: message.kind }) };
}

/** Check (a): the gate's own record of the message. */
export function tapeFinding(message: Message, entries: readonly TapeEntry[]): Finding | undefined {
  const reason = tapeReason(entries.filter((entry) => entry.worldId === message.worldId && entry.messageId === message.messageId));
  if (reason === undefined) return undefined;
  return {
    check: "TAPE_ALLOWED",
    key: `TAPE_ALLOWED#${message.messageId}`,
    ruleIds: [],
    reason,
    refs: refsOf(message),
    atSim: message.sentAtSim ?? message.atSim,
    primaryRef: `MSG#${message.messageId}`,
  };
}

/** Check (b): the policy of that moment; a message whose row cannot be re-evaluated is reported as such. */
export function reevaluationFinding(conversation: ConversationFacts, message: Message, world: WorldFacts): Finding | undefined {
  const facts = asOfFactsOf(conversation, message, world);
  const base = { check: "POLICY_REEVALUATION" as const, key: `POLICY_REEVALUATION#${message.messageId}`, refs: refsOf(message), atSim: message.sentAtSim ?? message.atSim, primaryRef: `MSG#${message.messageId}` };
  if (facts === undefined) return { ...base, ruleIds: [], reason: "NOT_REEVALUABLE" };
  const decision = evaluateAsOf(facts, { exhaustive: true });
  if (decision.decision === "ALLOWED") return undefined;
  return { ...base, ruleIds: [...decision.ruleIds], reason: decision.decision === "DEFERRED" ? "DEFERRED_AT_ITS_INSTANT" : "BLOCKED_AT_ITS_INSTANT" };
}
