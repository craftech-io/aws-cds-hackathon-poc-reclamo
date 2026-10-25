// `Worlds`: a world's `META` (status, epoch, factory cursor, reset state), its `SETTINGS` and its
// staff rows. Status changes are conditional on the status they leave, so two factories or two
// resets never interleave (docs/architecture.md §10); the pre-token trigger only reads.
import { ConnectorError } from "@reclamo/shared";
import { type BuildCursor, type ResetState, Staff, WorldMeta, WorldSettings, type WorldStatus } from "../../domain/world";
import { type NewOf, type RepoContext, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { keys } from "../keys";
import { type Condition, type WriteOp, cond } from "../store";

const TABLE = "Worlds" as const;

export interface MetaChange {
  readonly worldId: string;
  /** The status the world must be in, or several. */
  readonly from: WorldStatus | readonly WorldStatus[];
  readonly to?: WorldStatus;
  /** Only while this reset request is the world's (`reset.requestId`). */
  readonly resetRequestId?: string;
  readonly set?: {
    readonly epoch?: number;
    readonly buildCursor?: BuildCursor;
    readonly reset?: ResetState;
    readonly lastResetAtReal?: string;
  };
  readonly remove?: readonly ("buildCursor" | "reset")[];
}

export function worldsRepo(ctx: RepoContext) {
  const getMeta = async (worldId: string, options: { consistent?: boolean } = {}): Promise<WorldMeta | undefined> =>
    decodeOptional(WorldMeta, await ctx.store.get(TABLE, keys.worldMeta(worldId), options), TABLE);

  const registerOp = (meta: NewOf<typeof WorldMeta>): WriteOp => {
    const value = validInput(WorldMeta, { ...meta, version: 1 }, TABLE);
    const item = encode(value, { entity: "World", key: keys.worldMeta(value.worldId), worldId: value.worldId, retention: "world", now: ctx.now() });
    return { kind: "put", table: TABLE, item, condition: cond.absent() };
  };

  const metaChangeOp = (change: MetaChange): WriteOp => {
    const from = typeof change.from === "string" ? [change.from] : change.from;
    const conditions: Condition[] = [cond.present(), cond.in("status", from)];
    if (change.resetRequestId !== undefined) conditions.push(cond.eq("reset.requestId", change.resetRequestId));
    return {
      kind: "update",
      table: TABLE,
      key: keys.worldMeta(change.worldId),
      condition: cond.and(...conditions),
      update: {
        set: { ...change.set, ...(change.to ? { status: change.to } : {}), updatedAt: ctx.now().toISOString() },
        add: { version: 1 },
        ...(change.remove && change.remove.length > 0 ? { remove: change.remove } : {}),
      },
    };
  };

  const putSettingsOp = (settings: NewOf<typeof WorldSettings>, expectedVersion?: number): WriteOp => {
    const value = validInput(WorldSettings, { ...settings, version: (expectedVersion ?? 0) + 1 }, TABLE);
    const item = encode(value, { entity: "WorldSettings", key: keys.worldSettings(value.worldId), worldId: value.worldId, retention: "world", now: ctx.now() });
    return { kind: "put", table: TABLE, item, condition: expectedVersion === undefined ? cond.absent() : cond.eq("version", expectedVersion) };
  };

  const putStaffOp = (staff: NewOf<typeof Staff>, options: { replace?: boolean } = {}): WriteOp => {
    const value = validInput(Staff, { ...staff, version: 1 }, TABLE);
    const item = encode(value, { entity: "Staff", key: keys.staff(value.worldId, value.staffId), worldId: value.worldId, retention: "world", now: ctx.now() });
    return { kind: "put", table: TABLE, item, ...(options.replace ? {} : { condition: cond.absent() }) };
  };

  return {
    getMeta,

    /** `META.status` (routers/deps.ts `WorldStatusReader`), read strongly consistent. */
    async status(worldId: string): Promise<WorldStatus | undefined> {
      return (await getMeta(worldId, { consistent: true }))?.status;
    },

    /** Pre-registration: a world's `META` is written once (`attribute_not_exists`). */
    registerOp,
    async register(meta: NewOf<typeof WorldMeta>): Promise<void> {
      await ctx.store.write(registerOp(meta));
    },

    /** A conditional change of `META`: `REGISTERED → CREATING`, `READY → RESETTING`, `RESETTING → READY`, cursor, heartbeat. */
    metaChangeOp,
    async changeMeta(change: MetaChange): Promise<WorldMeta> {
      const after = await ctx.store.write(metaChangeOp(change));
      if (!after) throw new ConnectorError("UNAVAILABLE", "the world update returned nothing", TABLE);
      return decode(WorldMeta, after, TABLE);
    },

    async getSettings(worldId: string): Promise<WorldSettings | undefined> {
      return decodeOptional(WorldSettings, await ctx.store.get(TABLE, keys.worldSettings(worldId), { consistent: true }), TABLE);
    },

    /** Writes the settings once (factory), or over `expectedVersion` (a console change). */
    putSettingsOp,
    async putSettings(settings: NewOf<typeof WorldSettings>, expectedVersion?: number): Promise<void> {
      await ctx.store.write(putSettingsOp(settings, expectedVersion));
    },

    /** The staff row a token names (auth/staff.ts `StaffLookup`), read strongly consistent. */
    async getStaff(worldId: string, staffId: string): Promise<Staff | undefined> {
      return decodeOptional(Staff, await ctx.store.get(TABLE, keys.staff(worldId, staffId), { consistent: true }), TABLE);
    },

    async listStaff(worldId: string): Promise<Staff[]> {
      const items = await queryAll(ctx.store, { table: TABLE, partition: keys.worldMeta(worldId).pk, sort: { op: "beginsWith", value: keys.staffPrefix } });
      return items.map((item) => decode(Staff, item, TABLE));
    },

    /**
     * The staff rows of a Cognito `sub` (index `BySub`, read only by the pre-token trigger). The index
     * is eventually consistent: every hit is re-read from the table and kept only if it still names
     * this `sub` and lives under its own world.
     */
    async findStaffBySub(sub: string): Promise<Staff[]> {
      const subKey = keys.subKey(sub);
      const page = await ctx.store.query({ table: TABLE, index: "BySub", partition: subKey, limit: 5 });
      const rows = await Promise.all(
        page.items.map(async (hit) => {
          if (!hit.sk.startsWith(keys.staffPrefix)) return undefined;
          const row = decodeOptional(Staff, await ctx.store.get(TABLE, { pk: hit.pk, sk: hit.sk }, { consistent: true }), TABLE);
          return row && row.cognitoSubKey === subKey && keys.staff(row.worldId, row.staffId).pk === hit.pk ? row : undefined;
        }),
      );
      return rows.filter((row): row is Staff => row !== undefined);
    },

    /** A staff row, created once per world and user (`console:invite`, `auth.session`). */
    putStaffOp,
    async putStaff(staff: NewOf<typeof Staff>, options: { replace?: boolean } = {}): Promise<void> {
      await ctx.store.write(putStaffOp(staff, options));
    },

    async setStaffActive(worldId: string, staffId: string, active: boolean): Promise<void> {
      await ctx.store.write({
        kind: "update",
        table: TABLE,
        key: keys.staff(worldId, staffId),
        condition: cond.present(),
        update: { set: { active, updatedAt: ctx.now().toISOString() }, add: { version: 1 } },
      });
    },
  };
}

export type WorldsRepo = ReturnType<typeof worldsRepo>;
