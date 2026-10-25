// `AuditLog`: the decisions that are not an outbound message (tools with effects, approvals and
// rejections, take-overs, logins, clock, resets, discarded fires, guardrail blocks, cross-world
// denials). Append-only like the register: only a `PutItem` that cannot overwrite, one partition per
// epoch and month, and a reset never deletes it (docs/architecture.md §5).
import { AuditEntry } from "../../domain/ledger";
import { type NewOf, type RepoContext, decode, encode, validInput } from "../codec";
import { keys, sortInstant, worldKey } from "../keys";
import { type WriteOp, cond } from "../store";

const TABLE = "AuditLog" as const;

export function auditRepo(ctx: RepoContext) {
  const appendOp = (entry: NewOf<typeof AuditEntry>): WriteOp => {
    const parsed = validInput(AuditEntry, entry, TABLE);
    // `ts` is the sort key of both indexes: stored in UTC so entries order whatever offset was passed.
    const value = { ...parsed, ts: sortInstant(parsed.ts) };
    const key = keys.audit(value.worldId, value.epoch, value.ts, value.auditId);
    const item = encode(value, {
      entity: "Decision",
      key,
      worldId: value.worldId,
      retention: "audit",
      now: ctx.now(),
      indexes: {
        actionKey: worldKey(value.worldId, value.action),
        refIndexKey: value.primaryRef ? worldKey(value.worldId, value.primaryRef) : undefined,
      },
    });
    return { kind: "put", table: TABLE, item, condition: cond.absent() };
  };

  const list = async (partition: string, index: "ByAction" | "ByRef", limit: number): Promise<AuditEntry[]> => {
    const page = await ctx.store.query({ table: TABLE, index, partition, descending: true, limit });
    return page.items.map((item) => decode(AuditEntry, item, TABLE));
  };

  return {
    /** The entry as an operation, to commit with the change it records (a reset request, a decision). */
    appendOp,
    async append(entry: NewOf<typeof AuditEntry>): Promise<void> {
      await ctx.store.write(appendOp(entry));
    },
    /** Entries of one action (`DENY`, `WORLD_RESET`, …), newest first (index `ByAction`). */
    async listByAction(worldId: string, action: string, limit = 100): Promise<AuditEntry[]> {
      return list(worldKey(worldId, action), "ByAction", limit);
    },
    /** Entries filed under one ref (`CMP#<id>`), newest first (index `ByRef`). */
    async listByRef(worldId: string, ref: string, limit = 100): Promise<AuditEntry[]> {
      return list(worldKey(worldId, ref), "ByRef", limit);
    },
    /** One epoch and month of the log, in time order. */
    async listMonth(worldId: string, epoch: number, month: string, options: { limit?: number; cursor?: string } = {}) {
      const page = await ctx.store.query({ table: TABLE, partition: keys.auditPartition(worldId, epoch, month), limit: options.limit ?? 500, ...(options.cursor ? { cursor: options.cursor } : {}) });
      return { entries: page.items.map((item) => decode(AuditEntry, item, TABLE)), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  };
}

export type AuditRepo = ReturnType<typeof auditRepo>;
