/// <reference path="../../sst-env.d.ts" />
// `PolicyAudit` (docs/architecture.md §12, FL-075): the Lambda the daily schedule and the QA driver's
// `policyAudit.run` invoke. Everything it reads comes through what SST links into it (never
// `process.env`): the tables, the anchor log group (`RegisterAnchors`, `FilterLogEvents`), the chain key
// (`RegisterChainKey`) and the core's Function URL (`CoreMock`) for the customer's dated consent and
// loans. A core that is not linked leaves those facts out (logged), never the audit. It writes only
// `AuditLog` and answers the run's reports (ids of this system, never a body or an address).
import { cloudWatchAnchorReader } from "../complaints/anchors";
import { dynamoConnector } from "../connector/dynamo/connector";
import { linkedCoreClient } from "../core/linked";
import { createLogger, type Logger } from "../lib/log";
import { keySecret } from "../lib/secrets";
import { coreCustomerReader } from "../outbound/directory";
import type { CustomerReader } from "../outbound/deps";
import { type PolicyAuditRun, runRequestedAudit } from "../policy-audit/run";
import type { PolicyAuditDeps } from "../policy-audit/types";

function customerReader(log: Logger): CustomerReader | undefined {
  try {
    return coreCustomerReader(linkedCoreClient());
  } catch {
    log.warn("policy_audit.core_not_linked", {});
    return undefined;
  }
}

let shared: Omit<PolicyAuditDeps, "log" | "customers"> | undefined;

function stageDeps(log: Logger): PolicyAuditDeps {
  shared ??= { connector: dynamoConnector(), chainKey: keySecret("RegisterChainKey"), anchors: cloudWatchAnchorReader(), now: () => new Date() };
  const customers = customerReader(log);
  return { ...shared, log, ...(customers === undefined ? {} : { customers }) };
}

/** Lambda entry: a storage failure of the whole run throws (the schedule's retry runs it again). */
export async function handler(event: unknown): Promise<PolicyAuditRun> {
  const log = createLogger({ bindings: { service: "policy-audit" } });
  return runRequestedAudit(stageDeps(log), event);
}
