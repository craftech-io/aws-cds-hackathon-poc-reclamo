// The boundary between domain objects (zod schemas of packages/bff/src/domain) and stored items.
// Writing adds the storage attributes (key, entity tag, index keys, timestamps, version, TTL);
// reading strips them and parses what is left with the entity's schema, so a row that does not
// match its schema never reaches the domain as if it did (zod on every edge, CLAUDE.md).
import type { z } from "zod";
import { ConnectorError } from "@reclamo/shared";
import { type Condition, type Key, type StoredItem, type TableStore, cond } from "./store";
import { STORAGE_ATTRIBUTES, type TableName } from "./tables";
import { type RetentionRule, expiry } from "./ttl";

/** A new entity as its creator passes it: the connector stamps `version` and the timestamps. */
export type NewOf<S extends z.ZodType> = Omit<z.input<S>, "version" | "createdAt" | "updatedAt">;

/** What every repository receives: the engine and the real clock (stamps and TTLs are real time). */
export interface RepoContext {
  readonly store: TableStore;
  readonly now: () => Date;
}

export interface EncodeOptions {
  readonly entity: string;
  readonly key: Key;
  readonly worldId?: string;
  /** Index attributes of the item (tables.ts). */
  readonly indexes?: Readonly<Record<string, string | number | undefined>>;
  readonly retention?: RetentionRule;
  readonly now: Date;
}

/** A domain value as a stored item with its key, entity tag, stamps, index keys and TTL. */
export function encode(value: object, options: EncodeOptions): StoredItem {
  const at = options.now.toISOString();
  const indexes = Object.fromEntries(Object.entries(options.indexes ?? {}).filter(([, attribute]) => attribute !== undefined));
  return {
    ...(value as Record<string, unknown>),
    createdAt: (value as { createdAt?: string }).createdAt ?? at,
    updatedAt: at,
    version: (value as { version?: number }).version ?? 1,
    ...indexes,
    ...(options.retention ? expiry(options.retention, options.worldId, options.now) : {}),
    entity: options.entity,
    pk: options.key.pk,
    sk: options.key.sk,
  };
}

// String sets come back from DynamoDB as `Set`s; the domain sees sorted arrays.
function plain(value: unknown): unknown {
  if (value instanceof Set) return [...value].map(String).sort();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, plain(member)]));
  return value;
}

/** The domain value of a stored item, or a VALIDATION error when the row does not match its schema. */
export function decode<T>(schema: z.ZodType<T>, item: StoredItem, table: TableName): T {
  const data = Object.fromEntries(Object.entries(item).filter(([name]) => !STORAGE_ATTRIBUTES.has(name)).map(([name, value]) => [name, plain(value)]));
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const entity = typeof item.entity === "string" ? item.entity : "item";
    throw new ConnectorError("VALIDATION", `stored ${entity} does not match its schema`, table, { cause: parsed.error });
  }
  return parsed.data;
}

export function decodeOptional<T>(schema: z.ZodType<T>, item: StoredItem | undefined, table: TableName): T | undefined {
  return item === undefined ? undefined : decode(schema, item, table);
}

/** Parses an input with its schema before anything is written; a mismatch is a VALIDATION error. */
export function validInput<T>(schema: z.ZodType<T>, value: unknown, table: TableName): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConnectorError("VALIDATION", `invalid ${table} input`, table, { cause: parsed.error });
  return parsed.data;
}

/** How a create writes: never over an existing item, unless the world factory rewrites its template (`replace`). */
export interface CreateMode {
  readonly replace?: boolean;
}

/** The condition of a create: `attribute_not_exists(pk)` unless it is an idempotent rewrite. */
export function createGuard(mode: CreateMode = {}): { condition?: Condition } {
  return mode.replace ? {} : { condition: cond.absent() };
}

/** Reads every page of a query (partitions of this app are small: a conversation, a complaint). */
export async function queryAll(store: TableStore, spec: Parameters<TableStore["query"]>[0], max = 1_000): Promise<StoredItem[]> {
  const items: StoredItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query({ ...spec, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor && items.length < max);
  return items.slice(0, max);
}
