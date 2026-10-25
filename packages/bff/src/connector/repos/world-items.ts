// Raw items of one world, for the world factory and its wipe (docs/architecture.md §10): the factory
// writes a template's items with their final keys (only `<worldId>` and `<epoch>` substituted) in
// idempotent blocks, and a reset's `WIPE` enumerates the world through `WorldIndex` and deletes it.
// What the architecture excludes from both is refused here, whoever asks:
//
//   - `Worlds` (`META`, `SETTINGS`, `STAFF#`): changed only through the worlds repository;
//   - `Register`, `ComplianceTape`, `AuditLog`: append-only, written only through the chains and
//     the audit repositories, never deleted;
//   - in `Runtime`, the epoch counter, tombstones, tickets, chain heads, the kill switch and the
//     real-clock caps: a reset never opens a new bucket nor rewinds a chain.
import { ConnectorError } from "@reclamo/shared";
import { type RepoContext, encode } from "../codec";
import { keys, worldIndexAttributes, worldPrefix } from "../keys";
import type { Key, StoredItem } from "../store";
import { APPEND_ONLY_TABLES, type TableName } from "../tables";
import type { RetentionRule } from "../ttl";

/** Tables with `WorldIndex`: the ones a wipe enumerates (plus `Metrics`, one partition per world). */
export const WORLD_INDEXED_TABLES = ["Core", "Networks", "Complaints", "Timers", "Conversations"] as const satisfies readonly TableName[];
export type WorldIndexedTable = (typeof WORLD_INDEXED_TABLES)[number];

const RETENTION: Readonly<Partial<Record<TableName, RetentionRule>>> = {
  Core: "complaint",
  Networks: "complaint",
  Complaints: "complaint",
  Timers: "timer",
  Conversations: "conversation",
  Metrics: "metrics",
  Runtime: "worldRuntime",
};

const PROTECTED_RUNTIME = ["COUNTER#EPOCH", "COUNTER#REGSEQ#", "COUNTER#RRISEQ#", "COUNTER#TAPESEQ#", "TOMB#", "RESETREQ#", "PURGEREQ#", "KILL", "RATE#", "TURNCAP#", "IMGCAP#", "RESETCAP#"];

function assertWritable(table: TableName, worldId: string, key: Key): void {
  if (table === "Worlds" || table === "Reference" || APPEND_ONLY_TABLES.has(table)) {
    throw new ConnectorError("VALIDATION", `${table} items are not written or deleted as raw world items`, table);
  }
  const prefix = worldPrefix(worldId);
  if (!key.pk.startsWith(prefix)) throw new ConnectorError("VALIDATION", "an item outside the world", table);
  if (table === "Runtime") {
    const rest = key.pk.slice(prefix.length);
    if (PROTECTED_RUNTIME.some((name) => rest === name || (name.endsWith("#") && rest.startsWith(name)))) {
      throw new ConnectorError("VALIDATION", "this runtime item survives a reset and is not rewritten", table);
    }
  }
}

export function worldItemsRepo(ctx: RepoContext) {
  return {
    /** A page of the keys of one world in a table (`WorldIndex`, keys only). */
    async listKeys(table: WorldIndexedTable, worldId: string, options: { limit?: number; cursor?: string } = {}): Promise<{ keys: Key[]; cursor?: string }> {
      const page = await ctx.store.query({ table, index: "WorldIndex", partition: worldPrefix(worldId), limit: options.limit ?? 200, ...(options.cursor ? { cursor: options.cursor } : {}) });
      return { keys: page.items.map((item) => ({ pk: item.pk, sk: item.sk })), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    /** A page of the keys of the world's `Metrics` partition. */
    async listMetricsKeys(worldId: string, options: { limit?: number; cursor?: string } = {}): Promise<{ keys: Key[]; cursor?: string }> {
      const page = await ctx.store.query({ table: "Metrics", partition: keys.metricsPartition(worldId), limit: options.limit ?? 200, ...(options.cursor ? { cursor: options.cursor } : {}) });
      return { keys: page.items.map((item) => ({ pk: item.pk, sk: item.sk })), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    /** A raw item of a world, strongly consistent (the factory compares before it rewrites). */
    async get(table: TableName, worldId: string, key: Key): Promise<StoredItem | undefined> {
      if (!key.pk.startsWith(worldPrefix(worldId))) throw new ConnectorError("VALIDATION", "an item outside the world", table);
      return ctx.store.get(table, key, { consistent: true });
    },

    /**
     * Writes a block of template items as they are (idempotent: the same key is simply rewritten),
     * stamped with the world, `WorldIndex` and the retention of the table.
     */
    async put(table: TableName, worldId: string, items: readonly StoredItem[]): Promise<void> {
      const now = ctx.now();
      const stamped = items.map((item) => {
        assertWritable(table, worldId, item);
        if (typeof item.entity !== "string" || item.entity === "") throw new ConnectorError("VALIDATION", "a template item names its entity", table);
        if (item.worldId !== undefined && item.worldId !== worldId) throw new ConnectorError("VALIDATION", "a template item of another world", table);
        const indexes = (WORLD_INDEXED_TABLES as readonly TableName[]).includes(table) ? worldIndexAttributes(worldId, item) : {};
        const retention = RETENTION[table];
        const value = Object.fromEntries(Object.entries(item).filter(([name]) => name !== "pk" && name !== "sk" && name !== "entity"));
        return encode({ ...value, worldId }, { entity: item.entity, key: item, worldId, now, indexes, ...(retention ? { retention } : {}) });
      });
      await ctx.store.batchWrite(table, stamped.map((put) => ({ put })));
    },

    /** Deletes a block of a world's items (a reset's `WIPE`, a half-written world's resume). */
    async delete(table: TableName, worldId: string, itemKeys: readonly Key[]): Promise<void> {
      for (const key of itemKeys) assertWritable(table, worldId, key);
      await ctx.store.batchWrite(table, itemKeys.map((key) => ({ delete: { pk: key.pk, sk: key.sk } })));
    },
  };
}

export type WorldItemsRepo = ReturnType<typeof worldItemsRepo>;
