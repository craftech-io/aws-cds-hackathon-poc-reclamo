// How a finding of `PolicyAudit` is recorded: the `PolicyViolations` metric line first (so a failed
// write never hides it), then one `AuditLog VIOLATION` per finding. `AuditLog` is append-only and its
// sort key carries the instant, so "once" is enforced by reading the world's `VIOLATION` entries once
// per run (index `ByAction`) and skipping the keys already there. Nothing here carries a message body,
// an address or a customer id in clear: the refs are ids of this system.
import type { AuditEntry } from "../domain/ledger";
import { sha256Hex } from "../lib/crypto";
import { type AuditCheck, POLICY_VIOLATION_LOG, POLICY_VIOLATIONS_METRIC, type PolicyAuditDeps, VIOLATION_ACTION, type Violation } from "./types";

/** `VIOLATION` entries read per run (a world with more findings than this is already an incident). */
const KNOWN_LIMIT = 1_000;

export interface Finding {
  readonly check: AuditCheck;
  readonly key: string;
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly refs: Readonly<Record<string, string>>;
  /** Simulated instant of what was audited (the send, the imputation), when it has one. */
  readonly atSim?: string;
  /** `CMP#<id>` or `MSG#<id>`: the ref the `ByRef` index files the entry under. */
  readonly primaryRef?: string;
}

export interface ViolationRecorder {
  record(finding: Finding): Promise<Violation>;
}

function auditIdOf(worldId: string, epoch: number, key: string): string {
  return `aud-pv-${sha256Hex(`${worldId}#${epoch}#${key}`).slice(0, 32)}`;
}

/** The keys of the findings an earlier run of this world already recorded. */
async function knownKeys(deps: PolicyAuditDeps, worldId: string): Promise<Set<string>> {
  const entries: AuditEntry[] = await deps.connector.audit.listByAction(worldId, VIOLATION_ACTION, KNOWN_LIMIT);
  return new Set(entries.map((entry) => entry.refs["violationKey"]).filter((key): key is string => key !== undefined));
}

/** A recorder for one world and epoch; the same finding twice in a run is recorded once. */
export async function violationRecorder(deps: PolicyAuditDeps, worldId: string, epoch: number): Promise<ViolationRecorder> {
  const known = await knownKeys(deps, worldId);
  return {
    async record(finding) {
      deps.log.error(POLICY_VIOLATION_LOG, { metric: POLICY_VIOLATIONS_METRIC, worldId, check: finding.check, reason: finding.reason, ruleIds: [...finding.ruleIds] });
      const violation = { worldId, check: finding.check, key: finding.key, ruleIds: finding.ruleIds, reason: finding.reason, refs: finding.refs };
      if (known.has(finding.key)) return { ...violation, recorded: false };
      known.add(finding.key);
      await deps.connector.audit.append({
        worldId,
        epoch,
        auditId: auditIdOf(worldId, epoch, finding.key),
        ts: deps.now().toISOString(),
        ...(finding.atSim === undefined ? {} : { atSim: finding.atSim }),
        action: VIOLATION_ACTION,
        actor: "SYSTEM",
        ruleIds: [...finding.ruleIds],
        refs: { ...finding.refs, check: finding.check, reason: finding.reason, violationKey: finding.key },
        ...(finding.primaryRef === undefined ? {} : { primaryRef: finding.primaryRef }),
        outcome: finding.check,
      });
      return { ...violation, recorded: true };
    },
  };
}
