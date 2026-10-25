// A blocked evaluation (docs/architecture-integrations.md §4): the tape's `BLOCKED` with the rules
// that stopped it and every rule evaluated, a `Message` row `BLOCKED` (what was attempted, never sent:
// the reroute and the console read it), a G2 refusal's reason and scores in `AuditLog` (never the
// text, ADR-0021 §10), and the tool error the caller answers. A block of a rule that has a permitted
// path carries its reroutes (`HUMAN_QUEUE`, `FORMAL_EMAIL`), and a collection block the lexicon's
// categories.
import { type ErrorCode, fail } from "@reclamo/shared";
import type { RerouteOption } from "../channel-policy/types";
import type { CollectionCategory } from "../copy/types";
import { newIdOf } from "../complaints/deps";
import { isConflict } from "../connector/errors";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import type { G2Verdict } from "./g2";
import { messageRow } from "./persist";
import { appendTape } from "./tape";
import { GATE_AUDIT, type GateRefused, type OutboundCall, type OutboundRequest } from "./types";

export interface BlockInput {
  readonly request: OutboundRequest;
  readonly ctx: SendContext;
  readonly messageId: string;
  readonly ruleIds: readonly string[];
  readonly evaluated: readonly { readonly ruleId: string; readonly result: string }[];
  readonly ruleSetVersion: string;
  readonly code: ErrorCode;
  readonly reason: string;
  readonly message: string;
  /** What was attempted, as the customer would have read it (when it could be rendered). */
  readonly attempted?: string;
  readonly reroutes?: readonly RerouteOption[];
  readonly g2?: G2Verdict;
  /** The collection-lexicon categories the text tripped, kept on the tape (FL-067). */
  readonly categories?: readonly CollectionCategory[];
}

async function auditG2(deps: OutboundDeps, input: BlockInput, call: OutboundCall): Promise<void> {
  if (input.g2 === undefined || !input.ruleIds.includes("G2")) return;
  const { g2, request, ctx } = input;
  await deps.chains.connector.audit.append({
    worldId: request.worldId,
    epoch: ctx.epoch,
    auditId: newIdOf(deps.chains, "aud"),
    ts: ctx.realNow.toISOString(),
    atSim: ctx.simNow.toISOString(),
    action: GATE_AUDIT.G2_REFUSED,
    actor: call.actor,
    ruleIds: ["G2"],
    refs: { messageId: input.messageId, kind: request.kind, ...(request.turnId === undefined ? {} : { turnId: request.turnId }) },
    primaryRef: request.complaintId === undefined ? `CUS#${request.customerId}` : `CMP#${request.complaintId}`,
    outcome: g2.failure ?? "BLOCKED",
    detail: { reason: g2.failure ?? "BLOCKED", ...(g2.groundingScore === undefined ? {} : { groundingScore: g2.groundingScore }), ...(g2.relevanceScore === undefined ? {} : { relevanceScore: g2.relevanceScore }) },
  });
}

async function keepAttempt(deps: OutboundDeps, input: BlockInput, tapeId: string): Promise<void> {
  const { request, ctx } = input;
  const row = messageRow({ request, messageId: input.messageId, atSim: ctx.simNow.toISOString(), status: "BLOCKED", tapeRef: tapeId, body: input.attempted ?? request.text ?? "", simulated: request.channel === "WHATSAPP" && ctx.mode === "simulated" });
  try {
    await deps.chains.connector.conversations.putMessage(row);
  } catch (error) {
    // A redelivered request blocked again finds its attempt already kept.
    if (!isConflict(error)) throw error;
  }
}

/** Writes the block and answers it. */
export async function recordBlock(deps: OutboundDeps, input: BlockInput, call: OutboundCall): Promise<GateRefused> {
  const { request, ctx } = input;
  const entry = await appendTape(
    deps,
    {
      worldId: request.worldId,
      epoch: ctx.epoch,
      atSim: ctx.simNow.toISOString(),
      decision: "BLOCKED",
      ruleIds: input.ruleIds,
      evaluated: input.evaluated,
      ruleSetVersion: input.ruleSetVersion,
      sender: request.sender,
      channel: request.channel,
      kind: request.kind,
      customerId: request.customerId,
      messageId: input.messageId,
      ...(request.complaintId === undefined ? {} : { complaintId: request.complaintId }),
      ...(request.rerouteOf === undefined ? {} : { rerouteOf: request.rerouteOf }),
      ...(input.categories === undefined ? {} : { collectionCategories: input.categories }),
    },
    call.log,
  );
  await Promise.all([keepAttempt(deps, input, entry.tapeId), auditG2(deps, input, call)]);
  call.log.warn("outbound.blocked", { rule: input.ruleIds[0], code: input.code, kind: request.kind, channel: request.channel });
  return {
    ok: false,
    decision: "BLOCKED",
    messageId: input.messageId,
    tapeId: entry.tapeId,
    ruleIds: [...input.ruleIds],
    ...(input.reroutes === undefined || input.reroutes.length === 0 ? {} : { reroutes: input.reroutes.map((option) => ({ route: option.route, ...("previewKind" in option ? { previewKind: option.previewKind } : {}) })) }),
    failure: fail(input.code, input.message, input.reason),
  };
}
