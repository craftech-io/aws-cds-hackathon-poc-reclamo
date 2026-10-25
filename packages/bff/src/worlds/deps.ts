// What the world factory, the reset and expiry work, the Memory purge and `WorldJanitor` need
// (docs/architecture.md §9.3 and §10, docs/architecture-guests.md §5-§6). Every external system is a
// port here, so the unit tests run the whole lifecycle on the memory connector with fakes
// (worlds/testing.ts) and the stage builds the real adapters in worlds/stage.ts.
//
// Two clocks never mix: `now` is the REAL clock (tickets, leases, heartbeats, expiry, caps); the
// simulated time of a world only ever comes from its template and its stored clock (ADR-0011).
import type { AnchorRequester } from "../complaints/anchors";
import type { Connector } from "../connector/port";
import type { TableStore } from "../connector/store";
import type { Logger } from "../lib/log";
import type { MemoryAdmin } from "./memory-admin";
import type { TemplateSource } from "./template";

/** The S3 side of a world (docs/architecture.md §6): seeded settlement files in, the world root out. */
export interface WorldObjects {
  /** Server-side copy of a `Seed/` object to `Settlements/<key>` (idempotent: same bytes, same key). */
  copySettlement(seedKey: string, key: string): Promise<void>;
  /**
   * Deletes up to `limit` objects under `prefix` in the world buckets (`Media`, `Documents`, `Emails`,
   * `Settlements`; never `Exports`). Returns how many it deleted: 0 means the prefix is empty.
   */
  deleteUnder(prefix: string, limit: number): Promise<number>;
}

/** The Scheduler as a reset sees it: a schedule that is already gone is fine. */
export interface ScheduleRemover {
  delete(name: string): Promise<void>;
  /** Names in the app's group that start with `prefix` (the hourly cleanup of `tm-qa-*`); absent where not allowed. */
  list?(prefix: string): Promise<string[]>;
}

/** What `WorldJanitor` accepts asynchronously (worlds/janitor-events.ts), sent by `InvocationType: Event`. */
export interface JanitorInvoker {
  invoke(event: { readonly kind: "WORLD_CREATE" | "WORLD_RESET" | "MEMORY_PURGE"; readonly worldId: string; readonly requestId: string }): Promise<void>;
}

/** The Cognito accounts the nightly and hourly cleanups may delete (code fences what, IAM cannot). */
export interface GuestAccounts {
  /** Users whose name starts with `prefix` (`qa-`) or every user in `status` (`UNCONFIRMED`). */
  list(filter: { readonly usernamePrefix?: string; readonly status?: "UNCONFIRMED"; readonly sub?: string }): Promise<AccountSummary[]>;
  delete(username: string): Promise<void>;
}

export interface AccountSummary {
  readonly username: string;
  readonly status: string;
  readonly createdAt: Date;
  /** `custom:worldId` (immutable) when the account has one. */
  readonly worldId?: string;
}

/** Keys of a world's derived data: the chain HMAC key and the `PhoneHashKey` subkeys. */
export interface WorldKeys {
  /** `RegisterChainKey`: hash chains and the tape's `customerRef`. */
  readonly chainKey: string;
  /** `PhoneHashKey/phone-hash`. */
  readonly phoneHash: Uint8Array;
  /** `PhoneHashKey/email-hash`. */
  readonly emailHash: Uint8Array;
}

export interface WorldsDeps {
  /** Raw items the repositories do not model (tickets of the sign-up, the guest queue and its cap). */
  readonly store: TableStore;
  readonly connector: Connector;
  readonly templates: TemplateSource;
  readonly objects: WorldObjects;
  readonly schedules: ScheduleRemover;
  readonly memory: MemoryAdmin;
  readonly anchors: AnchorRequester;
  readonly invoker: JanitorInvoker;
  readonly keys: () => WorldKeys;
  readonly log: Logger;
  /** Real clock. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** A new ULID (tickets, audit ids). */
  readonly newId: () => string;
  readonly accounts?: GuestAccounts;
}

/** Time left in the invocation; work stops between blocks below `reserveMs` and continues elsewhere. */
export interface Budget {
  remainingMs(): number;
}

/** No deadline: `seed:load`, `console:invite` and tests run every block in one go. */
export const UNLIMITED: Budget = { remainingMs: () => Number.POSITIVE_INFINITY };

/** A Lambda stops two minutes before its 15 (docs/architecture.md §10: "13 de sus 15 minutos"). */
export const RESERVE_MS = 2 * 60_000;

export function outOfTime(budget: Budget): boolean {
  return budget.remainingMs() < RESERVE_MS;
}

/** The lease of a claimed ticket: longer than one invocation's work between heartbeats. */
export const LEASE_MS = 14 * 60_000;

export function leaseUntil(deps: Pick<WorldsDeps, "now">): string {
  return new Date(deps.now().getTime() + LEASE_MS).toISOString();
}
