// Contract of `PolicyAudit` (docs/architecture.md §12, FL-075): four checks over a world's epoch.
//
//   TAPE_ALLOWED         (a) every outbound message has an `ALLOWED` entry with its `messageId` and a
//                        `payloadHash`, the same hash on every `ALLOWED` of that message, written before
//                        each of its `DISPATCH` entries (a send that skipped the gate has none)
//   POLICY_REEVALUATION  (b) the channel policy, re-evaluated with the facts of that moment (dated
//                        opt-in and opt-out, control, window and counts), also allows it
//   FOREIGN_SETTLEMENT   (c) no imputation (an executed `APPLY_PAYMENT`, or a `MATCHED` reconciliation)
//                        rests on a settlement line whose `customerRef` is not the complaint's customer
//                        or whose `loanRef` is not one of that customer's loans
//   CHAIN_BROKEN         (d) the register, the refund register and the tape verify against their anchors;
//                        `partial` (entries without an anchor yet) is a `CHAIN_PARTIAL` warning, never a
//                        violation
//
// A violation logs the `PolicyViolations` metric line first and then writes one `AuditLog VIOLATION`,
// once per finding however often the audit runs. `ALLOWED` is written before the transport, so a timeout
// after SES accepted is never a violation.
import type { AnchorReader } from "../complaints/anchors";
import type { Connector } from "../connector/port";
import type { ChainKind } from "../domain/ledger";
import type { Logger } from "../lib/log";
import type { CustomerReader } from "../outbound/deps";

/** Metric of docs/architecture.md §12 and the log line its filter matches. */
export const POLICY_VIOLATIONS_METRIC = "PolicyViolations";
export const POLICY_VIOLATION_LOG = "policy_audit.violation";
/** `AuditLog` action of a finding (and what `metrics/` counts as a violation). */
export const VIOLATION_ACTION = "VIOLATION";

export type AuditCheck = "TAPE_ALLOWED" | "POLICY_REEVALUATION" | "FOREIGN_SETTLEMENT" | "CHAIN_BROKEN";

export interface Violation {
  readonly worldId: string;
  readonly check: AuditCheck;
  /** Stable key of the finding: the same message, imputation or chain break gives the same key. */
  readonly key: string;
  readonly ruleIds: readonly string[];
  /** Machine reason (`NO_ALLOWED`, `DISPATCH_BEFORE_ALLOWED`, `PAYER_NOT_CUSTOMER`, `HASH_MISMATCH`…). */
  readonly reason: string;
  readonly refs: Readonly<Record<string, string>>;
  /** False when an earlier run had already recorded it. */
  readonly recorded: boolean;
}

/** `CHAIN_PARTIAL`: a chain verifies but some `seq` has no anchor yet. */
export interface ChainWarning {
  readonly warning: "CHAIN_PARTIAL";
  readonly chain: ChainKind;
  readonly unanchored: readonly number[];
}

export interface ChainSummary {
  readonly chain: ChainKind;
  readonly result: "ok" | "partial" | "broken";
  readonly entries: number;
}

export interface PolicyAuditReport {
  readonly worldId: string;
  readonly epoch: number;
  readonly messagesChecked: number;
  readonly imputationsChecked: number;
  readonly chains: readonly ChainSummary[];
  readonly warnings: readonly ChainWarning[];
  /** Messages or complaints whose audit could not finish (logged; the run goes on). */
  readonly failed: number;
  readonly violations: readonly Violation[];
}

export interface PolicyAuditDeps {
  readonly connector: Connector;
  /** `RegisterChainKey`: recomputes the three chains. */
  readonly chainKey: string;
  readonly anchors: AnchorReader;
  /**
   * The core's view of a customer (consent with its instants, loans). Absent, the dated consent is not
   * rebuilt (`CH-OPTIN`/`CH-OPTOUT` are skipped as for any missing fact) and a settlement line's loan is
   * only checked against the complaint's own subject.
   */
  readonly customers?: CustomerReader;
  readonly log: Logger;
  /** Real clock: audit stamps only. */
  readonly now: () => Date;
}
