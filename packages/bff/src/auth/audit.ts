// Denials of the console and of the pre-token trigger go to `AuditLog` (docs/architecture.md §5)
// through the connector (auth/directory.ts): append-only, partitioned by world, epoch and real
// month, with the TTL of the world's class. The entry names ids and codes only: no token, no
// attribute value, no personal data. The contract holds for every writer (docs/architecture-guests.md
// §3): each value of `refs` goes through the masker of lib/mask.ts, and a value it changes (an email,
// a phone) is replaced by the masked one and reported as `audit.refs_masked`, without the value.
import type { Logger } from "../lib/log";
import { maskSensitive } from "../lib/mask";
import type { Principal } from "./principal";

export const AUDIT_ACTION = {
  /** A console request refused after its principal was known (`outcome` says why). */
  DENY: "DENY",
  /** Pre-token trigger: no staff row, an attribute that disagrees with it, or a `qa-*` user outside a `qa-*` world. */
  AUTH_WORLD_MISMATCH: "AUTH_WORLD_MISMATCH",
  /** Pre-token trigger: a sign-in to a world that is not `READY` (`outcome` = its status). */
  WORLD_NOT_READY: "WORLD_NOT_READY",
  /** Post-confirmation trigger: a confirmed self-signup, its lead, world and ticket. */
  GUEST_REGISTERED: "GUEST_REGISTERED",
} as const;
export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export interface AuditEntry {
  readonly worldId: string;
  /** Epoch of the world when the decision was taken (`META.epoch`); 0 when the world has no `META`. */
  readonly epoch: number;
  readonly action: AuditAction;
  /** Why: `CROSS_WORLD`, `ROLE`, `SERVER_CLIENT_AUDIENCE`, `STAFF_INACTIVE`, a world status… */
  readonly outcome: string;
  /** `OPERATOR:<staffId>` for staff, `QA` for the in-process principal, `SYSTEM` for the trigger. */
  readonly actor: string;
  /** Ids and codes only (procedure path, staff id, reason). */
  readonly refs: Readonly<Record<string, string>>;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** Actor of a console principal, in the same form as a `Sender` (`OPERATOR:<staffId>`). */
export function actorOf(principal: Pick<Principal, "audience" | "staffId">): string {
  return principal.audience === "in-process" ? "QA" : `OPERATOR:${principal.staffId}`;
}

/** `refs` with every value masked; a value that needed it is never kept, only counted in the log. */
export function maskAuditRefs(refs: Readonly<Record<string, string>>, log?: Pick<Logger, "warn">): Record<string, string> {
  const masked: Record<string, string> = {};
  let changed = 0;
  for (const [key, value] of Object.entries(refs)) {
    const safe = maskSensitive(value);
    if (safe !== value) changed += 1;
    masked[key] = safe;
  }
  if (changed > 0) log?.warn("audit.refs_masked", { count: changed });
  return masked;
}

/** An `AuditSink` that masks every `refs` value before the inner sink writes it. */
export function maskingAuditSink(sink: AuditSink, log?: Pick<Logger, "warn">): AuditSink {
  return { record: (entry) => sink.record({ ...entry, refs: maskAuditRefs(entry.refs, log) }) };
}
