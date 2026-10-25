// Between stored items and the ledger's typed values. Reading strips the storage attributes and
// parses the rest with the entity's schema (a row that does not match is an error, never data);
// writing stamps the key, the entity, `version`, the stamps, `WorldIndex` and the expiry.
//
// The mock never reads a clock (ADR-0011): stamps are the world's simulated instant, and a new
// item inherits the `expiresAt` of the customer's `META` (the world factory set it for QA, guest
// and `sim-*` worlds), so what the core writes in a disposable world disappears with it.
import type { z } from "zod";
import { coreKeys } from "./keys";
import type { PutCondition, PutWrite, StoredItem } from "./port";

export const STORAGE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "pk",
  "sk",
  "version",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "worldId",
  "synthetic",
  "worldIndexKey",
  "worldIndexSort",
]);

/** A stored value with what the ledger needs to write it back. */
export interface Stored<T> {
  readonly value: T;
  readonly pk: string;
  readonly sk: string;
  readonly version: number;
  /** The item as read: a rewrite keeps the attributes the schema does not name (index keys, `synthetic`). */
  readonly raw: StoredItem;
}

/** A row that does not match its schema: the mock answers 503 and logs it, never guesses. */
export class CorruptItemError extends Error {
  override readonly name = "CorruptItemError";
  constructor(
    readonly entity: string,
    options?: ErrorOptions,
  ) {
    super(`stored ${entity} does not match its schema`, options);
  }
}

export function versionOf(item: StoredItem): number {
  const version = item.version;
  return typeof version === "number" && Number.isInteger(version) && version > 0 ? version : 1;
}

export function decodeItem<S extends z.ZodType>(schema: S, item: StoredItem): Stored<z.infer<S>> {
  const data: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(item)) {
    if (!STORAGE_ATTRIBUTES.has(name)) data[name] = value instanceof Set ? [...value].map(String).sort() : value;
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CorruptItemError(typeof item.entity === "string" ? item.entity : "item", { cause: parsed.error });
  return { value: parsed.data, pk: item.pk, sk: item.sk, version: versionOf(item), raw: item };
}

/** What a write needs besides the value: the world, the simulated instant and the inherited expiry. */
export interface WriteStamp {
  readonly worldId: string;
  readonly simNow: string;
  /** `expiresAt` of the customer's `META`, when the world is disposable. */
  readonly expiresAt?: number;
}

/** A new item: written only if its key is free. */
export function putNew(value: object, pk: string, sk: string, stamp: WriteStamp): PutWrite {
  const condition: PutCondition = { kind: "absent" };
  const item: StoredItem = {
    ...(value as Record<string, unknown>),
    pk,
    sk,
    worldId: stamp.worldId,
    version: 1,
    createdAt: stamp.simNow,
    updatedAt: stamp.simNow,
    ...coreKeys.worldIndex(stamp.worldId, pk, sk),
    ...(stamp.expiresAt === undefined ? {} : { expiresAt: stamp.expiresAt }),
  };
  return { item, condition };
}

/** A changed item: written only if nobody changed it since it was read; what the schema ignores stays. */
export function putChanged<T extends object>(read: Stored<T>, value: T, stamp: WriteStamp): PutWrite {
  const condition: PutCondition = { kind: "version", version: read.version };
  const item: StoredItem = { ...read.raw, ...(value as Record<string, unknown>), pk: read.pk, sk: read.sk, version: read.version + 1, updatedAt: stamp.simNow };
  return { item, condition };
}

/** The `expiresAt` of a stored item, if it has one. */
export function expiryOf(item: StoredItem | undefined): number | undefined {
  const value = item?.expiresAt;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
