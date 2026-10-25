// `expiresAt` (DynamoDB TTL, epoch seconds, real time) of every item the connector writes, fixed at
// write time by table, item kind and the class of its world (docs/architecture.md §5). Append-only
// tables are never updated, so their expiry is decided once, when the entry is written. The rules
// the architecture leaves without a duration for guest worlds use 90 days: long enough to outlive a
// trial, so a guest's world never loses its rows mid-review, and still bounded.
import { type WorldKind, worldKindOf } from "@reclamo/shared";

const HOUR = 3_600;
const DAY = 24 * HOUR;

/** What an item is, for its retention. */
export type RetentionRule =
  | "register" // Register and ComplianceTape: demo 180 d, guest 30 d, QA/sim 2 d
  | "audit" // AuditLog: demo 12 months, guest 30 d, QA/sim 2 d
  | "world" // Worlds rows: QA/sim 2 d, guest 90 d, demo never
  | "complaint" // Complaints: QA/sim 2 d, guest 90 d, demo never
  | "timer" // Timers: QA/sim 2 d
  | "conversation" // Conversations: 90 d; QA/sim 2 d
  | "metrics" // Metrics: QA/sim 2 d
  | "session" // Runtime SESSION#, TURN#: 1 h
  | "nonce" // Runtime NONCE#: 7 d
  | "idempotency" // Runtime IDEMP#: 7 d
  | "cap" // Runtime RATE#, TURNCAP#, IMGCAP#, GLOBALCAP#, SEND#: 48 h
  | "pending" // Runtime PENDING items and PROBE#: 48 h
  | "purgeTicket" // Runtime PURGEREQ#: 1 h
  | "resetTicket" // Runtime RESETREQ#: 7 d
  | "scanObject" // Runtime SCANOBJ#: 1 h from the last change
  | "lease" // Runtime LEASE#: 2 h
  | "challenge" // Runtime CHALLENGE#: 24 h from the last failure
  | "worldRuntime"; // Runtime CLOCK, WORLDSTATE, counters, tombstones, sim media: QA/sim 2 d, never elsewhere

const BY_KIND: Readonly<Record<"register" | "audit" | "world" | "complaint" | "timer" | "conversation" | "metrics" | "worldRuntime", Readonly<Record<WorldKind, number | undefined>>>> = {
  register: { DEMO: 180 * DAY, GUEST: 30 * DAY, QA: 2 * DAY, SIM: 2 * DAY },
  audit: { DEMO: 365 * DAY, GUEST: 30 * DAY, QA: 2 * DAY, SIM: 2 * DAY },
  world: { DEMO: undefined, GUEST: 90 * DAY, QA: 2 * DAY, SIM: 2 * DAY },
  complaint: { DEMO: undefined, GUEST: 90 * DAY, QA: 2 * DAY, SIM: 2 * DAY },
  timer: { DEMO: undefined, GUEST: undefined, QA: 2 * DAY, SIM: 2 * DAY },
  conversation: { DEMO: 90 * DAY, GUEST: 90 * DAY, QA: 2 * DAY, SIM: 2 * DAY },
  metrics: { DEMO: undefined, GUEST: undefined, QA: 2 * DAY, SIM: 2 * DAY },
  worldRuntime: { DEMO: undefined, GUEST: undefined, QA: 2 * DAY, SIM: 2 * DAY },
};

const FIXED: Readonly<Record<Exclude<RetentionRule, keyof typeof BY_KIND>, number>> = {
  session: HOUR,
  nonce: 7 * DAY,
  idempotency: 7 * DAY,
  cap: 2 * DAY,
  pending: 2 * DAY,
  purgeTicket: HOUR,
  resetTicket: 7 * DAY,
  scanObject: HOUR,
  lease: 2 * HOUR,
  challenge: DAY,
};

/** Seconds an item of this rule lives in this world, or `undefined` when it never expires. */
export function retentionSeconds(rule: RetentionRule, worldId: string | undefined): number | undefined {
  if (rule in FIXED) return FIXED[rule as keyof typeof FIXED];
  const kind = worldId === undefined ? undefined : worldKindOf(worldId);
  if (!kind) return undefined;
  return BY_KIND[rule as keyof typeof BY_KIND][kind];
}

/** `{ expiresAt }` for an item written at `now` (real), or `{}` when it never expires. */
export function expiry(rule: RetentionRule, worldId: string | undefined, now: Date): { expiresAt?: number } {
  const seconds = retentionSeconds(rule, worldId);
  return seconds === undefined ? {} : { expiresAt: Math.floor(now.getTime() / 1000) + seconds };
}
