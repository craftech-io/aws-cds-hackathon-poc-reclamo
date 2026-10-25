// Delivery statuses of our WhatsApp messages (docs/architecture-integrations.md §3.1, FL-103):
// `statuses[]` (`sent`, `delivered`, `read`, `failed` with `errors[]`, `pricing.category`) move the
// `Message OUT` forward and leave a `MessageEvent`. Live statuses arrive by SNS; the simulated
// transport builds the same `statuses[]` items and records them here, so both modes write identical
// events. A status only touches a message of the world it came for (FL-099). A template billed in a
// category other than `utility` is logged with its metric (an alarm reads it); a failure is logged
// with Meta's error code and title, never with the recipient.
import type { MessageEvent, MessageStatus, Message } from "../../domain/conversation";
import type { Connector } from "../../connector/port";
import type { NewOf } from "../../connector/codec";
import { isConflict } from "../../connector/errors";
import { sha256Hex } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import type { JsonObject } from "../../domain/common";
import { type WaStatus, type WaStatusValue, instantOf } from "./payloads";

/** Log `metric` fields the metric filters count (docs/architecture.md §12). */
export const WHATSAPP_METRICS = {
  pricingCategory: "WhatsAppPricingCategory",
  sendFailed: "WhatsAppSendFailed",
  unknownStatus: "WhatsAppStatusUnknownMessage",
} as const;

/** The only category a template send may be billed in (every template is `UTILITY`). */
export const EXPECTED_TEMPLATE_CATEGORY = "utility";

const EVENT_TYPE: Readonly<Record<WaStatusValue, MessageStatus>> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

/** How far a status has gone: a late `delivered` never takes a `read` message back. */
const RANK: Readonly<Partial<Record<MessageStatus, number>>> = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/** `wa-<status>-<sha of the id>`: the same status of the same message is recorded once. */
export function statusEventId(status: Pick<WaStatus, "id" | "status">): string {
  return `wa-${status.status}-${sha256Hex(status.id).slice(0, 40)}`;
}

function detailOf(status: WaStatus, extra: JsonObject = {}): JsonObject {
  const error = status.errors?.[0];
  return {
    ...(status.pricing?.category === undefined ? {} : { pricingCategory: status.pricing.category }),
    ...(error === undefined ? {} : { errorCode: error.code, ...(error.title === undefined ? {} : { errorTitle: error.title }) }),
    ...extra,
  };
}

/** The `MessageEvent` of one status of a message, live or simulated. */
export function messageEventOf(status: WaStatus, message: Pick<Message, "worldId" | "customerId" | "messageId">, simulated: boolean, extra: JsonObject = {}): NewOf<typeof MessageEvent> {
  return {
    worldId: message.worldId,
    customerId: message.customerId,
    eventId: statusEventId(status),
    // No `providerMessageId` here: that attribute feeds the index that finds the MESSAGE of a status.
    messageId: message.messageId,
    type: EVENT_TYPE[status.status],
    atReal: instantOf(status.timestamp),
    detail: detailOf(status, { simulated, ...extra }),
  };
}

/** The status the message moves to, or `undefined` when this one would take it back. */
export function nextStatus(current: MessageStatus, status: WaStatusValue): MessageStatus | undefined {
  const target = EVENT_TYPE[status];
  if (target === "FAILED") return current === "READ" || current === "FAILED" ? undefined : "FAILED";
  const from = RANK[current];
  const to = RANK[target];
  if (from === undefined || to === undefined) return undefined;
  return to > from ? target : undefined;
}

export type StatusOutcome =
  | { readonly outcome: "APPLIED"; readonly messageId: string; readonly status: MessageStatus }
  | { readonly outcome: "UNCHANGED" | "DUPLICATE"; readonly messageId: string }
  | { readonly outcome: "UNKNOWN_MESSAGE" | "FOREIGN_WORLD" };

export interface StatusDeps {
  readonly data: Pick<Connector, "conversations" | "write">;
  readonly log: Logger;
}

/** Which world a status may touch: the simulated envelope's world, or any live world. */
export type StatusScope = { readonly simulated: true; readonly worldId: string } | { readonly simulated: false; readonly isLiveWorld: (worldId: string) => Promise<boolean> };

function alarmOn(status: WaStatus, message: Message, log: Logger): void {
  const refs = { worldId: message.worldId, messageId: message.messageId };
  const category = status.pricing?.category;
  if (message.templateName !== undefined && category !== undefined && category.toLowerCase() !== EXPECTED_TEMPLATE_CATEGORY) {
    log.error("whatsapp.template_billed_outside_utility", { metric: WHATSAPP_METRICS.pricingCategory, category, template: message.templateName, ...refs });
  }
  if (status.status === "failed") {
    const error = status.errors?.[0];
    log.error("whatsapp.send_failed", { metric: WHATSAPP_METRICS.sendFailed, errorCode: error?.code, errorTitle: error?.title, ...refs });
  }
}

async function inScope(message: Message, scope: StatusScope): Promise<boolean> {
  if (scope.simulated) return message.simulated && message.worldId === scope.worldId;
  return !message.simulated && (await scope.isLiveWorld(message.worldId));
}

/** Applies one status to the outbound WhatsApp message it names. */
export async function applyStatus(status: WaStatus, deps: StatusDeps, scope: StatusScope): Promise<StatusOutcome> {
  const match = await deps.data.conversations.findByProviderMessageId(status.id);
  const message = match?.kind === "MESSAGE" ? match.message : undefined;
  if (message === undefined || message.direction !== "OUT" || message.channel !== "WHATSAPP") {
    deps.log.warn("whatsapp.status_unknown_message", { metric: WHATSAPP_METRICS.unknownStatus, status: status.status });
    return { outcome: "UNKNOWN_MESSAGE" };
  }
  if (!(await inScope(message, scope))) {
    deps.log.warn("whatsapp.status_foreign_world", { status: status.status, simulated: scope.simulated });
    return { outcome: "FOREIGN_WORLD" };
  }
  try {
    await deps.data.write(deps.data.conversations.putEventOp(messageEventOf(status, message, scope.simulated)));
  } catch (error) {
    if (!isConflict(error)) throw error;
    return { outcome: "DUPLICATE", messageId: message.messageId };
  }
  alarmOn(status, message, deps.log);
  const next = nextStatus(message.status, status.status);
  if (next === undefined) return { outcome: "UNCHANGED", messageId: message.messageId };
  await deps.data.conversations.updateMessage({ worldId: message.worldId, customerId: message.customerId, atSim: message.atSim, messageId: message.messageId }, { status: next });
  return { outcome: "APPLIED", messageId: message.messageId, status: next };
}

/** Applies the statuses of one webhook entry in the order Meta sent them. */
export async function applyStatuses(statuses: readonly WaStatus[], deps: StatusDeps, scope: StatusScope): Promise<StatusOutcome[]> {
  const outcomes: StatusOutcome[] = [];
  for (const status of statuses) outcomes.push(await applyStatus(status, deps, scope));
  return outcomes;
}
