// The `Connector` port: every read and write of the BFF tables, by use case, with every key under
// `W#<worldId>#` (docs/architecture.md §5). Tools, the worker, the gate, the console routers and the
// QA driver depend on this interface; `createConnector` builds it over a storage engine, DynamoDB in
// the stage (dynamo/connector.ts) and memory in local flows and tests (memory/connector.ts).
//
// Methods named `…Op` build an operation without running it, so a caller can commit several in one
// transaction with `transact` (a complaint transition with its register entry, a reset request with
// its tombstone, ticket and audit entry); the others run on their own.
import type { AuditRepo } from "./repos/audit";
import type { CapsRepo } from "./repos/caps";
import type { CaseItemsRepo } from "./repos/case-items";
import type { ChainsRepo } from "./repos/chains";
import type { ClaimsRepo } from "./repos/claims";
import type { ComplaintsRepo } from "./repos/complaints";
import type { ConversationsRepo } from "./repos/conversations";
import type { CountersRepo } from "./repos/counters";
import type { EmailsRepo } from "./repos/emails";
import type { MetricsRepo, ReferenceRepo } from "./repos/metrics";
import type { RuntimeRepo } from "./repos/runtime";
import type { ScansRepo } from "./repos/scans";
import type { SessionsRepo } from "./repos/sessions";
import type { TimersRepo } from "./repos/timers";
import type { WorldItemsRepo } from "./repos/world-items";
import type { WorldsRepo } from "./repos/worlds";
import type { WriteOp } from "./store";

export interface Connector {
  /** Worlds: `META`, `SETTINGS`, staff rows. */
  readonly worlds: WorldsRepo;
  /** Complaints: the complaint, its inbox position, conditional transitions, the written answer. */
  readonly complaints: ComplaintsRepo;
  /** Evidence, actions, approvals and executions, notes and human tasks of a complaint. */
  readonly caseItems: CaseItemsRepo;
  /** Register, refund register and compliance tape: put-only entries with a conditional head. */
  readonly chains: ChainsRepo;
  /** Audit log: put-only. */
  readonly audit: AuditRepo;
  readonly timers: TimersRepo;
  /** Conversation, messages, provider events, turn notes. */
  readonly conversations: ConversationsRepo;
  readonly emails: EmailsRepo;
  /** Clock, events in flight, pending emails and scans, tombstones, kill switch. */
  readonly runtime: RuntimeRepo;
  /** Epoch and complaint-number counters, reset and purge tickets. */
  readonly counters: CountersRepo;
  /** Idempotency and send claims, nonces, leases, live phones, simulated media, probes. */
  readonly claims: ClaimsRepo;
  /** The scan registry of `Media` objects. */
  readonly scans: ScansRepo;
  /** Turn sessions, turns and tool results. */
  readonly sessions: SessionsRepo;
  /** Abuse caps on the real clock and the identity challenge ledger. */
  readonly caps: CapsRepo;
  readonly metrics: MetricsRepo;
  readonly reference: ReferenceRepo;
  /** Raw items of one world for the factory and its wipe, never the protected ones. */
  readonly worldItems: WorldItemsRepo;
  /** Commits operations built by the repositories in one all-or-nothing transaction (≤ 100). */
  transact(ops: readonly WriteOp[]): Promise<void>;
  /** Runs one operation built by a repository; an update returns nothing here (use the repository's method). */
  write(op: WriteOp): Promise<void>;
}

export interface ConnectorOptions {
  /** Real clock for stamps and TTLs; business time never comes from here (ADR-0011). */
  readonly now?: () => Date;
}
