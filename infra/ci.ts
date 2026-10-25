// CI deploy role, permissions boundary and IAM path of every role this app creates
// (docs/build-plan.md WP-02 and WP-03, ADR-0013, docs/architecture.md §1 and §14).
//
// The deploy role is the one resource that must exist before the first `sst deploy`: GitHub
// Actions assumes it through OIDC (.github/workflows/deploy.yml) to deploy `poc`, so SST cannot
// create it. It is born from infra/bootstrap/ci-role.yaml, a CloudFormation template the operator
// applies once per account (docs/architecture.md §15 step 2). That template also creates the
// permissions boundary `<app>-ci-boundary` and the `qa-runner` role of the scenario runner.
//
// This module creates nothing. It pins the names both sides share and makes SST put every
// `aws.iam.Role` and `aws.iam.Policy` of the app
//
//   - under the IAM path `/<app>/`: the demos account is shared with other projects, and the path
//     is what fences IAM for the deploy role (create, edit, pass and delete only under it). A path
//     is part of the ARN and cannot be changed or forged after creation, unlike a tag;
//   - behind the permissions boundary: the deploy role may only `iam:CreateRole` with it, and may
//     only edit the policies of a role that still carries it. The boundary limits every role to
//     resources of this app (tag `sst:app`, or name where tags cannot fence), one region, no IAM
//     management and no role assumption, whatever policy a commit attaches to it.
//
// `$transform` reaches only resources constructed after it is registered, so sst.config.ts imports
// this module right after tags and before any module that creates a role. A module must never set
// its own `path` or `permissionsBoundary`: the deploy role would be denied the creation.
//
// Trust of the deploy role: `sub` of a push to the deploy branch, in the two shapes GitHub emits
// (by name, and `repo:<org>@<orgId>/<repo>@<repoId>:...` for repositories created after
// 2026-07-15), always together with the numeric `repository_id` and `repository_owner_id` claims
// and the `job_workflow_ref` of deploy.yml on main. The deploy job declares no `environment:` on
// purpose: GitHub would then emit `sub = repo:<org>/<repo>:environment:<name>` and the trust by
// branch would not match. Never loosen the trust with a wildcard in `sub`.
//
// The GitHub OIDC provider (token.actions.githubusercontent.com) is account-wide, one per URL, and
// already exists in the demos account shared by other projects: the app references it and the
// deploy role is denied creating, changing or deleting it.
//
// CloudFront parts cannot be tagged, so the deploy role is fenced to them by name or by ARN
// (infra/ci-spec.ts): this module also names every CloudFront function `<app>-<stage>-<logical>`.
//
// Verify: `aws --profile craftech-demos iam get-role --role-name <CI_DEPLOY_ROLE_NAME>` ·
// `aws --profile craftech-demos iam get-policy --policy-arn <ciBoundaryArn>` ·
// `aws --profile craftech-demos iam list-roles --path-prefix /<app>/` lists every role of the app,
// each one with `PermissionsBoundary` · `aws --profile craftech-demos cloudfront list-functions`
// shows the functions of the app under `<app>-<stage>-`.

import { cloudFrontFunctionName } from "./ci-spec";

export { CI_DEPLOY_STAGE } from "./ci-spec";

export const CI_REPO = "craftech-io/aws-cds-hackathon-poc-reclamo";
export const CI_DEPLOY_BRANCH = "main";
export const CI_OIDC_PROVIDER_HOST = "token.actions.githubusercontent.com";

/** `sub` claim by name. The id-bearing shape needs the numeric ids the operator passes to the template. */
export const CI_DEPLOY_SUB = `repo:${CI_REPO}:ref:refs/heads/${CI_DEPLOY_BRANCH}`;

// Same fixed names as infra/bootstrap/ci-role.yaml (RoleName, ManagedPolicyName, output AppIamPath).
export const CI_DEPLOY_ROLE_NAME = `${$app.name}-github-deploy`;
export const QA_RUNNER_ROLE_NAME = `${$app.name}-qa-runner`;
export const CI_BOUNDARY_POLICY_NAME = `${$app.name}-ci-boundary`;
export const CI_IAM_PATH = `/${$app.name}/`;

const caller = aws.getCallerIdentityOutput({});

export const ciDeployRoleArn = $interpolate`arn:aws:iam::${caller.accountId}:role/${CI_DEPLOY_ROLE_NAME}`;
export const qaRunnerRoleArn = $interpolate`arn:aws:iam::${caller.accountId}:role/${QA_RUNNER_ROLE_NAME}`;
export const ciBoundaryArn = $interpolate`arn:aws:iam::${caller.accountId}:policy/${CI_BOUNDARY_POLICY_NAME}`;
export const ciOidcProviderArn = $interpolate`arn:aws:iam::${caller.accountId}:oidc-provider/${CI_OIDC_PROVIDER_HOST}`;

// Every role of the app (Lambda execution roles created by sst.aws.Function, the AgentCore
// execution and Gateway roles, the Scheduler invocation role, the GuardDuty malware scan role). If
// the bootstrap was not applied, the first role creation fails with NoSuchEntity on the policy ARN:
// apply infra/bootstrap/ci-role.yaml.
$transform(aws.iam.Role, (args) => {
  args.path ??= CI_IAM_PATH;
  args.permissionsBoundary ??= ciBoundaryArn;
});

// Customer managed policies, if a module ever needs one: same path, so the deploy role can manage
// them and attach them (it can attach nothing else besides the Lambda execution policies of AWS).
$transform(aws.iam.Policy, (args) => {
  args.path ??= CI_IAM_PATH;
});

// CloudFront functions (the viewer-request function of the Router): the deploy role may update,
// publish and delete only `function/<app>-poc-*`. Assigned unconditionally: SST's own naming runs
// first and would leave a truncated app name plus a random suffix. A name only changes on creation
// (SST ignores later changes to it), so no deployed function is ever renamed.
$transform(aws.cloudfront.Function, (args, _opts, name) => {
  args.name = cloudFrontFunctionName($app.name, $app.stage, name);
});
