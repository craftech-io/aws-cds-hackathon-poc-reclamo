// `handle_guardrail_block` (docs/architecture.md §9.1, docs/tool-catalog.md, FL-056 to FL-058): what the
// worker does, deterministically and without the model, when G1 blocked a turn, before the Harness (the
// pre-filter) or inside it (`stopReason` `guardrail_intervened` / `content_filtered`).
//
//   1. the Harness's text is never forwarded: it is the guardrail's sentinel;
//   2. a blocked customer's message gets a fixed reply of copy/ through the gate, by policy:
//        denied topic (credit, refinancing)       OUT_OF_SCOPE_REFUSAL  `OUT_OF_SCOPE_REFUSAL`
//        denied topic (legal or investment)       OUT_OF_SCOPE_REFUSAL  `OUT_OF_SCOPE_ADVICE` (the right to go to the BCRA)
//        card data                                SAFETY_GUIDANCE       `SAFETY_GUIDANCE_CARD`
//        prompt attack, any other block, Harness  HANDOFF_NOTICE        `HANDOFF_GUARDRAIL` ("no puedo seguir…")
//      a turn without a customer's text (a settlement, an approval…) sends the handoff notice instead;
//   3. the handoff with reason `GUARDRAIL_BLOCK` (worker/escalation.ts): the open complaint to
//      `HUMAN_REVIEW`, or a task on the conversation (a refusal registers no complaint);
//   4. `GUARDRAIL_BLOCK` audited with the policy, the origin (`PREFILTER`/`HARNESS`) and the source, and
//      the metric `GuardrailBlocks`;
//   5. a block of the Harness raises the conversation's `sessionEpoch`: the next turn starts a clean
//      Harness session, without what the blocked one left in short-term memory.
import type { MessageKind } from "@reclamo/shared";
import { isConflict } from "../connector/errors";
import { HANDOFF_REASON_LABEL, type WhatsAppTextKey } from "../copy";
import type { TurnOutcome } from "../turns/deps";
import { WORKER_ACTIONS, auditOnce, countMetric } from "./audit";
import { type HandoffDeps, handOff } from "./escalation";
import type { TurnEvent } from "./events";
import { sendFixed, whatsappText } from "./notices";

export const GUARDRAIL_BLOCK_METRIC = "GuardrailBlocks";

/** G1's input topics that are advice: their refusal states the right to go to the regulator. */
export const ADVICE_TOPICS: ReadonlySet<string> = new Set(["LegalAdvice", "InvestmentAdvice"]);

export type BlockedTurn = Extract<TurnOutcome, { kind: "BLOCKED" }>;

/** The fixed reply to a blocked customer's message, by what blocked it. */
export function refusalOf(block: Pick<BlockedTurn, "policy" | "topics">): { readonly kind: MessageKind; readonly text: WhatsAppTextKey } {
  if (block.policy === "DENIED_TOPIC") {
    const advice = block.topics.length > 0 && block.topics.every((topic) => ADVICE_TOPICS.has(topic));
    return { kind: "OUT_OF_SCOPE_REFUSAL", text: advice ? "OUT_OF_SCOPE_ADVICE" : "OUT_OF_SCOPE_REFUSAL" };
  }
  if (block.policy === "CARD_DATA") return { kind: "SAFETY_GUIDANCE", text: "SAFETY_GUIDANCE_CARD" };
  return { kind: "HANDOFF_NOTICE", text: "HANDOFF_GUARDRAIL" };
}

export interface GuardrailBlockResult {
  readonly replied: boolean;
  readonly complaintId?: string;
  readonly sessionEpoch?: number;
}

async function raiseSessionEpoch(deps: HandoffDeps, event: TurnEvent): Promise<number | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const meta = await deps.data.conversations.getMeta(event.worldId, event.customerId, { consistent: true });
    if (meta === undefined) return undefined;
    try {
      return (await deps.data.conversations.updateMeta(event.worldId, event.customerId, meta.version, { sessionEpoch: meta.sessionEpoch + 1 })).sessionEpoch;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  deps.log.warn("guardrail.session_epoch_not_raised");
  return undefined;
}

export async function handleGuardrailBlock(deps: HandoffDeps, event: TurnEvent, block: BlockedTurn): Promise<GuardrailBlockResult> {
  const customerText = block.inbound?.source === "CUSTOMER";
  let replied = false;
  if (customerText) {
    const refusal = refusalOf(block);
    const outcome = await sendFixed(deps.gate, deps.log, event, { kind: refusal.kind, text: whatsappText(refusal.text), purpose: `GUARDRAIL_${block.origin}`, ...(block.turnId === undefined ? {} : { turnId: block.turnId }) });
    replied = outcome.ok;
  }
  const handoff = await handOff(deps, {
    worldId: event.worldId,
    customerId: event.customerId,
    epoch: event.epoch,
    eventId: event.eventId,
    eventAtSim: event.eventAtSim,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    reason: "GUARDRAIL_BLOCK",
    summary: `${HANDOFF_REASON_LABEL.GUARDRAIL_BLOCK} · ${block.origin} · ${block.policy}`,
    notify: !customerText,
    cause: "GUARDRAIL_BLOCK",
  });
  const sessionEpoch = block.origin === "HARNESS" ? await raiseSessionEpoch(deps, event) : undefined;
  await auditOnce(deps, {
    action: WORKER_ACTIONS.guardrailBlock,
    worldId: event.worldId,
    epoch: event.epoch,
    eventId: event.eventId,
    atSim: event.eventAtSim,
    ruleIds: ["G1"],
    outcome: block.policy,
    refs: {
      customerId: event.customerId,
      ...(handoff.complaint === undefined ? {} : { complaintId: handoff.complaint.complaintId }),
      ...(block.turnId === undefined ? {} : { turnId: block.turnId }),
      ...(block.inbound?.message === undefined ? {} : { messageId: block.inbound.message.messageId }),
    },
    detail: {
      origin: block.origin,
      source: customerText ? "CUSTOMER" : "SYSTEM",
      replied,
      ...(block.topics.length === 0 ? {} : { topics: [...block.topics] }),
      ...(block.stopReason === undefined ? {} : { stopReason: block.stopReason }),
      ...(sessionEpoch === undefined ? {} : { sessionEpoch }),
    },
  });
  countMetric(deps.log, GUARDRAIL_BLOCK_METRIC, { origin: block.origin, policy: block.policy });
  return { replied, ...(handoff.complaint === undefined ? {} : { complaintId: handoff.complaint.complaintId }), ...(sessionEpoch === undefined ? {} : { sessionEpoch }) };
}
