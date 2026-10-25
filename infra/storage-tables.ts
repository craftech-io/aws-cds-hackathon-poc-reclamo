// One DynamoDB table per aggregate (docs/architecture.md §5), built from infra/storage-keys.ts: string
// `pk` and `sk`, the GSIs of the document (`WorldIndex` and the `Leads` indexes keys only), TTL on
// `expiresAt` everywhere but `Reference`, on-demand billing and point-in-time recovery (SST defaults)
// except on `Leads`, AWS-owned encryption.
//
// Names: SST names each table `<app>-<stage>-<Logical>Table-<random>`, inside the `table/<app>-*`
// fence of the CI deploy role and of the permissions boundary; the boundary also denies
// `UpdateItem`, `DeleteItem` and `BatchWriteItem` on every `*Register*`, `*ComplianceTape*` and
// `*AuditLog*` table, whatever a role's policy says (ADR-0014).
//
// Links carry only the name and the ARN (`Resource.<Table>.name`): SST's default link would grant
// `dynamodb:*` on the table and its indexes, which no fence could narrow afterwards. Every function
// gets its access from infra/storage.ts (`tableAccess`), sized by infra/iam-capabilities.ts.
//
// Verify: `aws --profile craftech-demos dynamodb describe-table --table-name <name>` (GSIs, keys) ·
// `aws --profile craftech-demos dynamodb describe-time-to-live --table-name <name>` (`expiresAt`).

import type { TableName } from "./iam-capabilities";
import { TABLES, TABLE_NAMES, type TableSpec, dynamoArgs } from "./storage-keys";

// Registered before the first table exists: SST reads the link of a component right after creating it.
sst.Linkable.wrap(sst.aws.Dynamo, (table) => ({ properties: { name: table.name, arn: table.arn } }));

// A table without backups (`Leads`) turns point-in-time recovery off: a deletion on request must
// not survive in a copy (docs/architecture-guests.md §10).
function tableOf(name: TableName): sst.aws.Dynamo {
  const spec: TableSpec = TABLES[name];
  const withoutBackups = spec.backups === false ? { transform: { table: (args: aws.dynamodb.TableArgs) => void (args.pointInTimeRecovery = { enabled: false }) } } : {};
  return new sst.aws.Dynamo(name, { ...dynamoArgs(spec), ...withoutBackups });
}

export const tables = Object.fromEntries(TABLE_NAMES.map((name) => [name, tableOf(name)])) as Record<TableName, sst.aws.Dynamo>;

// One named export per table as well, for modules that resolve a table late (infra/late-links.ts).
export const { Worlds, Core, Networks, Complaints, Register, Timers, Conversations, ComplianceTape, AuditLog, Reference, Runtime, Metrics, Leads } = tables;
