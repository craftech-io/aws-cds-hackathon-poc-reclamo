// What the case's timeline needs beyond the BFF's list (FL-067, FL-084, FL-085): a stable key per
// item, which blocks of the tape a person already answered with a reroute, the tape entry of an item
// in the shape the banner draws, who acted (never a staff id on screen), and the collection
// categories the lexicon finds in a blocked attempt. Pure, unit-tested without React.
import { COLLECTION_CATEGORY_LABEL } from "@reclamo/bff/copy/index";
import { classifyCollection } from "@reclamo/bff/channel-policy/collection-lexicon";
import type { BannerEntry } from "../customer/TapeBanner";
import type { TimelineItem } from "./api";

export type TapeItem = Extract<TimelineItem, { type: "TAPE" }>;
export type MessageItem = Extract<TimelineItem, { type: "MESSAGE" }>;

export function itemKey(item: TimelineItem): string {
  switch (item.type) {
    case "MESSAGE":
      return `msg-${item.messageId}-${item.status}`;
    case "EMAIL":
      return `mail-${item.mailId}`;
    case "TAPE":
      return `tape-${item.tapeId}`;
    case "MILESTONE":
      return `timer-${item.timerId}`;
    case "REGISTER":
      return `reg-${item.seq}`;
    case "NOTE":
      return `note-${item.noteId}`;
    case "STATUS":
      return `status-${item.atSim}-${item.to}`;
    case "ACTION":
      return `action-${item.atSim}-${item.action}-${Object.values(item.refs).join("-")}`;
  }
}

/** The `BLOCKED` entries of the tape that already have their `REROUTED`. */
export function reroutedBlocks(items: readonly TimelineItem[]): ReadonlySet<string> {
  const answered = new Set<string>();
  for (const item of items) if (item.type === "TAPE" && item.decision === "REROUTED" && item.rerouteOf !== null) answered.add(item.rerouteOf);
  return answered;
}

/** A tape item as the banner draws it. */
export function bannerEntryOf(item: TapeItem): BannerEntry {
  return { decision: item.decision, ruleIds: item.ruleIds, sender: item.sender, channel: item.channel, kind: item.kind, atSim: item.atSim, result: item.result, nextAllowedAt: item.nextAllowedAt };
}

/** A block a person may still reroute from the case: a person's own message, not yet rerouted, not a reroute's child. */
export function isOpenOperatorBlock(item: TapeItem, answered: ReadonlySet<string>): boolean {
  return item.decision === "BLOCKED" && item.sender.startsWith("OPERATOR:") && item.rerouteOf === null && !answered.has(item.tapeId);
}

export type ActorKind = "CUSTOMER" | "AGENT" | "SYSTEM" | "PERSON" | "QA";

/** Who acted, as a class: the console never prints a staff id. */
export function actorKindOf(actor: string | null, direction?: "IN" | "OUT"): ActorKind {
  if (direction === "IN") return "CUSTOMER";
  if (actor === null || actor === "SYSTEM") return "SYSTEM";
  if (actor === "AGENT") return "AGENT";
  if (actor === "QA") return "QA";
  return "PERSON";
}

/** The collection categories of a blocked attempt, in the console's words (empty for a service text). */
export function lexiconLabels(text: string): string[] {
  return classifyCollection(text).categories.map((category) => COLLECTION_CATEGORY_LABEL[category]);
}

/** Short form of a hash for the screen; the full value stays in the register and its export. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 12)}…` : hash;
}
