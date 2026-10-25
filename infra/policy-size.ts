// Size of the inline policy SST writes on a Lambda's role. `sst.aws.Function` puts every statement of
// `permissions` and of the linked `include`s into ONE inline policy named "inline"
// (.sst/platform/src/components/aws/function.ts, `createRole`), rendered by `aws.iam.getPolicyDocument`.
// IAM caps the inline policies of a role at 10,240 characters, white space not counted: a role over
// it fails the deploy with `LimitExceeded` and stops the whole stage.
//
// infra/workers-spec.test.ts renders every Lambda's full statement list (data, links, pipeline, mocks,
// queues) with ARNs of their real length and keeps each one under `POLICY_SIZE_BUDGET`, which leaves
// room for the late links (TIMERS, Harness) the WP-31 modules add later. Pure: no SST or Pulumi.

import type { IamCondition } from "./storage-keys";

/** IAM's limit for the inline policies of one role, in characters without white space. */
export const IAM_INLINE_POLICY_LIMIT = 10_240;
/** What a role of the app may use today: the rest is headroom for the late links. */
export const POLICY_SIZE_BUDGET = 9_000;

export interface RenderedStatement {
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly conditions?: readonly IamCondition[];
}

/** `["a"]` renders as `"a"`, as the policy document does. */
const oneOrMany = (values: readonly string[]): string | string[] => (values.length === 1 ? (values[0] ?? "") : [...values]);

/** The policy document `aws.iam.getPolicyDocument` writes (an empty `Sid` per statement included). */
export function inlinePolicyDocument(statements: readonly RenderedStatement[]): unknown {
  return {
    Version: "2012-10-17",
    Statement: statements.map((statement) => {
      const condition: Record<string, Record<string, string | string[]>> = {};
      for (const { test, variable, values } of statement.conditions ?? []) (condition[test] ??= {})[variable] = oneOrMany(values);
      return {
        Sid: "",
        Effect: "Allow",
        Action: oneOrMany(statement.actions),
        Resource: oneOrMany(statement.resources),
        ...(statement.conditions && statement.conditions.length > 0 ? { Condition: condition } : {}),
      };
    }),
  };
}

/** Characters IAM counts for the policy (JSON without white space). */
export function inlinePolicySize(statements: readonly RenderedStatement[]): number {
  return JSON.stringify(inlinePolicyDocument(statements)).length;
}

// ---- ARNs of their real length (for the estimate) ---------------------------------------------------

export interface ArnPlace {
  readonly app: string;
  readonly stage: string;
  readonly region: string;
  readonly account: string;
}

/** SST names a table `<app>-<stage>-<Logical>Table-<random 8>`. */
export function estimatedTableArn(place: ArnPlace, table: string): string {
  return `arn:aws:dynamodb:${place.region}:${place.account}:table/${place.app}-${place.stage}-${table}Table-xxxxxxxx`;
}

/** A bucket name is at most 63 characters: the estimate takes the longest. */
export function estimatedBucketArn(): string {
  return `arn:aws:s3:::${"x".repeat(63)}`;
}

/** A function name is at most 64 characters: the estimate takes the longest. */
export function estimatedFunctionArn(place: ArnPlace): string {
  return `arn:aws:lambda:${place.region}:${place.account}:function:${"x".repeat(64)}`;
}

export function estimatedQueueArn(place: ArnPlace, physicalName: string): string {
  return `arn:aws:sqs:${place.region}:${place.account}:${physicalName}`;
}

export function estimatedLogGroupArn(place: ArnPlace, name: string): string {
  return `arn:aws:logs:${place.region}:${place.account}:log-group:${name}`;
}

/** Any other ARN the estimate does not know the shape of (a guardrail, a schedule group, a runtime). */
export function estimatedOtherArn(place: ArnPlace): string {
  return `arn:aws:bedrock-agentcore:${place.region}:${place.account}:runtime/${place.app}-${place.stage}-${"x".repeat(24)}`;
}
