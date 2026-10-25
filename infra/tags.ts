// Mandatory tags for every AWS resource of this app (CLAUDE.md, "Convenciones").
//
// The `aws` provider applies them through `defaultTags` in sst.config.ts (its `app()` hook cannot
// import local modules, so the same keys are spelled out there as well). The `aws-native`
// provider has no default tags, so every `awsnative.*` resource passes them explicitly:
//
//   tags: tagList()   for schemas that take `Tag[]`  ({ key, value })
//   tags: tagMap()    for schemas that take a map     (e.g. AWS::BedrockAgentCore::*)
//
// `extra` adds resource-specific keys on top; the mandatory ones cannot be overridden.
//
// `sst:app` and `sst:stage` are the tags SST itself puts on every `aws.*` resource. They are part
// of the map because IAM scopes the CI deploy role and the permissions boundary of every role of
// the app by `aws:ResourceTag/sst:app` (infra/bootstrap/ci-role.yaml): an `awsnative.*` resource
// without them could be created by CI but never updated, read or deleted afterwards.

export const PROJECT = "aws-cds-hackathon-poc-reclamo";
export const OWNER = "craftech";
export const MANAGED_BY = "sst";

export const SST_APP_TAG = "sst:app";
export const SST_STAGE_TAG = "sst:stage";

export const MANDATORY_TAG_KEYS = ["Project", "Stage", "ManagedBy", "Owner", SST_APP_TAG, SST_STAGE_TAG] as const;
export type MandatoryTagKey = (typeof MANDATORY_TAG_KEYS)[number];

export type TagMap = Record<MandatoryTagKey, string> & Record<string, string>;
export type TagList = Array<{ key: string; value: string }>;

export function tagMap(extra: Record<string, string> = {}): TagMap {
  return {
    ...extra,
    Project: PROJECT,
    Stage: $app.stage,
    ManagedBy: MANAGED_BY,
    Owner: OWNER,
    [SST_APP_TAG]: $app.name,
    [SST_STAGE_TAG]: $app.stage,
  };
}

export function tagList(extra: Record<string, string> = {}): TagList {
  return Object.entries(tagMap(extra)).map(([key, value]) => ({ key, value }));
}
