// What the `PolicyAudit` Lambda accepts (zod at the edge) and which worlds a run covers:
//
//   {worldId}                        on demand (`policyAudit.run` of the QA driver, an operator): that world
//   {kind: "DAILY"} or the scheduler  every world of the operator that exists: `demo`, `qamin`, `gtest` and
//   (`source aws.events/aws.scheduler`)  the invited guest worlds `g01`…`g99`; self-signup worlds (`gs-*`)
//                                    are audited on demand (they are listed only in `GuestIndex`)
//
// A world that fails is logged and reported; the other worlds still run. The daily run never covers
// QA scenario worlds (`qa-*`): each scenario runs its own audit before `world.destroy`.
import { runPolicyAudit } from "./audit";
import { OnDemand, PolicyAuditRequest } from "./request";
import type { PolicyAuditDeps, PolicyAuditReport } from "./types";


/** The worlds of the daily run, in order; one that does not exist is skipped. */
export const DAILY_WORLDS: readonly string[] = ["demo", "qamin", "gtest", ...Array.from({ length: 99 }, (_unused, index) => `g${String(index + 1).padStart(2, "0")}`)];

export interface WorldFailure {
  readonly worldId: string;
  readonly error: string;
}

export interface PolicyAuditRun {
  readonly reports: readonly PolicyAuditReport[];
  readonly failures: readonly WorldFailure[];
  readonly violations: number;
}

/** Parses the invocation and audits the worlds it names. */
export async function runRequestedAudit(deps: PolicyAuditDeps, raw: unknown): Promise<PolicyAuditRun> {
  const parsed = PolicyAuditRequest.safeParse(raw);
  if (!parsed.success) {
    deps.log.warn("policy_audit.invalid_request", {});
    return { reports: [], failures: [{ worldId: "-", error: "INVALID_REQUEST" }], violations: 0 };
  }
  const onDemand = OnDemand.safeParse(raw);
  const candidates = onDemand.success ? [onDemand.data.worldId] : DAILY_WORLDS;
  const reports: PolicyAuditReport[] = [];
  const failures: WorldFailure[] = [];
  for (const worldId of candidates) {
    if (candidates.length > 1 && (await deps.connector.worlds.getMeta(worldId)) === undefined) continue;
    try {
      reports.push(await runPolicyAudit(deps, { worldId }));
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      deps.log.error("policy_audit.world_failed", { worldId, errorName: name });
      failures.push({ worldId, error: name });
    }
  }
  return { reports, failures, violations: reports.reduce((sum, report) => sum + report.violations.length, 0) };
}
