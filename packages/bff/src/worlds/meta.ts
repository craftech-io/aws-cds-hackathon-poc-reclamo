// Conditional changes of a world's `META` and the self-signup queue (docs/architecture.md §10,
// docs/architecture-guests.md §5): every status change names the status it leaves, so two factories,
// two resets or a reset and an expiry never interleave, and a `gs-*` world moves in the sparse
// `GuestIndex` (`GUEST#<status>` + `<atReal>#<worldId>`) in the same write. The capacity of the
// self-signup worlds is `Runtime/GUESTCAP#ACTIVE = {active, creating}`, moved with conditional `ADD`s
// in the same transaction as the status it counts. The scenario runner's sign-up worlds
// (`qa-<runId>-su<n>`) have a queue (`GUEST#QA#<status>`) and a capacity (`GUESTCAP#QA`) of their own,
// so a run never takes or sees a visitor's place. The QA driver can lower that limit (`caps.prime`), but
// only for the worlds of its own run and only for an hour: another run, and the next one, never see it.
import { type SignupWorldClass, signupWorldClassOf } from "@reclamo/shared";
import { TransactionCancelledError } from "../connector/errors";
import { keys } from "../connector/keys";
import { type Condition, type Key, type StoredItem, type WriteOp, cond } from "../connector/store";
import type { WorldStatus } from "../domain/world";
import { GUEST_WORLD_LIMITS, QA_GUEST_WORLD_LIMITS } from "../leads/limits";
import type { WorldsDeps } from "./deps";

export const GUEST_CAP_KEY: Key = keys.global("GUESTCAP", "ACTIVE");
export const QA_GUEST_CAP_KEY: Key = keys.global("GUESTCAP", "QA");

const CAPACITY: Readonly<Record<SignupWorldClass, { readonly key: Key; readonly queue: string; readonly limits: { readonly activeWorlds: number; readonly simultaneousCreations: number } }>> = {
  SIGNUP: { key: GUEST_CAP_KEY, queue: "GUEST", limits: GUEST_WORLD_LIMITS },
  QA: { key: QA_GUEST_CAP_KEY, queue: "GUEST#QA", limits: QA_GUEST_WORLD_LIMITS },
};

export const SIGNUP_WORLD_CLASSES: readonly SignupWorldClass[] = ["SIGNUP", "QA"];

/** Statuses that hold an active place (`CREATING` also holds a creation slot). */
export const COUNTED_STATUSES: readonly string[] = ["CREATING", "READY", "EXPIRING", "RESETTING"];

/** The run of a scenario runner's sign-up world (`qa-<runId>-su<n>`), `undefined` for any other world. */
export function qaSignupRunOf(worldId: string): string | undefined {
  return signupWorldClassOf(worldId) === "QA" ? /^qa-(.+)-su\d{1,3}$/.exec(worldId)?.[1] : undefined;
}

/** The `GuestIndex` partition of a class's worlds in one status. */
export function guestQueuePartition(worldClass: SignupWorldClass, status: string): string {
  return `${CAPACITY[worldClass].queue}#${status}`;
}

/** `GUEST#<status>` (or `GUEST#QA#<status>`) + `<atReal>#<worldId>` of a self-signup world; nothing for any other world. */
export function guestQueueAttributes(worldId: string, status: string, atReal: string): Record<string, string> {
  const worldClass = signupWorldClassOf(worldId);
  if (worldClass === undefined) return {};
  return { guestIndexKey: guestQueuePartition(worldClass, status), guestIndexSort: `${atReal}#${worldId}` };
}

const HEAL_AFTER_MS = 10 * 60_000;

export interface MetaUpdate {
  readonly worldId: string;
  readonly from: WorldStatus | readonly WorldStatus[];
  readonly to?: WorldStatus;
  /** Only while this reset (or expiry) request is the world's. */
  readonly resetRequestId?: string;
  /** Only while this provisioning request is the world's. */
  readonly provisionRequestId?: string;
  /** Only while no reset or expiry request is the world's. */
  readonly withoutReset?: true;
  readonly set?: Readonly<Record<string, unknown>>;
  readonly remove?: readonly string[];
}

/** One conditional update of `META` (raw: the factory owns fields the domain schema does not list). */
export function metaUpdateOp(deps: Pick<WorldsDeps, "now">, change: MetaUpdate): WriteOp {
  const at = deps.now().toISOString();
  const from = typeof change.from === "string" ? [change.from] : change.from;
  const conditions: Condition[] = [cond.present(), cond.in("status", from)];
  if (change.resetRequestId !== undefined) conditions.push(cond.eq("reset.requestId", change.resetRequestId));
  if (change.provisionRequestId !== undefined) conditions.push(cond.eq("provisionRequestId", change.provisionRequestId));
  if (change.withoutReset) conditions.push(cond.notExists("reset"));
  const queue = change.to ? guestQueueAttributes(change.worldId, change.to, at) : {};
  return {
    kind: "update",
    table: "Worlds",
    key: keys.worldMeta(change.worldId),
    condition: cond.and(...conditions),
    update: {
      set: { ...change.set, ...(change.to ? { status: change.to } : {}), ...queue, updatedAt: at },
      add: { version: 1 },
      ...(change.remove && change.remove.length > 0 ? { remove: [...change.remove] } : {}),
    },
  };
}

/** `META` as stored, with the factory's own fields (`provisionRequestId`, `creatingAtReal`…). */
export async function rawMeta(deps: Pick<WorldsDeps, "store">, worldId: string): Promise<StoredItem | undefined> {
  return deps.store.get("Worlds", keys.worldMeta(worldId), { consistent: true });
}

/**
 * `REGISTERED → CREATING` takes one active place and one creation slot of the world's class, only below
 * both limits. A QA world's limit is the one `read` saw for its run, and only while nobody primed again.
 */
export function takeCapacityOp(deps: Pick<WorldsDeps, "now">, worldId: string, read?: GuestCapacity): WriteOp {
  const worldClass = signupWorldClassOf(worldId) ?? "SIGNUP";
  const below = (path: string, limit: number) => cond.or(cond.notExists(path), cond.lt(path, limit));
  const { limits } = CAPACITY[worldClass];
  const limit = read && worldClass === "QA" ? activeLimitFor(read, worldId, deps.now()) : limits.activeWorlds;
  const conditions = [below("active", limit), below("creating", limits.simultaneousCreations)];
  // Every prime writes a new `limitUntilReal`: a prime written after `read` is honoured on the next try.
  if (worldClass === "QA") conditions.push(read?.primeStamp === undefined ? cond.notExists("limitUntilReal") : cond.eq("limitUntilReal", read.primeStamp));
  return {
    kind: "update",
    table: "Runtime",
    key: CAPACITY[worldClass].key,
    condition: cond.and(...conditions),
    update: { add: { active: 1, creating: 1, version: 1 }, set: { entity: "GuestCapacity", updatedAt: deps.now().toISOString() } },
  };
}

/** A creation ended (`creating − 1`), a world left the active ones (`active − 1`), or both. */
export function releaseCapacityOp(deps: Pick<WorldsDeps, "now">, release: { readonly creating?: boolean; readonly active?: boolean }, worldClass: SignupWorldClass = "SIGNUP"): WriteOp {
  return {
    kind: "update",
    table: "Runtime",
    key: CAPACITY[worldClass].key,
    condition: cond.present(),
    update: { add: { ...(release.creating ? { creating: -1 } : {}), ...(release.active ? { active: -1 } : {}), version: 1 }, set: { updatedAt: deps.now().toISOString() } },
  };
}

export interface GuestCapacity {
  readonly worldClass: SignupWorldClass;
  readonly active: number;
  readonly creating: number;
  readonly version: number;
  /** Active places of the class (its fixed limit; a QA prime lowers it for its run only, `activeLimitFor`). */
  readonly activeLimit: number;
  readonly creatingLimit: number;
  /** The QA limit `caps.prime(GUESTCAP_QA)` wrote (never read on the visitors' row). */
  readonly prime?: QaCapacityPrime;
  /** `limitUntilReal` as stored, well formed or not: the identity of the last prime. */
  readonly primeStamp?: string;
  /** Last change (real); a count is healed only when nothing moved it for a while. */
  readonly updatedAt?: string;
}

/** A lowered QA limit: for the worlds of one run, until `untilReal`. */
export interface QaCapacityPrime {
  readonly limit: number;
  readonly runId: string;
  readonly untilReal: string;
}

function primeOf(item: StoredItem | undefined): QaCapacityPrime | undefined {
  if (item === undefined) return undefined;
  const { limit, limitRunId, limitUntilReal } = item;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) return undefined;
  if (typeof limitRunId !== "string" || typeof limitUntilReal !== "string" || Number.isNaN(Date.parse(limitUntilReal))) return undefined;
  return { limit, runId: limitRunId, untilReal: limitUntilReal };
}

export async function readCapacity(deps: Pick<WorldsDeps, "store">, worldClass: SignupWorldClass = "SIGNUP"): Promise<GuestCapacity> {
  const { key, limits } = CAPACITY[worldClass];
  const item = await deps.store.get("Runtime", key, { consistent: true });
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const prime = worldClass === "QA" ? primeOf(item) : undefined;
  const stamp = worldClass === "QA" && typeof item?.limitUntilReal === "string" ? item.limitUntilReal : undefined;
  return {
    worldClass,
    active: count(item?.active),
    creating: count(item?.creating),
    version: count(item?.version),
    activeLimit: limits.activeWorlds,
    creatingLimit: limits.simultaneousCreations,
    ...(prime === undefined ? {} : { prime }),
    ...(stamp === undefined ? {} : { primeStamp: stamp }),
    ...(typeof item?.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
  };
}

/** The active places `worldId` may count on now: a live prime of its own run, or the class's limit. */
export function activeLimitFor(read: GuestCapacity, worldId: string, now: Date): number {
  const { prime } = read;
  const binds = prime !== undefined && prime.runId === qaSignupRunOf(worldId) && Date.parse(prime.untilReal) > now.getTime();
  return binds ? prime.limit : read.activeLimit;
}

/** `caps.prime(GUESTCAP_QA)`: the limit of active worlds of one run, for an hour (the visitors' row is never touched). */
export function primeQaCapacityOp(deps: Pick<WorldsDeps, "now">, limit: number, runId: string): WriteOp {
  const now = deps.now();
  const until = new Date(now.getTime() + QA_GUEST_WORLD_LIMITS.primeMinutes * 60_000).toISOString();
  return {
    kind: "update",
    table: "Runtime",
    key: QA_GUEST_CAP_KEY,
    update: { set: { limit, limitRunId: runId, limitUntilReal: until, entity: "GuestCapacity", updatedAt: now.toISOString() }, add: { version: 1 } },
  };
}

/** Fixes a drifted count to what the queue says, only if nobody moved it since it was read. */
export async function healCapacity(deps: Pick<WorldsDeps, "store" | "now">, read: GuestCapacity, counted: { active: number; creating: number }): Promise<boolean> {
  if (read.active === counted.active && read.creating === counted.creating) return false;
  // The queue index is eventually consistent: only a count that stood still for a while is healed.
  if (read.updatedAt && deps.now().getTime() - Date.parse(read.updatedAt) < HEAL_AFTER_MS) return false;
  try {
    await deps.store.write({
      kind: "update",
      table: "Runtime",
      key: CAPACITY[read.worldClass].key,
      condition: read.version === 0 ? cond.notExists("version") : cond.eq("version", read.version),
      update: { set: { active: counted.active, creating: counted.creating, entity: "GuestCapacity", updatedAt: deps.now().toISOString() }, add: { version: 1 } },
    });
    return true;
  } catch {
    return false;
  }
}

/** Which operation of a cancelled transaction failed its condition (`undefined` for any other error). */
export function failedAt(error: unknown): readonly number[] | undefined {
  return error instanceof TransactionCancelledError ? error.failedConditions() : undefined;
}

