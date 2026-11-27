// The one retention of the app's logs (docs/architecture.md §12): 14 days, so whoever investigates an
// incident later reads what happened without guessing. Every Lambda's group takes it through the
// $transform of sst.config.ts (SST's `"2 weeks"` = 14 days), the Harness runtime groups take the days
// (infra/agentcore.ts and the manual configuration of docs/architecture.md §17 item 9). The one group
// with a longer life on purpose is the register's anchors (180 days, infra/storage-keys.ts
// ANCHOR_RETENTION_DAYS): the audit evidence of ADR-0014, kept apart from this number.
export const LOG_RETENTION_DAYS = 14;
export const LOG_RETENTION = "2 weeks";
