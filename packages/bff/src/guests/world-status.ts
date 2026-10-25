// The world of a signed-in guest (docs/architecture-guests.md §4-§7): `guest.status` (what the
// provisioning screen polls, and the day's usage the console shows) and `guest.requestWorld` (an
// expired self-signup world, asked again). In a self-signup world the first call of a session stamps
// the lead's last sign-in (and so its retention); a call while the world is `READY` renews its
// activity at most once every five real minutes, which is what keeps it from expiring. The usage
// reads the turn counters the worker spends (worker/caps.ts), never spends one. Nothing here builds
// a world: that is the factory's (provision.ts).
import { ConnectorError } from "@reclamo/shared";
import type { RepoContext } from "../connector/codec";
import { keys, segment } from "../connector/keys";
import type { Connector } from "../connector/port";
import { cond } from "../connector/store";
import { ulid } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { worldBuckets } from "../worker/caps";
import type { SignupCaps } from "./caps";
import { GUEST_WORLD_PATTERN, qaScopeOfWorld } from "../leads/keys";
import { GUEST_WORLD_LIMITS, expiresAt } from "../leads/limits";
import { type ProvisionInvoker, provisionOps } from "./provision";
import type { LeadsRepo } from "../leads/repo";

const ACTIVITY_EVERY_MS = 5 * 60 * 1_000;
const HOUR_MS = 3_600_000;

export interface GuestWorldDeps {
  readonly ctx: RepoContext;
  readonly connector: Pick<Connector, "worlds" | "transact">;
  readonly leads: LeadsRepo;
  readonly caps: SignupCaps;
  readonly invoker: ProvisionInvoker;
  readonly log: Logger;
}

export interface GuestCaller {
  readonly sub: string;
  readonly worldId: string;
  /** `origin_jti` of the session (a refresh keeps it). */
  readonly sessionId: string;
}

/** The world's turns of today (real clock) against its caps, for "Llegaste al límite de uso de hoy". */
export interface GuestUsage {
  readonly turnsToday: number;
  readonly turnsPerDay: number;
  /** A cap of the world (hour, day or, for a self-signup world, epoch) is reached. */
  readonly limitReached: boolean;
}

export interface GuestStatus {
  readonly worldStatus: string;
  /** 0 = next in line (or not queued). */
  readonly queuePosition: number;
  readonly readyAtReal?: string;
  /** When the world expires if nothing happens (real clock, estimate). */
  readonly expiresAtReal?: string;
  /** Only while the world is `READY`. */
  readonly usage?: GuestUsage;
}

/** The earliest of the three expiries of a `READY` world (§6). */
export function expiryOf(readyAtReal: string | undefined, lastActivityAtReal: string | undefined): string | undefined {
  if (!readyAtReal) return undefined;
  const ready = Date.parse(readyAtReal);
  const candidates = [ready + GUEST_WORLD_LIMITS.expireAfterReadyDays * 24 * HOUR_MS];
  if (lastActivityAtReal) candidates.push(Date.parse(lastActivityAtReal) + GUEST_WORLD_LIMITS.expireWithoutActivityHours * HOUR_MS);
  else candidates.push(ready + GUEST_WORLD_LIMITS.expireWithoutSignInHours * HOUR_MS);
  return new Date(Math.min(...candidates)).toISOString();
}

export function guestWorldService(deps: GuestWorldDeps) {
  /** True the first time a session asks (a conditional put per session, one real day). */
  const firstCallOfSession = async (caller: GuestCaller): Promise<boolean> => {
    const now = deps.ctx.now();
    try {
      await deps.ctx.store.write({
        kind: "put",
        table: "Runtime",
        item: { ...keys.runtime(caller.worldId, "SIGNIN", segment(caller.sessionId, "session id")), entity: "SessionSeen", atReal: now.toISOString(), expiresAt: expiresAt(now, 24 * 3_600) },
        condition: cond.absent(),
      });
      return true;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
      throw error;
    }
  };

  const renewActivity = async (worldId: string): Promise<void> => {
    const now = deps.ctx.now();
    const since = new Date(now.getTime() - ACTIVITY_EVERY_MS).toISOString();
    try {
      await deps.ctx.store.write({
        kind: "update",
        table: "Worlds",
        key: keys.worldMeta(worldId),
        condition: cond.and(cond.eq("status", "READY"), cond.or(cond.notExists("lastActivityAtReal"), cond.lt("lastActivityAtReal", since))),
        update: { set: { lastActivityAtReal: now.toISOString() } },
      });
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    }
  };

  /** Reads the world's turn counters of now; a world without settings reports nothing. */
  const usageOf = async (worldId: string, epoch: number): Promise<GuestUsage | undefined> => {
    const settings = await deps.connector.worlds.getSettings(worldId);
    if (!settings) return undefined;
    const buckets = worldBuckets(worldId, epoch, settings, deps.ctx.now());
    const counts = await Promise.all(buckets.map(async (bucket) => Number((await deps.ctx.store.get("Runtime", bucket.key, { consistent: true }))?.count ?? 0)));
    const day = buckets.findIndex((bucket) => bucket.window === "DAY");
    return {
      turnsToday: counts[day] ?? 0,
      turnsPerDay: settings.turnCaps.perDay,
      limitReached: buckets.some((bucket, index) => (counts[index] ?? 0) >= bucket.limit),
    };
  };

  return {
    async status(caller: GuestCaller): Promise<GuestStatus> {
      // Only a self-signup account has a lead whose last sign-in counts its retention: a visitor's
      // (`gs-*`, `LEAD#`) or the scenario runner's (`qa-<runId>-su<n>`, `QALEAD#` under its scope).
      const qa = qaScopeOfWorld(caller.worldId);
      if ((GUEST_WORLD_PATTERN.test(caller.worldId) || qa) && (await firstCallOfSession(caller))) {
        if (!(await deps.leads.touchSignIn(caller.sub, qa))) deps.log.warn("guest.lead_missing", { worldId: caller.worldId });
      }
      const meta = await deps.connector.worlds.getMeta(caller.worldId, { consistent: true });
      if (!meta) return { worldStatus: "REGISTERED", queuePosition: 0 };
      if (meta.status === "READY") await renewActivity(caller.worldId);
      const expires = meta.status === "READY" && GUEST_WORLD_PATTERN.test(caller.worldId) ? expiryOf(meta.readyAtReal, meta.lastActivityAtReal) : undefined;
      const usage = meta.status === "READY" ? await usageOf(caller.worldId, meta.epoch) : undefined;
      return {
        worldStatus: meta.status,
        queuePosition: meta.status === "REGISTERED" ? (meta.queuePosition ?? 0) : 0,
        ...(meta.readyAtReal ? { readyAtReal: meta.readyAtReal } : {}),
        ...(expires ? { expiresAtReal: expires } : {}),
        ...(usage ? { usage } : {}),
      };
    },

    /** An expired self-signup world goes back to the queue with a new ticket; anything else is left alone. */
    async requestWorld(caller: GuestCaller): Promise<{ readonly status: "REGISTERED" | "ALREADY_ACTIVE" | "RATE_LIMITED" }> {
      if (!GUEST_WORLD_PATTERN.test(caller.worldId)) return { status: "ALREADY_ACTIVE" };
      const meta = await deps.connector.worlds.getMeta(caller.worldId, { consistent: true });
      if (meta?.status !== "EXPIRED") return { status: "ALREADY_ACTIVE" };
      if (!(await deps.caps.worldRequest(caller.sub))) return { status: "RATE_LIMITED" };
      const requestId = ulid(deps.ctx.now().getTime());
      try {
        await deps.connector.transact(provisionOps(deps.ctx).requeueOps(caller.worldId, requestId));
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return { status: "ALREADY_ACTIVE" };
        throw error;
      }
      await deps.invoker.createWorld({ kind: "WORLD_CREATE", worldId: caller.worldId, requestId }).catch((error: unknown) => {
        deps.log.warn("guest.invoke_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      });
      return { status: "REGISTERED" };
    },
  };
}

export type GuestWorldService = ReturnType<typeof guestWorldService>;
