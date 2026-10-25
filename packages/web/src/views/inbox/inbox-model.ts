// What the inbox does with the answer of `inbox.list` (FL-097, FL-077): the filters a person picks,
// applied in the browser so every option can say how many rows it would show; and the marks a row
// carries (the day-5 reminder already went to the operator). Pure, so it is unit-tested without React.
import type { ComplaintType, SlaState } from "@reclamo/shared";
import type { RouterOutputs } from "../../lib/trpc-router";
import type { BlockedByKey } from "./copy";

export type InboxAnswer = RouterOutputs["inbox"]["list"];
export type InboxItem = InboxAnswer["items"][number];
export type ControlKey = InboxItem["control"];

export const ALL = "ALL";
export type Choice<T extends string> = T | typeof ALL;

export interface InboxFilters {
  readonly blockedBy: Choice<BlockedByKey>;
  readonly sla: Choice<SlaState>;
  readonly type: Choice<ComplaintType>;
  readonly control: Choice<ControlKey>;
}

export const NO_FILTERS: InboxFilters = { blockedBy: ALL, sla: ALL, type: ALL, control: ALL };

type FilterKey = keyof InboxFilters;

function valueOf(item: InboxItem, key: FilterKey): string {
  switch (key) {
    case "blockedBy":
      return item.blockedBy;
    case "sla":
      return item.slaState;
    case "type":
      return item.type;
    case "control":
      return item.control;
  }
}

function passes(item: InboxItem, filters: InboxFilters, skip?: FilterKey): boolean {
  return (Object.keys(filters) as FilterKey[]).every((key) => key === skip || filters[key] === ALL || valueOf(item, key) === filters[key]);
}

/** The rows the filters leave, in the order the BFF sent them (main story first, then by deadline). */
export function applyFilters(items: readonly InboxItem[], filters: InboxFilters): InboxItem[] {
  return items.filter((item) => passes(item, filters));
}

/** How many rows each value of `key` would show with the other filters as they are (`ALL` included). */
export function countsFor(items: readonly InboxItem[], filters: InboxFilters, key: FilterKey): Readonly<Record<string, number>> {
  const counts: Record<string, number> = { [ALL]: 0 };
  for (const item of items) {
    if (!passes(item, filters, key)) continue;
    counts[ALL] = (counts[ALL] ?? 0) + 1;
    const value = valueOf(item, key);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** The complaint types present in the answer, in their first order: the type filter offers only those. */
export function typesOf(items: readonly InboxItem[]): ComplaintType[] {
  return [...new Set(items.map((item) => item.type))];
}

const CLOSED_STATUSES: ReadonlySet<InboxItem["status"]> = new Set(["ANSWERED", "CLOSED"]);

/**
 * FL-077: the operator's day-5 reminder already fired for an open complaint whose next milestone is a
 * later one (or none left before it was answered).
 */
export function reminderFired(item: InboxItem): boolean {
  if (item.kind !== "RECLAMO" || CLOSED_STATUSES.has(item.status)) return false;
  return item.nextMilestone === null || (item.nextMilestone.milestone !== null && item.nextMilestone.milestone !== "OPERATOR_REMINDER");
}
