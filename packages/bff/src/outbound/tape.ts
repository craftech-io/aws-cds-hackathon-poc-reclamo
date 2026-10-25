// The compliance tape (docs/architecture.md §8.3, docs/architecture-integrations.md §4): every
// evaluation of the gate leaves one entry, `ALLOWED`, `BLOCKED`, `DEFERRED` or `REROUTED`, and every
// transport one `DISPATCH`, appended to the world's `TAPE#` chain with `appendChained` (head, entry and
// anchor). `ALLOWED` carries the SHA-256 of the exact rendered body and is written BEFORE the
// transport. The customer is a keyed hash (`customerRef`), never the id in clear; a rule's detail and
// the text never reach the tape. Each entry also leaves the `outbound.decision` log line the
// `GateDecisions` metric filter counts (dimensions `decision`, `ruleId` and `sender`, read from the
// `senderClass` field: the logger masks any field named `sender` as an address).
import type { Channel, DispatchResult, MessageKind, Reroute, Sender, TapeEntryKind } from "@reclamo/shared";
import { senderClassOf } from "../channel-policy/kinds";
import { newIdOf } from "../complaints/deps";
import { appendChained } from "../complaints/register";
import type { CollectionCategory } from "../copy/types";
import type { TapeEntry } from "../domain/ledger";
import { hmacSha256Hex, sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { OutboundDeps } from "./deps";

export const GATE_DECISIONS_METRIC = "GateDecisions";

/** At most this many rule evaluations travel on an entry (the schema's bound). */
const MAX_EVALUATED = 60;

export interface TapeWrite {
  readonly worldId: string;
  readonly epoch: number;
  readonly atSim: string;
  readonly decision: TapeEntryKind;
  readonly result?: DispatchResult;
  readonly ruleIds: readonly string[];
  readonly evaluated?: readonly { readonly ruleId: string; readonly result: string }[];
  readonly ruleSetVersion: string;
  readonly sender: Sender;
  readonly channel: Channel;
  readonly kind: MessageKind;
  readonly customerId: string;
  readonly payloadHash?: string;
  readonly messageId?: string;
  readonly providerMessageId?: string;
  readonly complaintId?: string;
  readonly reroute?: { readonly route: Reroute; readonly childTapeId?: string };
  readonly rerouteOf?: string;
  readonly nextAllowedAt?: string;
  readonly collectionCategories?: readonly CollectionCategory[];
}

/** The customer as the tape names it: an HMAC with the chain key, never the id in clear. */
export function customerRefOf(chainKey: string, worldId: string, customerId: string): string {
  return hmacSha256Hex(chainKey, `customer-ref#${worldId}#${customerId}`).slice(0, 32);
}

/** SHA-256 of the exact rendered body: what `ALLOWED` and `PolicyAudit` compare. */
export function payloadHashOf(rendered: string | Uint8Array): string {
  return sha256Hex(rendered);
}

function logDecision(log: Logger, write: TapeWrite): void {
  log.info("outbound.decision", {
    metric: GATE_DECISIONS_METRIC,
    decision: write.decision,
    ...(write.result === undefined ? {} : { result: write.result }),
    ruleId: write.ruleIds[0] ?? "NONE",
    senderClass: senderClassOf(write.sender),
    channel: write.channel,
    kind: write.kind,
  });
}

/** Appends one entry to the world's tape (retried on a lost race, anchored after the commit). */
export async function appendTape(deps: Pick<OutboundDeps, "chains">, write: TapeWrite, log: Logger): Promise<TapeEntry> {
  const tapeId = newIdOf(deps.chains, "tp");
  const { entry } = await appendChained(deps.chains, {
    chain: "TAPE",
    worldId: write.worldId,
    epoch: write.epoch,
    build: () => ({
      entry: {
        atSim: write.atSim,
        tapeId,
        decision: write.decision,
        ruleIds: [...write.ruleIds],
        evaluated: (write.evaluated ?? []).slice(0, MAX_EVALUATED).map(({ ruleId, result }) => ({ ruleId, result })),
        ruleSetVersion: write.ruleSetVersion,
        sender: write.sender,
        channel: write.channel,
        kind: write.kind,
        customerRef: customerRefOf(deps.chains.chainKey, write.worldId, write.customerId),
        ...(write.result === undefined ? {} : { result: write.result }),
        ...(write.payloadHash === undefined ? {} : { payloadHash: write.payloadHash }),
        ...(write.messageId === undefined ? {} : { messageId: write.messageId }),
        ...(write.providerMessageId === undefined ? {} : { providerMessageId: write.providerMessageId }),
        ...(write.complaintId === undefined ? {} : { complaintId: write.complaintId }),
        ...(write.reroute === undefined ? {} : { reroute: write.reroute }),
        ...(write.rerouteOf === undefined ? {} : { rerouteOf: write.rerouteOf }),
        ...(write.nextAllowedAt === undefined ? {} : { nextAllowedAt: write.nextAllowedAt }),
        ...(write.collectionCategories === undefined || write.collectionCategories.length === 0 ? {} : { collectionCategories: [...write.collectionCategories] }),
      },
    }),
  });
  logDecision(log, write);
  return entry;
}
