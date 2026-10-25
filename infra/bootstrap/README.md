# CI bootstrap

`ci-role.yaml` creates the only infrastructure that must exist before the first `sst deploy`
(ADR-0013, ADR-0009, `docs/architecture.md` §15 step 2):

- Permissions boundary `<app>-ci-boundary`, stamped on every role of the app by `infra/ci.ts`.
  Whatever policy a commit attaches, a role reaches only this app, one region, no IAM management
  and no role assumption; it can never rewrite the append-only tables or the register anchors.
- Deploy role `<app>-github-deploy`, assumed by `.github/workflows/deploy.yml` on `main`, with the
  managed policies `<app>-ci-deploy-{sst-home,app-resources,named,edge,dns-and-iam}`.
- Role `<app>-qa-runner`, assumed by `deploy.yml` (smoke) and `scenarios.yml` (full suite) on
  `main`: it can only invoke `function:<app>-poc-qa-driver`, read the app's logs and metrics and
  simulate the app's roles (append-only proof of `SC-18`).
- Key-value store `<app>-poc-router`, the routing table of the Router (`infra/web.ts`).
- Response headers policy `<app>-poc-console` (CSP, HSTS, `X-Frame-Options DENY`, nosniff,
  referrer), which the deploy role cannot change.
- Optionally the GitHub OIDC provider, only for an account that has none.

Explanations live here, not in the template: CloudFormation accepts 51,200 bytes inline and IAM
6,144 characters per managed policy (`ci-role.test.ts` checks both, plus every fixed name of
`docs/architecture.md` §1 against a statement with its exact ARN).

## Email is outbound only

Another app of the shared account owns the single active SES receipt rule set of `us-east-1`
(ADR-0003). This app never receives email, so the template has **no** statement that allows a
receipt rule, a receipt rule set, a receipt filter, a custom MAIL FROM, a Mail Manager ingress or
an `MX` record, and it **denies** all of them explicitly: in the deploy role
(`DenySesReceivingAndMailFrom`, `DenyMxRecords`) and in the boundary of every role the app creates
(`DenySesReceivingIngressAndMailFrom`), so a wildcard such as `ses:*` never reaches them. The IAM
prefix of SES v2 is `ses:`; an action spelled `sesv2:` grants and denies nothing, and
`ci-role.test.ts` rejects it. `npm run lint:no-ses-receiving` fails the pipeline before a deploy if
the infra code ever declares one of those resources, or if a role's policy set reaches one of those
actions (by name, wildcard or `NotAction`) without an unconditional `Deny` that covers it.

## How every statement is fenced

```text
The demos account is SHARED with other projects, so every statement is scoped to this app:

  tag    aws:ResourceTag/sst:app = <app>, stamped by the provider default tags (sst.config.ts)
         and by infra/tags.ts on awsnative.*. Used wherever the service authorizes by tag
         (Lambda, SQS, SNS, EventBridge, Scheduler, Cognito, SES, Bedrock, AgentCore, GuardDuty…).
  name   ARN prefix where the physical name keeps the app name whole (DynamoDB, SNS, SQS, the
         schedule group, the budget, CloudFront functions), where tags cannot be used (S3, by
         BucketPrefix) or are not there yet (reads before and right after a create).
  path   every IAM role and policy of the app lives under /<app>/ (infra/ci.ts). The path is part
         of the ARN and cannot be forged with a tag, so it fences IAM.
  ARN    fixed names: the WhatsApp topic <app>-wa-inbound, the budget topic <app>-budget-alerts,
         the configuration set <app>-email-poc, the QA driver <app>-poc-qa-driver, the schedule
         group <app>-poc-schedules, the anchor log group /<app>/poc/register-anchors, the roles
         <app>-poc-anchor-writer, <app>-poc-qa-driver and <app>-poc-malware-plan, the buckets
         <app>-poc-{media,documents,emails}-<account>, the Router key-value store and cache policy.
  DNS    only records named reclamo.demo.craftech.io or *.reclamo.demo.craftech.io (with a Null
         guard, so a request without names never passes an empty ForAllValues), only of type A,
         AAAA, CNAME or TXT, and never MX.
```

What each group of statements is for:

| Statement | Why |
|---|---|
| `TaggedAppResources` / `CreateTaggedAsThisApp` | Everything after creation only on resources tagged as the app; creation only when the request tags the new resource as the app |
| `NamedAppResources` | DynamoDB tables `<app>-*` and buckets `<BucketPrefix>*` (S3 cannot be conditioned on tags); the three browser buckets carry the whole app name, inside the prefix |
| `TopicsAndQueuesOfThisApp`, `SchedulerGroupsOfThisApp` | The provider reads a named topic, queue or group before IAM can see its tags |
| `ProjectBudget` / `DenyBudgetsOfOtherProjects` | The monthly budget `<app>-*` of `docs/architecture.md` §12, and no other budget of the account |
| `DenyPublicFunctionUrlsBesidesTheEdge` | A Function URL with `AuthType NONE` only on `Bff`; the mocks and every other function keep `AWS_IAM` |
| `DenySesReceivingAndMailFrom`, `DenyMxRecords`, `DenySesReceivingIngressAndMailFrom` (boundary) | Email outbound only (above) |
| `MalwarePlanOfThisApp`, `PassMalwarePlanRole`, `DenyPassingMalwarePlanRoleElsewhere` | GuardDuty Malware Protection for S3 over `Media`: the plan only tagged as the app, and its fixed-name service role passed only to `malware-protection-plan.guardduty.amazonaws.com` |
| `GuardDutyMalwareScanRule`, `GuardDutyMalwareScanRuleReads` (boundary) | The managed EventBridge rule the plan's role handles, split as in the AWS template `malware-protection-s3-iam-policy-prerequisite`: writes only with `events:ManagedBy`; `DescribeRule` and `ListTargetsByRule` without it, because those two actions do not support that key and a `StringEquals` on an absent key would deny them (the plan would leave `ACTIVE`) |
| `GuardDutyMalwareScanMedia`, `GuardDutyMalwareValidationObject` (boundary) | The S3 actions of the plan's role over `Media`, and `s3:PutObject` only on the validation object (without it the plan stays in `WARNING INSUFFICIENT_TEST_OBJECT_PERMISSIONS`) |
| `DenyRewritingAppendOnlyTables` (boundary) | No role of the app can `UpdateItem`, `DeleteItem` or `BatchWriteItem` on `Register`, `ComplianceTape` or `AuditLog` (ADR-0014). An overwrite with `PutItem` cannot be denied by IAM: it is detected by the hash chain and its anchors |
| `DenyRemovingAnchors`, `DenyAnchorWritesBesidesTheAnchorWriter` (boundary) | The anchor log group cannot be deleted or have its retention changed, and only the roles of `AnchorWriter` and `QaDriver` may write to it (`role/*<name>` matches `aws:PrincipalArn` with and without the IAM path) |
| `WhatsAppOfThisAccount` (boundary) | End User Messaging Social sends only from phone numbers of this account |
| `HarnessUnderlyingRuntime` | The runtime AgentCore creates under the Harness, named `harness_<AgentNamePrefix>*` |
| `CloudControlTransport` | `awsnative.*` resources go through the Cloud Control API, IAM prefix `cloudformation` |
| Edge policy | CloudFront functions `<app>-poc-*`, the bootstrap key-value store and the declared cache policy only |
| `WebAclsOfThisApp` (edge policy) | The two web ACLs of the guest self-signup, by their fixed names `<app>-poc-edge` (`CLOUDFRONT`, created and associated by the Router through its distribution's `WebACLId`: `cloudfront:UpdateDistribution` behind the tag plus `wafv2:GetWebACL`, nothing else) and `<app>-poc-auth` (`REGIONAL`, on the user pool) |
| `WafManagedRuleSetReferences` | `CreateWebACL`/`UpdateWebACL` also authorize the rule sets a rule references: the IP reputation and anonymous IP lists are AWS managed rule sets owned by AWS |
| `WafListWebAcls` | `wafv2:ListWebACLs` has no resource-level permission; it returns names and ids, no rules |
| `CognitoWebAclAssociation` | WAF authorizes an association on the web ACL **and** on the protected resource: the `auth` ACL and the user pools of the account; the pool's own side (`cognito-idp:AssociateWebACL`…) stays behind the `sst:app` tag of `TaggedAppResources`, like the `GuestSignupClient` and its generated secret |
| `DenyDeletingTables` (boundary) | No role of the app deletes a table; `Leads` included (contact data, `docs/architecture-guests.md` §10) |
| `SimulateAppRoles`, `ReadAppMetrics` (qa-runner) | `iam:SimulatePrincipalPolicy` only on roles under `/<app>/`; `cloudwatch:GetMetricData` has no resource-level permission (namespace `ReclamoAgent` is chosen in code) |

## Apply

Once per account, operator present, never from CI. First the read-only pre-checks of step 0
(SES in production, OIDC provider, SST bootstrap, model, cost tag). Nothing here lists or
describes a resource of another app:

```bash
aws --profile craftech-demos sesv2 get-account
aws --profile craftech-demos iam list-open-id-connect-providers
aws --profile craftech-demos ssm get-parameter --name /sst/bootstrap --query Parameter.Name
```

Then the repository ids (`gh api orgs/craftech-io --jq .id` → 60447213 and
`gh api repos/craftech-io/aws-cds-hackathon-poc-reclamo --jq .id`) and the stack. Pass
`CreateOidcProvider=true` only when `token.actions.githubusercontent.com` is not listed.

```bash
aws --profile craftech-demos cloudformation deploy \
  --stack-name aws-cds-hackathon-poc-reclamo-ci-bootstrap \
  --template-file infra/bootstrap/ci-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides CreateOidcProvider=false GitHubOrgId=60447213 GitHubRepoId=<id> \
  --tags Project=aws-cds-hackathon-poc-reclamo ManagedBy=cloudformation Owner=craftech
```

The same command applies every later change. Edit statements, not the `Description` of a managed
policy: IAM cannot change it in place and the replacement fails with `already exists`.

**Every change to `ci-role.yaml` is re-applied by the operator before the push that needs it.** The
deploy role cannot change its own policies (`DenyChangesToBootstrapResources`), so a merged template
that nobody applied makes the next `sst deploy` stop with `AccessDenied` halfway through the stage. To
re-apply keeping the current parameter values, read them first and pass the same ones:

```bash
aws --profile craftech-demos cloudformation describe-stacks   --stack-name aws-cds-hackathon-poc-reclamo-ci-bootstrap --query 'Stacks[0].Parameters'
aws --profile craftech-demos cloudformation deploy   --stack-name aws-cds-hackathon-poc-reclamo-ci-bootstrap   --template-file infra/bootstrap/ci-role.yaml   --capabilities CAPABILITY_NAMED_IAM   --parameter-overrides GitHubOrgId=<current> GitHubRepoId=<current> RouterCachePolicyId=<current>
aws --profile craftech-demos iam get-policy-version   --policy-arn arn:aws:iam::776805327629:policy/aws-cds-hackathon-poc-reclamo-ci-deploy-app-resources   --version-id "$(aws --profile craftech-demos iam get-policy --policy-arn arn:aws:iam::776805327629:policy/aws-cds-hackathon-poc-reclamo-ci-deploy-app-resources --query Policy.DefaultVersionId --output text)"
```

The last command shows the default version of the policy: after the apply it lists what the change
added (for the agent's wave 3, `bedrock:CreateInferenceProfile` for the application inference profile
of the agent model and `bedrock-agentcore:ListGateways` for `scripts/agent/push-gateway-schemas.ts`).

The SST bootstrap of the account and the stage passphrase are created by the operator's first
`npx sst secret set ... --stage poc` (step 3), never by CI.

## Guest self-signup (WP-53)

The template above carries the permissions of the self-signup (`docs/architecture-guests.md` §12):
apply it **before** the first deploy that contains `infra/waf.ts`, `infra/leads.ts` and the new
Cognito settings, or that deploy stops with `AccessDenied` on `wafv2:CreateWebACL`. Already covered
by the existing fences: the `Leads` table (`table/<app>-*`), the `<app>-auth-mail-alerts` topic
(`<app>-*`), the SES alarms (tag), the `GuestSignupClient` with its secret (tag of the pool), the
`edge-origin-key` entry of the Router store (`cloudfront-keyvaluestore:*` on that store only), the
service-linked role Cognito creates to send through SES (`IamServiceLinkedRoles`), and in the
boundary `LeadNotifier`'s `ses:SendEmail` (`SesSendAsThisApp`, narrowed in its own policy to
`no-reply@` and `*@craftech.io`).

Order of the operator, once, before pushing that deploy:

1. `npm run console:unverify-staff` and then `npm run console:unverify-staff -- --check` (no staff user
   with a verified email): the pool switches account recovery to `verified_email`, and only a
   self-signup guest may hold one.
2. `npx sst secret set LeadNotifyEmail not-configured --stage poc` and
   `npx sst secret set EdgeOriginKey "$(openssl rand -base64 32)" --stage poc` (a secret without a
   value aborts the deploy). The mailbox of the notices replaces `not-configured` when the operator
   loads the one the CTO chose; never in the code.
3. Re-apply this template (above).

**`Leads` is removed with the stage.** The table follows the stage's removal policy (`remove`) and has
no point-in-time recovery nor backups (a lead deleted on request must not survive in a copy), so an
`sst remove` loses every lead for good: run `npm run leads:export -- --all --out <path>.local.csv`
first, outside the repository or as `*.local.csv`.

## Verify

```bash
aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-reclamo-github-deploy
aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-reclamo-qa-runner
aws --profile craftech-demos iam get-policy --policy-arn arn:aws:iam::776805327629:policy/aws-cds-hackathon-poc-reclamo-ci-boundary
```

The deploy role must be denied on resources of another project of the shared account and on
every receiving action of SES:

```bash
aws --profile craftech-demos iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-reclamo-github-deploy \
  --action-names ses:CreateReceiptRule ses:SetActiveReceiptRuleSet ses:PutEmailIdentityMailFromAttributes \
  --resource-arns '*'
```

Repeat with `dynamodb:DeleteTable` on a table of another project, `cloudfront:UpdateFunction` on a
function ARN of another project and `budgets:ModifyBudget` on another budget.
`simulate-principal-policy` does not model every condition key, so a real deploy is the final
check.

## Residual risks

Stated instead of hidden.

- **Demo recipients.** `ses:Recipients` in the runtime policies lists the SES mailbox simulator and
  `@craftech.io`; the exact registered demo recipients of `SeedOverrides` (at most 5, only from the
  `demo` world) are fenced in code by the recipient fence of the SES client, not in IAM, because
  IAM values are never derived from a secret.
- **Public Function URL.** `Bff` answers on a Function URL with `AuthType NONE` behind the Router
  and authenticates every call with the Cognito id token. Its name is fenced by
  `DenyPublicFunctionUrlsBesidesTheEdge`.
- **Tag on create.** A service authorizes `TagResource` during a create call with the request tags
  only, which IAM cannot tell apart from tagging an existing untagged resource. A resource of
  another SST app carries its own `sst:app`, which the role cannot overwrite
  (`DenyRetaggingOtherApps`); an untagged resource of the listed services could be claimed.
  Closing that needs one account per project or an SCP.
- **Append-only by IAM, overwrite by detection.** IAM cannot require a `ConditionExpression`, so a
  role with `PutItem` could overwrite a register entry; the hash chain anchored outside the tables
  detects it (ADR-0014).
- **Account-wide actions** with no resource-level permissions (CloudFront creates,
  `sst-asset-*` objects, `ses:GetAccount`, `cloudwatch:GetMetricData`, listings), each justified
  next to its statement.
- A missing permission fails closed: the deploy stops with AccessDenied naming the action. The
  fix is a new statement with its justification, scoped by tag, name, IAM path or ARN, never a
  broader wildcard. Lessons of the first deploys of the scaffolding: `docs/architecture.md` §16.
