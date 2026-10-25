// What the console's authentication reads from `Worlds` (docs/architecture.md §5 and §11): the staff
// row a token names (`W#<worldId>#WORLD/STAFF#<staffId>`) and the world's `META` (status and epoch).
// An id token lives 15 minutes and is verified offline, so removing or demoting a staff account must
// not wait for it to expire, a `ServerClient` token is only accepted when the row is in a `qa-*`
// world with the same `sub`, and a world being reset must be seen on the next request.
import { z } from "zod";
import { StaffId, StaffRole, WorldId } from "@reclamo/shared";

export { StaffId };

export const StaffRow = z.looseObject({
  worldId: WorldId,
  staffId: StaffId,
  role: StaffRole,
  /** `SUB#<cognito sub>`: the key of the `BySub` index. */
  cognitoSubKey: z.string().regex(/^SUB#.+$/),
  /** Absent means active; only an explicit `false` disables the account. */
  active: z.boolean().optional(),
});
export type StaffRow = z.infer<typeof StaffRow>;

export const WorldStatus = z.enum(["REGISTERED", "CREATING", "READY", "RESETTING", "EXPIRING", "EXPIRED"]);
export type WorldStatus = z.infer<typeof WorldStatus>;

export const WorldMeta = z.looseObject({
  worldId: WorldId,
  status: WorldStatus,
  epoch: z.number().int().nonnegative(),
});
export type WorldMeta = z.infer<typeof WorldMeta>;

/** `cognitoSubKey` of a Cognito `sub`. */
export function subKeyOf(sub: string): string {
  return `SUB#${sub}`;
}

/** True when the row is usable by the user whose `sub` is given. */
export function staffRowActive(row: StaffRow | undefined, sub: string): row is StaffRow {
  return row !== undefined && row.active !== false && row.cognitoSubKey === subKeyOf(sub);
}

/** The reads of the BFF (a `GetItem` each). The adapter over DynamoDB is auth/directory.ts. */
export interface WorldDirectory {
  staff(worldId: string, staffId: string): Promise<StaffRow | undefined>;
  meta(worldId: string): Promise<WorldMeta | undefined>;
}

/** The pre-token trigger's lookup: every staff row whose `cognitoSubKey` is `SUB#<sub>` (`BySub`). */
export interface StaffBySubLookup {
  staffBySub(sub: string): Promise<StaffRow[]>;
}

// One read per user per minute per container instead of one per request. `META` is never cached:
// a world that starts resetting must answer WORLD_RESETTING on the very next request.
const STAFF_TTL_MS = 60_000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly row: StaffRow | undefined;
}

export function withStaffCache(directory: WorldDirectory, now: () => Date = () => new Date(), ttlMs: number = STAFF_TTL_MS): WorldDirectory {
  const cache = new Map<string, CacheEntry>();
  return {
    async staff(worldId, staffId) {
      const key = `${worldId}#${staffId}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now().getTime()) return cached.row;
      const row = await directory.staff(worldId, staffId);
      cache.set(key, { expiresAt: now().getTime() + ttlMs, row });
      return row;
    },
    meta: (worldId) => directory.meta(worldId),
  };
}
