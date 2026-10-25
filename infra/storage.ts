// Storage of the app (docs/architecture.md §5, §6 and §8.3): the DynamoDB tables
// (infra/storage-tables.ts), the buckets (infra/storage-buckets.ts) and the log group that anchors the
// hash chains of the register, the refund register and the compliance tape outside the tables.
//
// Access is never granted by a link. A module that creates a Function links what the handler reads
// by name (`Resource.Complaints.name`, `Resource.RegisterAnchors.name`) and adds, in `permissions`,
// exactly what its entry of infra/iam-capabilities.ts allows:
//
//   tableAccess("Complaints", "write", WORLD_LEADING_KEYS.Bff.write)   world-fenced read and write
//   tableAccess("Register", "append")                                  reads + PutItem only
//   bucketAccess("Media", "write", ["up/"])                            objects under a prefix
//   anchorAccess("read")                                               FilterLogEvents on the anchors
//
// Anchor log group: `/<app>/<stage>/register-anchors`, 180 days. Only `AnchorWriter` writes it (and
// the `QaDriver`, only in `qa-*` streams, for `register.tamperProbe`); the CI boundary denies every
// other role of the app `CreateLogStream` and `PutLogEvents` on it, and denies every role deleting it,
// deleting a stream or changing its retention (infra/bootstrap/ci-role.yaml). Streams are
// `<worldId>-e<epoch>-<chain>`, created by `AnchorWriter` (docs/architecture.md §8.3).
//
// Verify: `aws --profile craftech-demos logs describe-log-groups --log-group-name-prefix
// /aws-cds-hackathon-poc-reclamo/poc/register-anchors --query 'logGroups[].retentionInDays'` → [180].

import type { Access, AnchorAccess, BucketName, TableName } from "./iam-capabilities";
import { buckets } from "./storage-buckets";
import {
  ANCHOR_ACCESS,
  ANCHOR_RETENTION_DAYS,
  BUCKET_ACTIONS,
  TABLE_ACTIONS,
  anchorLogGroupName,
  leadingKeysConditions,
  tableHasIndexes,
  type IamCondition,
} from "./storage-keys";
import { tables } from "./storage-tables";

export { buckets, tables };

export const anchorLogGroup = new aws.cloudwatch.LogGroup("RegisterAnchorsLogGroup", {
  name: anchorLogGroupName($app.name, $app.stage),
  retentionInDays: ANCHOR_RETENTION_DAYS,
});

/** Name and ARN of the anchor log group for the handlers (`Resource.RegisterAnchors`); no permission. */
export const RegisterAnchors = new sst.Linkable("RegisterAnchors", {
  properties: { name: anchorLogGroup.name, arn: anchorLogGroup.arn },
});

/** One statement for the `permissions` of an `sst.aws.Function`. */
export interface StoragePermission {
  readonly actions: string[];
  readonly resources: $util.Input<string>[];
  readonly conditions?: IamCondition[];
}

/**
 * Access to several tables (and their indexes, if any) at one level and behind one fence, in a single
 * statement: a world-fenced role repeats its actions and its fence once, not once per table, so its
 * inline policy stays under IAM's 10,240 characters (infra/policy-size.ts).
 */
export function tablesAccess(names: readonly TableName[], access: Access, leadingKeys?: readonly string[]): StoragePermission {
  return {
    actions: [...TABLE_ACTIONS[access]],
    resources: names.flatMap((name) => {
      const { arn } = tables[name];
      return tableHasIndexes(name) ? [arn, $interpolate`${arn}/index/*`] : [arn];
    }),
    ...(leadingKeys === undefined ? {} : { conditions: leadingKeysConditions(leadingKeys) }),
  };
}

/** Access to a table and its indexes; `leadingKeys` fences a world-fenced role (docs/architecture.md §14). */
export function tableAccess(name: TableName, access: Access, leadingKeys?: readonly string[]): StoragePermission {
  return tablesAccess([name], access, leadingKeys);
}

/** Access to the objects of a bucket, the whole bucket by default or only under `prefixes`. */
export function bucketAccess(name: BucketName, access: Exclude<Access, "append">, prefixes: readonly string[] = [""]): StoragePermission {
  const { arn } = buckets[name];
  return { actions: [...BUCKET_ACTIONS[access]], resources: prefixes.map((prefix) => $interpolate`${arn}/${prefix}*`) };
}

/** Access to the anchor log group, as ANCHOR_ACCESS defines each kind. */
export function anchorAccess(access: AnchorAccess): StoragePermission[] {
  const { arn } = anchorLogGroup;
  return ANCHOR_ACCESS[access].map(({ actions, streams }) => ({
    actions: [...actions],
    resources: streams === undefined ? [arn, $interpolate`${arn}:*`] : [$interpolate`${arn}:log-stream:${streams}`],
  }));
}
