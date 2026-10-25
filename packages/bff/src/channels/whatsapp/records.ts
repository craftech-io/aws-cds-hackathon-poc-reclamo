// What the inbound adapter records itself (docs/architecture.md §5): the `Message IN` (masked body,
// never a raw payload), the customer's 24-hour window on the conversation (created on the first
// message, FL-001), and its decisions in `AuditLog` (`DENY UNKNOWN_SENDER`, `DENY RATE_LIMIT`,
// `DENY NONCE_*`, `INBOUND_REJECTED`, `WORLD_RESETTING`, `MEDIA_KEY_UNRESOLVED`). Every id is derived
// from the world and the `wamid`, so a redelivery writes nothing twice.
import { ConnectorError } from "@reclamo/shared";
import type { NewOf } from "../../connector/codec";
import { isConflict } from "../../connector/errors";
import type { Connector } from "../../connector/port";
import type { JsonObject } from "../../domain/common";
import type { Message } from "../../domain/conversation";
import { sha256Hex } from "../../lib/crypto";
import { INBOUND_RECEIPT_SOURCE, WINDOW_MS } from "./config";
import { deliveryKey } from "../rate-limit";

/** `wa-<kind>-<24 hex>`: the id of a message derived from the world and the inbound `wamid`. */
export function derivedMessageId(worldId: string, wamid: string, kind: "in" | "re"): string {
  return `wa-${kind}-${sha256Hex(`${worldId}#${wamid}`).slice(0, 24)}`;
}

/**
 * The simulated instant of an inbound message: taken once, at its first delivery, and reused by
 * every redelivery so the `Message IN` key (and what hangs from it) is the same.
 */
export async function receiptInstant(data: Pick<Connector, "claims">, worldId: string, wamid: string, simNow: Date): Promise<string> {
  const atSim = simNow.toISOString();
  const claim = await data.claims.claimOnce(worldId, INBOUND_RECEIPT_SOURCE, deliveryKey(wamid), { atSim });
  if (claim.first) return atSim;
  const stored = claim.existing.result?.atSim;
  return typeof stored === "string" ? stored : atSim;
}

/** Opens (or extends) the customer's window; the conversation is created on the first message. */
export async function openWindow(data: Pick<Connector, "conversations">, input: { readonly worldId: string; readonly customerId: string; readonly atSim: string }): Promise<void> {
  const until = new Date(Date.parse(input.atSim) + WINDOW_MS).toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const meta = await data.conversations.getMeta(input.worldId, input.customerId, { consistent: true });
    try {
      if (meta === undefined) {
        await data.conversations.create({
          worldId: input.worldId,
          customerId: input.customerId,
          control: "AGENT",
          controlHistory: [],
          sessionEpoch: 0,
          disclosedEpochs: [],
          openComplaintIds: [],
          windowOpenUntilSim: until,
          lastInboundAtSim: input.atSim,
        });
        return;
      }
      const later = meta.windowOpenUntilSim !== undefined && Date.parse(meta.windowOpenUntilSim) > Date.parse(until) ? meta.windowOpenUntilSim : until;
      await data.conversations.updateMeta(input.worldId, input.customerId, meta.version, { windowOpenUntilSim: later, lastInboundAtSim: input.atSim });
      return;
    } catch (error) {
      // Another message of the same customer (or a take-over) moved the conversation: read it again.
      if (!isConflict(error)) throw error;
    }
  }
  throw new ConnectorError("CONFLICT", "the conversation kept changing while its window was opened", "Conversations");
}

export type InboundMessageInput = Pick<Message, "worldId" | "customerId" | "messageId" | "body" | "simulated" | "atSim"> & {
  readonly wamid: string;
  readonly interactive?: JsonObject;
  readonly media?: Message["media"];
};

/** The `Message IN`, written once (a redelivery finds it and moves on). */
export async function appendInbound(data: Pick<Connector, "conversations">, input: InboundMessageInput): Promise<void> {
  const message: NewOf<typeof Message> = {
    worldId: input.worldId,
    customerId: input.customerId,
    messageId: input.messageId,
    direction: "IN",
    channel: "WHATSAPP",
    body: input.body,
    providerMessageId: input.wamid,
    status: "RECEIVED",
    simulated: input.simulated,
    atSim: input.atSim,
    flags: {},
    ...(input.interactive === undefined ? {} : { interactive: input.interactive }),
    ...(input.media === undefined ? {} : { media: input.media }),
  };
  try {
    await data.conversations.putMessage(message);
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

export interface DecisionInput {
  readonly worldId: string;
  readonly epoch: number;
  readonly action: string;
  readonly outcome: string;
  readonly wamid: string;
  readonly at: Date;
  readonly atSim?: string;
  readonly customerId?: string;
  readonly messageId?: string;
  readonly detail?: JsonObject;
}

/** One `AuditLog` entry of the adapter (`actor SYSTEM`); the same decision on the same `wamid` is written once. */
export async function recordDecision(data: Pick<Connector, "audit">, input: DecisionInput): Promise<void> {
  const auditId = `wa-${sha256Hex(`${input.worldId}#${input.wamid}#${input.action}#${input.outcome}`).slice(0, 32)}`;
  try {
    await data.audit.append({
      worldId: input.worldId,
      epoch: input.epoch,
      auditId,
      ts: input.at.toISOString(),
      action: input.action,
      actor: "SYSTEM",
      outcome: input.outcome,
      refs: { channel: "WHATSAPP", ...(input.messageId === undefined ? {} : { messageId: input.messageId }), ...(input.customerId === undefined ? {} : { customerId: input.customerId }) },
      ...(input.customerId === undefined ? {} : { primaryRef: `CUS#${input.customerId}` }),
      ...(input.atSim === undefined ? {} : { atSim: input.atSim }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}
