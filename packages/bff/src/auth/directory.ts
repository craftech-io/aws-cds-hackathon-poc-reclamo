// The reads and the one write the console's authentication and the pre-token trigger need
// (docs/architecture.md §5, §11, §14), over the connector: `GetItem` of `W#<w>#WORLD/STAFF#<id>` and
// `W#<w>#WORLD/META` (strongly consistent), `Query` of `Worlds/index/BySub` with every hit re-read,
// and a put-only `AuditLog` entry. It never writes `Worlds`: a login reads a world, it never creates
// or changes one (ADR-0018). Keys, indexes and TTLs live in the connector alone.
import type { Connector } from "../connector/port";
import { ulid } from "../lib/crypto";
import { type AuditEntry, type AuditSink, maskAuditRefs } from "./audit";
import type { StaffBySubLookup, WorldDirectory } from "./staff";

type WorldsReads = Pick<Connector["worlds"], "getStaff" | "getMeta" | "findStaffBySub">;

export function connectorWorldDirectory(worlds: WorldsReads): WorldDirectory & StaffBySubLookup {
  return {
    async staff(worldId, staffId) {
      const row = await worlds.getStaff(worldId, staffId);
      // A row stored under one world that names another is never trusted.
      return row && row.worldId === worldId && row.staffId === staffId ? row : undefined;
    },
    async meta(worldId) {
      const meta = await worlds.getMeta(worldId, { consistent: true });
      return meta && meta.worldId === worldId ? meta : undefined;
    },
    staffBySub: (sub) => worlds.findStaffBySub(sub),
  };
}

/** The ref the `ByRef` index files a denial under: the staff account, when there is one. */
function primaryRefOf(entry: AuditEntry): string | undefined {
  return entry.refs.staffId ? `STAFF#${entry.refs.staffId}` : undefined;
}

/**
 * Audit stamps are real time (lib/clock.ts): `now` is the wall clock, never a world clock. Every
 * `refs` value is masked on the way in (auth/audit.ts), whoever wrote the entry.
 */
export function connectorAuditSink(audit: Pick<Connector["audit"], "append">, now: () => Date = () => new Date()): AuditSink {
  return {
    async record(entry) {
      const at = now();
      const primaryRef = primaryRefOf(entry);
      await audit.append({
        worldId: entry.worldId,
        epoch: entry.epoch,
        auditId: ulid(at.getTime()),
        ts: at.toISOString(),
        action: entry.action,
        actor: entry.actor,
        refs: maskAuditRefs(entry.refs),
        outcome: entry.outcome,
        ...(primaryRef ? { primaryRef } : {}),
      });
    },
  };
}
