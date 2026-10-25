// `Timers`: everything that happens at a simulated hour (docs/architecture.md §10). A scheduled timer
// is in the sparse `ClockDue` index (what `advance_clock` dispatches, in `dueAtSim` and `seq` order)
// and, with an owner, in `ByOwner` (a complaint's milestones, a batch's rechecks). A status change is
// conditional on status, version and epoch, which is what discards a late or repeated fire.
import { ConnectorError, type TimerFiredBy } from "@reclamo/shared";
import { Timer, type TimerStatus } from "../../domain/timer";
import { type NewOf, type RepoContext, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { keys, sortInstant, worldIndexAttributes, worldKey } from "../keys";
import { type Condition, type StoredItem, type WriteOp, cond } from "../store";

const TABLE = "Timers" as const;

export interface TimerRef {
  readonly worldId: string;
  readonly kind: string;
  readonly timerId: string;
}

export interface TimerTransition extends TimerRef {
  readonly version: number;
  readonly from: readonly TimerStatus[];
  readonly to: TimerStatus;
  /** When given, the timer must belong to this epoch. */
  readonly epoch?: number;
  readonly firedBy?: TimerFiredBy;
  readonly firedAtSim?: string;
  readonly reason?: string;
}

/** `<dueAtSim UTC>#<seq>`: the order `advance_clock` dispatches in. */
function dueSort(dueAtSim: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > 999_999_998) throw new ConnectorError("VALIDATION", `invalid timer seq ${seq}`, TABLE);
  return `${sortInstant(dueAtSim)}#${seq.toString().padStart(9, "0")}`;
}

export function timersRepo(ctx: RepoContext) {
  const decodeAll = (items: readonly StoredItem[]) => items.map((item) => decode(Timer, item, TABLE));

  const putOp = (timer: NewOf<typeof Timer>, options: { replace?: boolean } = {}): WriteOp => {
    const value = validInput(Timer, { ...timer, version: 1 }, TABLE);
    const key = keys.timer(value.worldId, value.kind, value.timerId);
    const item = encode(value, {
      entity: "Timer",
      key,
      worldId: value.worldId,
      retention: "timer",
      now: ctx.now(),
      indexes: {
        dueSort: dueSort(value.dueAtSim, value.seq),
        clockDueKey: value.status === "SCHEDULED" ? worldKey(value.worldId, "CLOCKDUE") : undefined,
        ownerIndexKey: value.ownerKey ? worldKey(value.worldId, value.ownerKey) : undefined,
        ...worldIndexAttributes(value.worldId, key),
      },
    });
    return { kind: "put", table: TABLE, item, ...(options.replace ? {} : { condition: cond.absent() }) };
  };

  const transitionOp = (request: TimerTransition): WriteOp => {
    if (request.from.length === 0) throw new RangeError("a timer transition needs at least one origin status");
    const conditions: Condition[] = [cond.eq("version", request.version), cond.in("status", request.from)];
    if (request.epoch !== undefined) conditions.push(cond.eq("epoch", request.epoch));
    return {
      kind: "update",
      table: TABLE,
      key: keys.timer(request.worldId, request.kind, request.timerId),
      condition: cond.and(...conditions),
      update: {
        set: {
          status: request.to,
          firedBy: request.firedBy,
          firedAtSim: request.firedAtSim,
          reason: request.reason,
          version: request.version + 1,
          updatedAt: ctx.now().toISOString(),
          ...(request.to === "SCHEDULED" ? { clockDueKey: worldKey(request.worldId, "CLOCKDUE") } : {}),
        },
        ...(request.to === "SCHEDULED" ? {} : { remove: ["clockDueKey"] }),
      },
    };
  };

  return {
    /** A new timer (`attribute_not_exists`), or the factory's idempotent rewrite with `replace`. */
    putOp,
    async put(timer: NewOf<typeof Timer>, options: { replace?: boolean } = {}): Promise<void> {
      await ctx.store.write(putOp(timer, options));
    },

    async get(ref: TimerRef, options: { consistent?: boolean } = {}): Promise<Timer | undefined> {
      return decodeOptional(Timer, await ctx.store.get(TABLE, keys.timer(ref.worldId, ref.kind, ref.timerId), options), TABLE);
    },

    /** A timer by its `timerKey` (`W#<w>#TIMER#<kind>#<id>`), as `ScheduleDispatch` receives it; strongly consistent. */
    async getByKey(worldId: string, timerKey: string): Promise<Timer | undefined> {
      const [, , marker, kind, timerId, ...rest] = timerKey.split("#");
      if (marker !== "TIMER" || !kind || !timerId || rest.length > 0 || keys.timerKey(worldId, kind, timerId) !== timerKey) {
        throw new ConnectorError("VALIDATION", "invalid timer key", TABLE);
      }
      return decodeOptional(Timer, await ctx.store.get(TABLE, keys.timer(worldId, kind, timerId), { consistent: true }), TABLE);
    },

    timerKey: (ref: TimerRef): string => keys.timerKey(ref.worldId, ref.kind, ref.timerId),

    /** `SCHEDULED → FIRED | CANCELLED | SKIPPED | DISCARDED` (or back), on status, version and epoch. */
    transitionOp,
    async transition(request: TimerTransition): Promise<Timer> {
      return decode(Timer, (await ctx.store.write(transitionOp(request))) as StoredItem, TABLE);
    },

    /** Moves a scheduled timer or records its Scheduler schedule (`scheduleName: null` removes it). */
    rescheduleOp(ref: TimerRef & { version: number; due?: { atSim: string; seq: number }; scheduleName?: string | null }): WriteOp {
      const timing = ref.due ? { dueAtSim: ref.due.atSim, seq: ref.due.seq, dueSort: dueSort(ref.due.atSim, ref.due.seq) } : {};
      return {
        kind: "update",
        table: TABLE,
        key: keys.timer(ref.worldId, ref.kind, ref.timerId),
        condition: cond.and(cond.eq("version", ref.version), cond.eq("status", "SCHEDULED")),
        update: {
          set: { ...timing, ...(ref.scheduleName ? { scheduleName: ref.scheduleName } : {}), version: ref.version + 1, updatedAt: ctx.now().toISOString() },
          ...(ref.scheduleName === null ? { remove: ["scheduleName"] } : {}),
        },
      };
    },

    /** Scheduled timers due at or before `untilSim` (all when absent), in `dueAtSim` and `seq` order. */
    async listDue(worldId: string, options: { untilSim?: string; limit?: number } = {}): Promise<Timer[]> {
      const page = await ctx.store.query({
        table: TABLE,
        index: "ClockDue",
        partition: worldKey(worldId, "CLOCKDUE"),
        ...(options.untilSim ? { sort: { op: "le" as const, value: `${sortInstant(options.untilSim)}#999999999` } } : {}),
        limit: options.limit ?? 100,
      });
      return decodeAll(page.items);
    },

    /** The next scheduled timer of the world. */
    async next(worldId: string): Promise<Timer | undefined> {
      const page = await ctx.store.query({ table: TABLE, index: "ClockDue", partition: worldKey(worldId, "CLOCKDUE"), limit: 1 });
      return page.items[0] ? decode(Timer, page.items[0], TABLE) : undefined;
    },

    /** The timers of one owner (`CMP#<id>`, `BATCH#<network>#<date>`), in due order (index `ByOwner`). */
    async listByOwner(worldId: string, ownerKey: string): Promise<Timer[]> {
      return decodeAll(await queryAll(ctx.store, { table: TABLE, index: "ByOwner", partition: worldKey(worldId, ownerKey) }));
    },
  };
}

export type TimersRepo = ReturnType<typeof timersRepo>;
