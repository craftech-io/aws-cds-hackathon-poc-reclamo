// The order of a complaint's timeline (docs/design-brief.md §9 "línea de tiempo unificada"). With the
// world clock paused every event of a turn shares its simulated instant, so the simulated time alone
// says nothing about what came first. Every entry gets one sort key, so the order is total and never
// depends on the order the rows came in:
//
//   1. the simulated instant;
//   2. rows with the real instant they were written (`createdAt`, `atReal`, the audit's `ts`) before
//      rows without one (milestones): a milestone sits after everything that happened in its minute;
//   3. that real instant;
//   4. with the same real instant (a fixed clock), a rank by type: the customer's message before what it
//      caused (the filing, the tape decision, the answer, its email, the tools and actions, notes);
//   5. the tape or register sequence, the type and the item's own id.
//
// Then two kinds of rows are moved next to the row they belong to, as a pair: a tape decision right
// before the message it is about, and a status change right after the register entry that recorded it
// (a status change has no real instant of its own; the register entry, written in the same transaction,
// does). It is the same "arrival order" the phone simulator shows (views/simulator/simulator-model.ts).

export interface TimelineEntry<T> {
  readonly item: T;
  readonly atSim: string;
  readonly type: string;
  readonly direction?: string | undefined;
  /** Real instant the row was written, when it has one. */
  readonly real?: string | undefined;
  readonly seq?: number | undefined;
  /** The message a tape decision is about, or the message's own id. */
  readonly messageId?: string | null | undefined;
  /** The id of the entry this one sits right after (a status change after its register entry). */
  readonly follows?: string | undefined;
  /** A stable id for the last tie-break. */
  readonly id: string;
}

const RANK: Readonly<Record<string, number>> = {
  MESSAGE_IN: 0,
  REGISTER: 1,
  STATUS: 2,
  TAPE: 3,
  MESSAGE_OUT: 4,
  EMAIL: 5,
  ACTION: 6,
  NOTE: 7,
  MILESTONE: 8,
};

function rankOf(entry: TimelineEntry<unknown>): number {
  const key = entry.type === "MESSAGE" ? `MESSAGE_${entry.direction === "IN" ? "IN" : "OUT"}` : entry.type;
  return RANK[key] ?? 9;
}

type SortKey = readonly [number, number, number, number, number, string, string];

function keyOf(entry: TimelineEntry<unknown>): SortKey {
  const real = entry.real === undefined ? Number.NaN : Date.parse(entry.real);
  const timed = Number.isNaN(real) ? 1 : 0;
  const sim = Date.parse(entry.atSim);
  return [Number.isNaN(sim) ? 0 : sim, timed, timed ? 0 : real, rankOf(entry), entry.seq ?? 0, entry.type, entry.id];
}

function compareKeys(a: SortKey, b: SortKey): number {
  for (let index = 0; index < a.length; index += 1) {
    const [x, y] = [a[index] as number | string, b[index] as number | string];
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The items in timeline order (see the header). */
export function orderTimeline<E extends TimelineEntry<unknown>>(entries: readonly E[]): E["item"][] {
  const sorted = entries.map((entry) => ({ entry, key: keyOf(entry) })).sort((a, b) => compareKeys(a.key, b.key)).map(({ entry }) => entry);
  const ids = new Set(sorted.map((entry) => entry.id));
  const messages = new Set(sorted.filter((entry) => entry.type === "MESSAGE" && entry.messageId).map((entry) => entry.messageId));
  const before = new Map<string, E[]>();
  const after = new Map<string, E[]>();
  const placed = new Set<E>();
  for (const entry of sorted) {
    if (entry.type === "TAPE" && entry.messageId && messages.has(entry.messageId)) {
      before.set(entry.messageId, [...(before.get(entry.messageId) ?? []), entry]);
      placed.add(entry);
    } else if (entry.follows !== undefined && entry.follows !== entry.id && ids.has(entry.follows)) {
      after.set(entry.follows, [...(after.get(entry.follows) ?? []), entry]);
      placed.add(entry);
    }
  }
  return sorted.flatMap((entry) => {
    if (placed.has(entry)) return [];
    const leading = entry.type === "MESSAGE" && entry.messageId ? (before.get(entry.messageId) ?? []) : [];
    return [...leading, entry, ...(after.get(entry.id) ?? [])].map((one) => one.item);
  });
}

/** A status change of `statusHistory` and the register entries of the complaint, as the router lists them. */
interface StatusRow {
  readonly to: string;
  readonly atSim: string;
}

interface RegisterRow {
  readonly id: string;
  readonly seq: number;
  readonly status?: string | null | undefined;
  readonly atSim: string;
}

/**
 * The register entry that recorded each status change (same new status and simulated instant, each
 * entry used once, in register order); `undefined` for a change no entry recorded.
 */
export function pairStatusChanges(changes: readonly StatusRow[], register: readonly RegisterRow[]): (string | undefined)[] {
  const pool = [...register].filter((entry) => entry.status).sort((a, b) => a.seq - b.seq);
  const used = new Set<string>();
  return changes.map((change) => {
    const match = pool.find((entry) => !used.has(entry.id) && entry.status === change.to && Date.parse(entry.atSim) === Date.parse(change.atSim));
    if (match === undefined) return undefined;
    used.add(match.id);
    return match.id;
  });
}
